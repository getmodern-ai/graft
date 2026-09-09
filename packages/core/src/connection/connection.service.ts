import type { ConnectionRow } from "@graft/db/repo/connection";
import type { ConnectionScheme } from "@graft/db/schema/connection";
import type { ProxyConnection } from "@graft/proxy";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { Principal } from "../tenancy";
import type { ConnectionDeps } from "./connection.deps";
import {
  type HostSetRefusal,
  validateCredentialFields,
  validateDisplayName,
  validateHostSet,
  validateIssuedCredentialFields,
  validateSchemeConfig,
  validateVendor,
} from "./connection.rules";
import {
  isOAuthAuthorizationCode,
  type OAuthPublicState,
  type OAuthState,
  oauthPublicState,
  readOAuthState,
} from "./oauth.rules";
import {
  buildAuthorizeUrl,
  generatePkce,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
  signOAuthState,
} from "./oauth-consent";

/**
 * Connections (CONTEXT.md; ADR 0007, ADR 0010): register, enter or re-enter the credential, revoke,
 * list. The credential is written through the vault's encrypt half and read back by nothing here:
 * the row's public shape carries `credentialSetAt` alone, and `toProxyConnection` is the one
 * function that hands the ciphertext on — to the proxy's binding in `apps/server`, which decrypts.
 *
 * An authorization-code connection (ADR 0005) adds four moments, each a function below: the consent
 * **starts** (a PKCE verifier written, a signed authorize URL returned), **completes** (the tokens the
 * callback exchanged the code for written beside the client secret, as one record), the proxy
 * **refreshes** the token and hands the rotated record back, or a refresh is **refused** and the
 * connection is marked for re-consent. The tokens take the credential's path — encrypted, write-only
 * — and the non-secret state beside them is what the console reads (`oauth.rules.ts`).
 */

/** The row as the wire sees it: never a ciphertext, never a token, never the PKCE verifier. */
export type ConnectionOutput = {
  id: string;
  vendor: string;
  displayName: string;
  scheme: ConnectionScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: string[];
  /** Whether a credential is set, and since when — the one thing said about it. */
  credentialSetAt: Date | null;
  /** Where the consent stands, for an authorization-code connection; null for every other scheme. */
  oauth: OAuthPublicState | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toConnectionOutput(row: ConnectionRow): ConnectionOutput {
  return {
    id: row.id,
    vendor: row.vendor,
    displayName: row.displayName,
    scheme: row.scheme,
    schemeConfig: row.schemeConfig,
    primaryHost: row.primaryHost,
    hosts: row.hosts,
    credentialSetAt: row.credentialSetAt,
    oauth: isOAuthAuthorizationCode(row.scheme)
      ? oauthPublicState(readOAuthState(row.oauthRefreshState))
      : null,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Whether a vendor call through this connection can succeed today: not revoked, a credential
 * entered, and — for an authorization-code connection — the consent completed and not since refused.
 * What `request_connection` reads before saying "already connected", and the console's "connected".
 */
export function isConnectionUsable(connection: ConnectionOutput): boolean {
  if (connection.revokedAt !== null || connection.credentialSetAt === null) return false;
  return connection.oauth === null || connection.oauth.status === "connected";
}

/**
 * The proxy's view of a row: the identity it compares against the token and the columns that decide
 * where and how the credential goes. Built field by field, so a column added to the table later does
 * not ride into the proxy by accident. A revoked connection has a null ciphertext and the proxy
 * answers `connection_not_ready` for it; nothing else about the row has to say "revoked".
 */
export function toProxyConnection(row: ConnectionRow): ProxyConnection {
  return {
    id: row.id,
    personId: row.personId,
    authScheme: row.scheme,
    primaryHost: row.primaryHost,
    hosts: row.hosts,
    schemeConfig: row.schemeConfig,
    credentialCiphertext: row.credentialCiphertext,
  };
}

export type RegisterConnectionInput = {
  vendor: string;
  displayName: string;
  scheme: ConnectionScheme;
  /**
   * The scheme's non-secret parameters — for an authorization-code connection the client id the
   * person registered, the two endpoints and the scopes (ADR 0005), like every other scheme's.
   */
  schemeConfig?: Record<string, unknown>;
  primaryHost: string;
  hosts?: readonly string[];
};

/** A refused rule is a 400 with the rule's own sentence. */
function refuse(problem: string | null): void {
  if (problem) throw new ServiceError("BAD_REQUEST", problem);
}

/**
 * A refused host set is a 400 carrying the rule's reason word in `details` — `host_not_public` is
 * what the console form and the meta-tool show beside the sentence (GRA-28), so the same refusal
 * reads the same at every one of the three places the rule is applied.
 */
function refuseHostSet(verdict: HostSetRefusal): never {
  throw new ServiceError("BAD_REQUEST", verdict.problem, {
    details: { reason: verdict.reason, ...(verdict.host ? { host: verdict.host } : {}) },
  });
}

/** The checks every registration passes, in the order a person would fix them; the normalised values out. */
function validateRegistration(input: RegisterConnectionInput) {
  refuse(validateVendor(input.vendor));
  refuse(validateDisplayName(input.displayName));
  const schemeConfig = input.schemeConfig ?? {};
  refuse(validateSchemeConfig(input.scheme, schemeConfig));
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) refuseHostSet(hostSet);
  return { schemeConfig, hostSet };
}

/**
 * Register a connection: vendor, name, scheme and its non-secret parameters, the host set with one
 * primary — every host public (`@graft/proxy`'s address rule, applied again at resolution). No
 * credential yet: that is `setConnectionCredential`'s, so the row exists to be pointed at by a
 * handoff before anything secret is typed (ADR 0006).
 */
export async function registerConnection(
  ctx: ServiceContext,
  principal: Principal,
  input: RegisterConnectionInput,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const { schemeConfig, hostSet } = validateRegistration(input);

  const row = await deps.insertConnection(ctx.db, {
    id: deps.newId(),
    personId: principal.personId,
    vendor: input.vendor,
    displayName: input.displayName.trim(),
    scheme: input.scheme,
    schemeConfig: schemeConfig as Record<string, string>,
    primaryHost: hostSet.primaryHost,
    hosts: hostSet.hosts,
  });
  return toConnectionOutput(row);
}

export type RegisterConnectionWithCredentialInput = RegisterConnectionInput & {
  /** The scheme's secret fields, entered in the console; they reach the vault and nothing else. */
  credential: Record<string, unknown>;
};

/**
 * Register a connection and enter its credential in one transaction — what the console's form
 * submits, for a connection an agent proposed and for one the person adds themselves (GRA-28). Both
 * halves are validated before anything is written, so a mistyped secret field leaves no half-made
 * row behind, and the row never exists without its credential: nothing between the two writes can
 * observe a connection that is registered and not yet usable.
 */
export async function registerConnectionWithCredential(
  ctx: ServiceContext,
  principal: Principal,
  input: RegisterConnectionWithCredentialInput,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const { credential, ...registration } = input;
  validateRegistration(registration);
  refuse(validateCredentialFields(registration.scheme, credential));
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const registered = await registerConnection(scoped, principal, registration, deps);
    return setConnectionCredential(scoped, principal, registered.id, credential, deps);
  });
}

export async function listConnections(
  ctx: ServiceContext,
  principal: Principal,
  deps: ConnectionDeps,
): Promise<ConnectionOutput[]> {
  const rows = await deps.listConnections(ctx.db, principal.personId);
  return rows.map(toConnectionOutput);
}

export async function getConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<ConnectionOutput | null> {
  const row = await deps.findConnection(ctx.db, principal.personId, connectionId);
  return row ? toConnectionOutput(row) : null;
}

/**
 * Enter, or re-enter, the credential. The fields are checked against the scheme's table, encrypted
 * under this row's person and connection id, and written as ciphertext; the fields themselves
 * reach the vault and nothing else, and the answer carries `credentialSetAt` and no more (GRA-6's
 * acceptance criterion). A re-entry after a revoke is the reconnection ADR 0007 describes — the
 * repo clears `revoked_at` in the same statement.
 *
 * For an authorization-code connection what is entered is the client secret alone, so the record
 * written here holds no token and the consent state is reset with it: the person consents next,
 * from the authorize URL `startOAuthConsent` builds (ADR 0005).
 */
export async function setConnectionCredential(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  fields: Record<string, unknown>,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  refuse(validateCredentialFields(row.scheme, fields));
  const ciphertext = await deps.vault.encrypt(fields as Record<string, string>, {
    personId: principal.personId,
    connectionId: row.id,
  });
  const updated = orNotFound(
    await deps.setConnectionCredential(ctx.db, principal.personId, row.id, {
      ciphertext,
      setAt: deps.now(),
      ...(isOAuthAuthorizationCode(row.scheme) ? { oauthRefreshState: null } : {}),
    }),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

/** The row an OAuth function works on: the person's, of the authorization-code scheme. */
async function oauthRow(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<ConnectionRow> {
  const row = orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  if (!isOAuthAuthorizationCode(row.scheme)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `${row.displayName} uses the ${row.scheme} scheme, which has no consent to run`,
    );
  }
  return row;
}

export type StartOAuthConsentInput = {
  /** Where the vendor sends the browser back — `oauthRedirectUri(GRAFT_AUTH_URL)`. */
  redirectUri: string;
  /** `GRAFT_HANDOFF_SECRET`, which signs the state as it signs a handoff URL. */
  secret: string;
  /** The `connection` or `credential` ask this consent answers, when there is one. */
  pendingActionId?: string | null;
};

export type StartedOAuthConsent = {
  /** What the console opens in a popup. */
  authorizeUrl: string;
  /** Until when the callback accepts the state. */
  expiresAt: Date;
  connection: ConnectionOutput;
};

/**
 * Start the consent (ADR 0005): a PKCE verifier is written into the connection's state for the
 * callback to read, and the authorize URL is built with its challenge, the redirect URI and a state
 * signed over this connection, this person and the ask it answers. Needs the client secret to be
 * entered first — the callback exchanges the code with it — so a connection with no credential is
 * refused, and the console's Enter credential comes before Connect. Starting again replaces the
 * verifier: only the newest consent can complete. The verifier is not a secret in the vault's sense
 * — useless without the code the vendor delivers to the callback alone, and without the client
 * secret — and is dropped when the consent completes.
 */
export async function startOAuthConsent(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  input: StartOAuthConsentInput,
  deps: ConnectionDeps,
): Promise<StartedOAuthConsent> {
  const row = await oauthRow(ctx, principal, connectionId, deps);
  if (!row.credentialCiphertext) {
    throw new ServiceError(
      "CONFLICT",
      `${row.displayName} has no client secret yet — enter it before connecting`,
    );
  }
  const clientId = row.schemeConfig.clientId;
  const authorizeUrl = row.schemeConfig.authorizeUrl;
  if (!clientId || !authorizeUrl) {
    throw new ServiceError(
      "CONFLICT",
      `${row.displayName} is missing its client id or authorize URL`,
    );
  }

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  const { verifier, challenge } = generatePkce();
  const payload: OAuthStatePayload = {
    connectionId: row.id,
    personId: principal.personId,
    pendingActionId: input.pendingActionId ?? null,
    expiresAt: expiresAt.getTime(),
    nonce: deps.newId(),
  };
  const state: OAuthState = {
    ...readOAuthState(row.oauthRefreshState),
    pkce: {
      verifier,
      issuedAt: now.toISOString(),
      pendingActionId: input.pendingActionId ?? null,
    },
  };
  const updated = orNotFound(
    await deps.setConnectionOAuthState(ctx.db, principal.personId, row.id, state),
    "Connection not found",
  );
  return {
    authorizeUrl: buildAuthorizeUrl({
      authorizeUrl,
      clientId,
      redirectUri: input.redirectUri,
      scopes: row.schemeConfig.scopes,
      state: signOAuthState(payload, input.secret),
      codeChallenge: challenge,
    }),
    expiresAt,
    connection: toConnectionOutput(updated),
  };
}

/**
 * Complete the consent (ADR 0005): the record the callback assembled — the client secret it
 * decrypted plus the tokens the code was exchanged for, `SCHEME_ISSUED_CREDENTIAL_FIELDS` — is
 * encrypted and written as the connection's credential, and the state says when the person
 * consented and when the token dies. The verifier and any earlier refusal go with the old state.
 * A revoked connection is reconnected by it (ADR 0007), as by any credential entry.
 */
export async function completeOAuthConsent(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  fields: Record<string, unknown>,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = await oauthRow(ctx, principal, connectionId, deps);
  refuse(validateIssuedCredentialFields(row.scheme, fields));
  const record = fields as Record<string, string>;
  const ciphertext = await deps.vault.encrypt(record, {
    personId: principal.personId,
    connectionId: row.id,
  });
  const now = deps.now();
  const state: OAuthState = {
    consentedAt: now.toISOString(),
    expiresAt: record.expiresAt ?? null,
  };
  const updated = orNotFound(
    await deps.setConnectionCredential(ctx.db, principal.personId, row.id, {
      ciphertext,
      setAt: now,
      oauthRefreshState: state,
    }),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

/**
 * The proxy refreshed the token and hands the rotated record back (ADR 0005; `@graft/proxy`'s
 * `storeCredential` seam, bound in `apps/server`): encrypted and written in place of the old, with
 * the new expiry and the moment beside it. A standing "consent required" is cleared — a refresh
 * that succeeded is the proof it no longer holds. `credentialSetAt` is not the person's entry here
 * but the record's last write; the console reads the consent's own moment from the state.
 */
export async function storeRefreshedCredential(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  fields: Record<string, unknown>,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = await oauthRow(ctx, principal, connectionId, deps);
  refuse(validateIssuedCredentialFields(row.scheme, fields));
  const record = fields as Record<string, string>;
  const ciphertext = await deps.vault.encrypt(record, {
    personId: principal.personId,
    connectionId: row.id,
  });
  const now = deps.now();
  const {
    consentRequired: _cleared,
    pkce: _dropped,
    ...kept
  } = readOAuthState(row.oauthRefreshState);
  const state: OAuthState = {
    ...kept,
    expiresAt: record.expiresAt ?? null,
    refreshedAt: now.toISOString(),
  };
  const updated = orNotFound(
    await deps.setConnectionCredential(ctx.db, principal.personId, row.id, {
      ciphertext,
      setAt: now,
      oauthRefreshState: state,
    }),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

/**
 * The vendor's token endpoint refused a refresh (ADR 0005; the proxy's `credentialRefreshFailed`
 * seam): the person has to consent again, and the console's button says Reconnect. The credential
 * is left as it is — the proxy keeps sending the stale token so the vendor's own 401 reaches the
 * agent — and only the state changes. `reason` is the proxy's sentence, never the endpoint's body.
 */
export async function markOAuthConsentRequired(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  reason: string,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = await oauthRow(ctx, principal, connectionId, deps);
  const state: OAuthState = {
    ...readOAuthState(row.oauthRefreshState),
    consentRequired: { at: deps.now().toISOString(), reason: reason.slice(0, 500) },
  };
  const updated = orNotFound(
    await deps.setConnectionOAuthState(ctx.db, principal.personId, row.id, state),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

export type RevokeConnectionResult = {
  connection: ConnectionOutput;
  approvalsDeleted: number;
  buildApprovalsDeleted: number;
  /** Open asks about the connection closed with it — a per-call yes among them (GRA-28). */
  pendingActionsExpired: number;
};

/**
 * Revoke (ADR 0007): the credential and every OAuth secret are cleared, every approval for every
 * tool bound to the vendor and every build approval for the connection are deleted — for all of the
 * person's agents at once — and the authored tools are left where they are, to re-ask after
 * reconnection. One transaction, so a fresh start is all-or-nothing.
 *
 * The connection's open pending actions go with the approvals (GRA-28, closing GRA-23's known
 * edge): a destructive tool's per-call yes lives on an answered, unconsumed action rather than in
 * the approval row, so deleting the rows alone left one call grantable after reconnection. A
 * credential re-entry that was still open is closed too — the reconnection is the answer to it.
 */
export async function revokeConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<RevokeConnectionResult | null> {
  return ctx.db.transaction(async (tx) => {
    const at = deps.now();
    const row = await deps.revokeConnection(tx, principal.personId, connectionId, at);
    if (!row) return null;
    const approvals = await deps.deleteApprovalsForVendor(tx, principal.personId, row.vendor);
    const builds = await deps.deleteBuildApprovalsForConnection(tx, principal.personId, row.id);
    const actions = await deps.expirePendingActionsForConnection(
      tx,
      principal.personId,
      row.id,
      at,
    );
    return {
      connection: toConnectionOutput(row),
      approvalsDeleted: approvals.length,
      buildApprovalsDeleted: builds.length,
      pendingActionsExpired: actions.length,
    };
  });
}
