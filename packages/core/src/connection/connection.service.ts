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
  validateOAuthClient,
  validateSchemeConfig,
  validateVendor,
} from "./connection.rules";

/**
 * Connections (CONTEXT.md; ADR 0007, ADR 0010): register, enter or re-enter the credential, revoke,
 * list. The credential is written through the vault's encrypt half and read back by nothing here:
 * the row's public shape carries `credentialSetAt` alone, and `toProxyConnection` is the one
 * function that hands the ciphertext on — to the proxy's binding in `apps/server`, which decrypts.
 */

/** The row as the wire sees it: never a ciphertext, never the refresh state. */
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
  oauthClientId: string | null;
  oauthAuthorizeUrl: string | null;
  oauthTokenUrl: string | null;
  oauthScopes: string[] | null;
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
    oauthClientId: row.oauthClientId,
    oauthAuthorizeUrl: row.oauthAuthorizeUrl,
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScopes: row.oauthScopes,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  schemeConfig?: Record<string, unknown>;
  primaryHost: string;
  hosts?: readonly string[];
  /** An authorization-code client the person registered (ADR 0005); the secret comes separately. */
  oauth?: { clientId: string; authorizeUrl: string; tokenUrl: string; scopes?: readonly string[] };
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
  const oauth = input.oauth ? validateOAuthClient(input.oauth) : null;
  if (oauth && !oauth.ok) throw new ServiceError("BAD_REQUEST", oauth.problem);
  return { schemeConfig, hostSet, oauth };
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
  const { schemeConfig, hostSet, oauth } = validateRegistration(input);

  const row = await deps.insertConnection(ctx.db, {
    id: deps.newId(),
    personId: principal.personId,
    vendor: input.vendor,
    displayName: input.displayName.trim(),
    scheme: input.scheme,
    schemeConfig: schemeConfig as Record<string, string>,
    primaryHost: hostSet.primaryHost,
    hosts: hostSet.hosts,
    ...(oauth?.ok
      ? {
          oauthClientId: oauth.clientId,
          oauthAuthorizeUrl: oauth.authorizeUrl,
          oauthTokenUrl: oauth.tokenUrl,
          oauthScopes: oauth.scopes,
        }
      : {}),
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
    }),
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
