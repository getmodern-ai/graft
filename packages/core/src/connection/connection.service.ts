import type { ConnectionRow } from "@graft/db/repo/connection";
import type { ConnectionScheme } from "@graft/db/schema/connection";
import type { ProxyConnection } from "@graft/proxy";

import type { ServiceContext } from "../context";
import { isUniqueViolation, orNotFound, ServiceError } from "../errors";
import type { Principal } from "../tenancy";
import type { ConnectionDeps } from "./connection.deps";
import {
  type HostSetRefusal,
  takesCredential,
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
import {
  type ConnectionProvider,
  DEFAULT_PROVIDERS,
  KEYRING_PROVIDER,
  type ProviderDescription,
  providerLinkOf,
  providerNamed,
} from "./provider";

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
  /** Where the connection comes from (ADR 0019) — `keyring` for every row until another provider is enabled. */
  provider: string;
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
  /**
   * When the provider last failed to release what it held for this row on a revoke (ADR 0019) —
   * the account is still at the provider, and the console offers the retry. Null when nothing is
   * outstanding: the keyring's rows always, a relay provider's once its release answered.
   */
  providerReleaseFailedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toConnectionOutput(row: ConnectionRow): ConnectionOutput {
  return {
    id: row.id,
    provider: row.provider,
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
    providerReleaseFailedAt: row.providerReleaseFailedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Whether a vendor call through this connection can succeed today: not revoked, its provider
 * enabled on this deployment, and — for a provider whose credential is entered here — a credential
 * set and, for an authorization-code connection, the consent completed and not since refused.
 * What `request_connection` reads before saying "already connected", and the console's "connected".
 *
 * A connection from another provider holds no credential here (ADR 0019): it exists only once its
 * provider made it — with no person step (the gateway, GRA-58), or once the provider confirmed what
 * the person connected (`connectThroughProvider`, GRA-59) — so it is connected by existing and
 * revoked into nothing. One the deployment no longer enables resolves to nothing the proxy can call
 * through (`toProxyConnection`), and is not usable for the same reason. `providers` takes the
 * descriptions the console holds as readily as the providers themselves; the default is the
 * keyring alone.
 */
export function isConnectionUsable(
  connection: ConnectionOutput,
  providers: readonly ProviderDescription[] = DEFAULT_PROVIDERS,
): boolean {
  if (connection.revokedAt !== null) return false;
  const provider = providers.find((candidate) => candidate.name === connection.provider);
  if (!provider) return false;
  if (provider.connect.kind !== "form") return true;
  // A `none` connection holds no credential and is usable from registration (GRA-66).
  if (connection.credentialSetAt === null && takesCredential(connection.scheme)) return false;
  return connection.oauth === null || connection.oauth.status === "connected";
}

/**
 * The proxy's view of a row: the identity it compares against the token, the host set it pins to,
 * and — from the row's provider (ADR 0019) — how the call resolves: the columns to decrypt and
 * inject from, or the relay to send it through. Built field by field, so a column added to the table
 * later does not ride into the proxy by accident. A revoked connection resolves to nothing and
 * carries its `revokedAt`, so the proxy refuses it `connection_revoked` whatever its provider
 * (GRA-68), naming the state and the console's Reconnect rather than the columns the revoke left
 * null. Asked here rather than left to the null ciphertext a revoke leaves, because a relay
 * provider's row never had one (ADR 0019): the revoke is the person's, and a capability token
 * minted from a scope that still names the row must not relay through it; and such a row may still
 * carry its reference while the provider's release is outstanding (`releaseFromProvider`), which
 * is exactly when a call must not go through. A row whose provider holds nothing for it yet, a
 * link never finished, carries that provider's name as `pendingProvider`, and the proxy's
 * `connection_not_ready` says who holds nothing. A row whose provider the deployment has not
 * enabled resolves to nothing, which the proxy answers `connection_not_ready`: a connection made
 * under a provider that is now absent is not one this deployment can call through, and saying so
 * is better than guessing at the keyring.
 */
export function toProxyConnection(
  row: ConnectionRow,
  providers: readonly ConnectionProvider[] = DEFAULT_PROVIDERS,
): ProxyConnection {
  const identity = {
    id: row.id,
    personId: row.personId,
    primaryHost: row.primaryHost,
    hosts: row.hosts,
    revokedAt: row.revokedAt,
  };
  const nothing: ProxyConnection = {
    ...identity,
    authScheme: null,
    schemeConfig: null,
    credentialCiphertext: null,
  };
  if (row.revokedAt) return nothing;
  const resolution = providerNamed(providers, row.provider)?.resolve(row) ?? null;
  if (!resolution) return nothing;
  if (resolution.mode === "pending") return { ...nothing, pendingProvider: row.provider };
  if (resolution.mode === "relay") return { ...nothing, relay: resolution.relay };
  return {
    ...identity,
    authScheme: resolution.scheme,
    schemeConfig: resolution.schemeConfig,
    credentialCiphertext: resolution.credentialCiphertext,
  };
}

export type RegisterConnectionInput = {
  /**
   * Where the connection comes from (ADR 0019); the keyring when absent. Must name a provider the
   * deployment has enabled, and one that connects through the console's form — a provider that
   * connects with a link or with no person step registers its rows through its own flow.
   */
  provider?: string;
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

/**
 * The provider a row names, as one this deployment has enabled and one whose connections the
 * console's form makes (ADR 0019). A name nobody enabled is a 400 — a row under a provider the
 * process cannot resolve would be one the proxy refuses on every call — and so is a provider that
 * connects some other way: its rows are registered by its own flow, and a credential typed into the
 * console for one would be a credential Graft holds for a connection whose provider holds its own.
 */
function formProviderNamed(deps: ConnectionDeps, name: string): ConnectionProvider {
  const provider = providerNamed(deps.providers, name);
  if (!provider) {
    throw new ServiceError(
      "BAD_REQUEST",
      `No connection provider named ${name} is enabled on this deployment`,
    );
  }
  if (provider.connect.kind !== "form") {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider connects a vendor with ${provider.connect.kind === "link" ? "a link" : "no person step"}, not with a credential entered in the console`,
    );
  }
  return provider;
}

/** The checks every registration passes, in the order a person would fix them; the normalised values out. */
function validateRegistration(input: RegisterConnectionInput, deps: ConnectionDeps) {
  const provider = formProviderNamed(deps, input.provider ?? KEYRING_PROVIDER);
  refuse(validateVendor(input.vendor));
  refuse(validateDisplayName(input.displayName));
  const schemeConfig = input.schemeConfig ?? {};
  refuse(validateSchemeConfig(input.scheme, schemeConfig));
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) refuseHostSet(hostSet);
  return { provider, schemeConfig, hostSet };
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
  const { provider, schemeConfig, hostSet } = validateRegistration(input, deps);

  const row = await deps.insertConnection(ctx.db, {
    id: deps.newId(),
    personId: principal.personId,
    provider: provider.name,
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
  validateRegistration(registration, deps);
  refuse(validateCredentialFields(registration.scheme, credential));
  // A `none` connection has nothing to encrypt: the row alone is the connected connection (GRA-66).
  if (!takesCredential(registration.scheme)) {
    return registerConnection(ctx, principal, registration, deps);
  }
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const registered = await registerConnection(scoped, principal, registration, deps);
    return setConnectionCredential(scoped, principal, registered.id, credential, deps);
  });
}

export type RegisterProviderConnectionInput = {
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts?: readonly string[];
};

/**
 * Register a connection a provider makes with **no person step** (ADR 0019; the gateway, GRA-58):
 * the vendor, the name and the host set as the agent proposed them, the provider's name and the
 * relay scheme its `connect` shape names, no credential and no `provider_ref`. Refused for a
 * provider of any other kind — a form provider's rows come with a credential and a link provider's
 * through its own flow — for one the deployment has not enabled, and for a vendor the provider does
 * not cover at these hosts: the caller routed the proposal with `providerFor`, and this is the
 * check that the row written is one the provider will resolve. The host rule is the same one every
 * registration passes; a gateway does not make a private host reachable.
 */
export async function registerProviderConnection(
  ctx: ServiceContext,
  principal: Principal,
  provider: ConnectionProvider,
  input: RegisterProviderConnectionInput,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  if (providerNamed(deps.providers, provider.name) !== provider) {
    throw new ServiceError(
      "BAD_REQUEST",
      `No connection provider named ${provider.name} is enabled on this deployment`,
    );
  }
  if (provider.connect.kind !== "none") {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider connects a vendor ${provider.connect.kind === "form" ? "with a credential entered in the console" : "with a link"}, not without a person step`,
    );
  }
  refuse(validateVendor(input.vendor));
  refuse(validateDisplayName(input.displayName));
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) refuseHostSet(hostSet);
  if (!provider.covers(input.vendor, hostSet.hosts)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider does not cover ${input.vendor} at ${hostSet.hosts.join(", ")}`,
    );
  }
  const row = await deps.insertConnection(ctx.db, {
    id: deps.newId(),
    personId: principal.personId,
    provider: provider.name,
    providerRef: null,
    vendor: input.vendor,
    displayName: input.displayName.trim(),
    scheme: provider.connect.scheme,
    schemeConfig: {},
    primaryHost: hostSet.primaryHost,
    hosts: hostSet.hosts,
  });
  return toConnectionOutput(row);
}

/**
 * Widen a provider-made row's host set to a later proposal's (GRA-58): an agent that already holds
 * `api.vendor.example` through the gateway proposes the same vendor and primary host with
 * `files.vendor.example` beside it, and answering "already connected" with the narrower row would
 * have its calls to the new host refused as `host_not_in_set`. The union is checked as any host set
 * is and against the provider's coverage — the gateway has a route for every host it covers, and
 * nothing outside that can be added — so widening grants nothing the deployment did not. A row of
 * any other kind is refused: the keyring's host set is what the person confirmed on the handoff
 * page, and is not an agent's to grow. A union already declared is answered as it is. The write is
 * one statement appending what the row lacks when it runs (`addConnectionHosts`), so two calls
 * widening the same row at once both land: each was checked against the coverage, and a union of
 * covered sets is covered.
 */
export async function widenProviderConnectionHosts(
  ctx: ServiceContext,
  principal: Principal,
  provider: ConnectionProvider,
  connectionId: string,
  hosts: readonly string[],
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  if (row.provider !== provider.name || provider.connect.kind !== "none") {
    throw new ServiceError(
      "BAD_REQUEST",
      `${row.displayName}'s host set is the person's to change, not a provider's`,
    );
  }
  const union = validateHostSet(row.primaryHost, [...row.hosts, ...hosts]);
  if (!union.ok) refuseHostSet(union);
  if (!provider.covers(row.vendor, union.hosts)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider does not cover ${row.vendor} at ${union.hosts.join(", ")}`,
    );
  }
  if (union.hosts.every((host) => row.hosts.includes(host))) return toConnectionOutput(row);
  const updated = orNotFound(
    await deps.addConnectionHosts(ctx.db, principal.personId, row.id, union.hosts),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

/**
 * Reconnect a revoked connection that has no credential to re-enter — one a provider made with no
 * person step (ADR 0019, GRA-58), or a keyring row on a scheme that takes no credential (`none`,
 * GRA-66). The keyring's way back is otherwise a credential re-entered (`setConnectionCredential`
 * clears the stamp with the ciphertext) and a link provider's is its own flow, so this refuses
 * those two by saying which way back is theirs. The approvals a revoke deleted stay deleted: every tool bound to
 * the vendor asks again (ADR 0007), for this kind as for any. A row that is not revoked is answered
 * as it is, so a second click changes nothing.
 */
export async function reconnectConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const row = orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  const provider = providerNamed(deps.providers, row.provider);
  if (!provider) {
    throw new ServiceError(
      "BAD_REQUEST",
      `No connection provider named ${row.provider} is enabled on this deployment`,
    );
  }
  const keyless = provider.connect.kind === "form" && !takesCredential(row.scheme);
  if (provider.connect.kind !== "none" && !keyless) {
    throw new ServiceError(
      "BAD_REQUEST",
      provider.connect.kind === "form"
        ? `${row.displayName} is reconnected by re-entering its credential`
        : `${row.displayName} is reconnected through the ${provider.name} provider`,
    );
  }
  if (row.revokedAt === null) return toConnectionOutput(row);
  const updated = orNotFound(
    await deps.reconnectConnection(ctx.db, principal.personId, row.id),
    "Connection not found",
  );
  return toConnectionOutput(updated);
}

export type ConnectThroughProviderInput = {
  /** A provider that connects with a link (ADR 0019) — enabled on this deployment. */
  provider: ConnectionProvider;
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts?: readonly string[];
  /** The provider's reference for what the person connected — a broker's account id — as `complete` answered it. */
  ref: string;
};

/**
 * A connection through a provider that connects with a link, made once the provider has confirmed
 * what the person connected (ADR 0019; GRA-59): the row carries the provider's name, the relay
 * scheme its calls leave through, the vendor and the host set, and the provider's reference on
 * `provider_ref` — and no credential, because there is none here. The rules are the form's
 * (`registerConnection`), plus one: the provider must cover the vendor at these hosts, since the
 * relay injects the account's token into whatever vendor URL it is handed.
 *
 * A revoked row of the same provider at the same vendor, primary host and host set is
 * **reconnected in place** rather than shadowed by a second row — the reconnection a credential
 * re-entry is for a keyring row (ADR 0007) — so the connection id stays what every agent's scope
 * names. Only once the provider has released it: a revoked row still carrying its reference has a
 * release outstanding — in flight, or failed and awaiting the retry — and writing a new reference
 * over it would orphan the account at the provider. Any other row makes a new one; a person may
 * well hold two accounts at one vendor. A reference already on another row is the database's
 * refusal (`connection_provider_ref_idx`), answered `CONFLICT`: two landings claimed one account,
 * and the caller re-reads what the first did.
 */
export async function connectThroughProvider(
  ctx: ServiceContext,
  principal: Principal,
  input: ConnectThroughProviderInput,
  deps: ConnectionDeps,
): Promise<ConnectionOutput> {
  const provider = input.provider;
  if (!providerNamed(deps.providers, provider.name)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `No connection provider named ${provider.name} is enabled on this deployment`,
    );
  }
  const link = providerLinkOf(provider);
  if (!link) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider does not connect a vendor with a link`,
    );
  }
  refuse(validateVendor(input.vendor));
  refuse(validateDisplayName(input.displayName));
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) refuseHostSet(hostSet);
  if (!provider.covers(input.vendor, hostSet.hosts)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider does not cover ${input.vendor} at ${hostSet.hosts.join(", ")}`,
    );
  }
  if (input.ref.trim().length === 0) {
    throw new ServiceError("BAD_REQUEST", `The ${provider.name} provider named no account`);
  }

  // A released row and no other: `provider_ref` is null once the provider let go
  // (`recordProviderRelease`), and still set while the release is outstanding.
  const hostsKey = [...hostSet.hosts].sort().join(" ");
  const released = (await deps.listConnections(ctx.db, principal.personId)).find(
    (row) =>
      row.revokedAt !== null &&
      row.providerRef === null &&
      row.provider === provider.name &&
      row.vendor === input.vendor &&
      row.primaryHost === hostSet.primaryHost &&
      [...row.hosts].sort().join(" ") === hostsKey,
  );
  const claimed = () =>
    new ServiceError(
      "CONFLICT",
      `${input.displayName.trim()} at ${provider.name} is already connected — another landing of this link claimed the account first`,
    );
  if (released) {
    let reconnected: ConnectionRow | null;
    try {
      reconnected = await deps.setConnectionProviderRef(
        ctx.db,
        principal.personId,
        released.id,
        input.ref,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw claimed();
      throw error;
    }
    return toConnectionOutput(orNotFound(reconnected, "Connection not found"));
  }

  let row: ConnectionRow;
  try {
    row = await deps.insertConnection(ctx.db, {
      id: deps.newId(),
      personId: principal.personId,
      provider: provider.name,
      providerRef: input.ref,
      vendor: input.vendor,
      displayName: input.displayName.trim(),
      scheme: link.scheme,
      schemeConfig: {},
      primaryHost: hostSet.primaryHost,
      hosts: hostSet.hosts,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw claimed();
    throw error;
  }
  return toConnectionOutput(row);
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
  // A relay provider's connection has no credential here to enter or re-enter (ADR 0019).
  formProviderNamed(deps, row.provider);
  if (!takesCredential(row.scheme)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A ${row.scheme} connection sends no credential; there is nothing to enter`,
    );
  }
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

/**
 * Whether the row's provider released what it held for the connection outside Graft (ADR 0019).
 * `released` for the keyring always — it holds nothing — and for a provider whose release answered.
 * A release that threw is reported here and never as the revoke's failure: the row, the approvals
 * and the asks were revoked in the transaction before the provider was asked, and a 500 would say
 * otherwise. `failure` is the thrown error's class name, never its message — the provider's
 * messages are its own and may carry anything (the rule `@graft/proxy`'s `failure.ts` states for a
 * host-injected dependency). Revoking the connection again re-runs the release, which is the retry.
 */
export type ProviderRelease =
  | { provider: string; released: true }
  | { provider: string; released: false; failure: string };

export type RevokeConnectionResult = {
  connection: ConnectionOutput;
  approvalsDeleted: number;
  buildApprovalsDeleted: number;
  /** Open asks about the connection closed with it — a per-call yes among them (GRA-28). */
  pendingActionsExpired: number;
  /**
   * The working-set entries the revoke removed, across every agent of the person (ADR 0009 as
   * amended 2026-09-18; GRA-69): a promoted tool bound to the connection cannot run, so it leaves
   * the list with cause `revoke`. The tool stays in the toolbox; `promote` brings it back.
   */
  demoted: { agentId: string; toolId: string }[];
  /**
   * Every agent whose tool list this revoke changed, sorted: each whose scope names the connection,
   * when this revoke is the one that revoked it (its execute tool leaves the list once, not on the
   * re-revoke that retries a provider's release), and each a demotion touched. The core has no
   * notifier, so the caller announces `tools/list_changed` to these (`@graft/mcp`'s `revoke.ts`).
   */
  affectedAgentIds: string[];
  providerRelease: ProviderRelease;
};

/**
 * Revoke (ADR 0007): the credential and every OAuth secret are cleared, every approval for every
 * tool bound to the vendor and every build approval for the connection are deleted — for all of the
 * person's agents at once — and the authored tools are left where they are, to re-ask after
 * reconnection. One transaction, so a fresh start is all-or-nothing.
 *
 * Their promotions do not stay (ADR 0009 as amended 2026-09-18; GRA-69): every working-set entry
 * for a tool bound to the connection goes, for every agent at once, each recorded as a demotion
 * with cause `revoke`, because a tool that cannot run has no place in a list. Nothing is deleted
 * from the toolbox; `find_tool` still finds the tool, `promote` brings it back, and it runs again
 * once the connection is reconnected. The agents whose list changed ride the result for the caller
 * to announce, since the connection module holds no notifier and the working-set service is not
 * imported here: the sweep is one statement of the working-set repo, as the approval sweeps are.
 *
 * The connection's open pending actions go with the approvals (GRA-28, closing GRA-23's known
 * edge): a destructive tool's per-call yes lives on an answered, unconsumed action rather than in
 * the approval row, so deleting the rows alone left one call grantable after reconnection. A
 * credential re-entry that was still open is closed too — the reconnection is the answer to it.
 *
 * Then the row's provider releases what it holds for the connection outside Graft — a broker's
 * account, a gateway's registration (ADR 0019) — after the transaction, since that is a call to
 * another party and not a row. The revoke stands whatever it answers: a release that throws is
 * reported on the result (`providerRelease`) rather than thrown, because everything local has
 * already been revoked and a failure answer would send the caller to retry a revoke that happened.
 * Revoking again re-runs the release, so the row's page is the retry path. A provider the
 * deployment no longer enables has nothing to be asked; the keyring holds nothing and releases nothing.
 */
export async function revokeConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<RevokeConnectionResult | null> {
  const revoked = await ctx.db.transaction(async (tx) => {
    const at = deps.now();
    // Read before the write: whether this revoke is the transition. A revoke of a revoked row is
    // the provider release's retry and changes no list, so the scoped agents are told once.
    const before = await deps.findConnection(tx, principal.personId, connectionId);
    const wasLive = before?.revokedAt === null;
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
    const entries = await deps.deleteWorkingSetEntriesForConnection(tx, principal.personId, row.id);
    for (const entry of entries) {
      await deps.insertWorkingSetChange(tx, {
        id: deps.newId(),
        agentId: entry.agentId,
        toolId: entry.toolId,
        change: "demote",
        cause: "revoke",
        createdAt: at,
      });
    }
    const scoped = wasLive
      ? await deps.listAgentIdsForConnection(tx, principal.personId, row.id)
      : [];
    const affectedAgentIds = [
      ...new Set([...scoped, ...entries.map((entry) => entry.agentId)]),
    ].sort();
    return {
      row,
      result: {
        approvalsDeleted: approvals.length,
        buildApprovalsDeleted: builds.length,
        pendingActionsExpired: actions.length,
        demoted: entries.map((entry) => ({ agentId: entry.agentId, toolId: entry.toolId })),
        affectedAgentIds,
      },
    };
  });
  if (!revoked) return null;
  const { row, providerRelease } = await releaseFromProvider(ctx, principal, deps, revoked.row);
  return { ...revoked.result, connection: toConnectionOutput(row), providerRelease };
}

/**
 * Ask the provider again to release what it still holds for a revoked connection (ADR 0019;
 * GRA-59) — the console's Retry on a card whose `providerReleaseFailedAt` is set. The same release
 * the revoke ran, recorded the same way; a row with nothing outstanding — released already, or
 * never revoked — is refused rather than asked, because a release of a live connection's account
 * would be a revoke by another name.
 */
export async function retryProviderRelease(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionDeps,
): Promise<{ connection: ConnectionOutput; providerRelease: ProviderRelease }> {
  const row = orNotFound(
    await deps.findConnection(ctx.db, principal.personId, connectionId),
    "Connection not found",
  );
  if (row.revokedAt === null) {
    throw new ServiceError(
      "CONFLICT",
      `${row.displayName} is not revoked; revoke it to release it`,
    );
  }
  if (row.providerReleaseFailedAt === null || row.providerRef === null) {
    throw new ServiceError(
      "CONFLICT",
      `${row.displayName} has nothing outstanding at its provider to release`,
    );
  }
  const released = await releaseFromProvider(ctx, principal, deps, row);
  return {
    connection: toConnectionOutput(released.row),
    providerRelease: released.providerRelease,
  };
}

/**
 * The provider's release, as a report and never as a throw — the local revoke has committed — and
 * as a record on the row (`recordProviderRelease`): released, the reference goes; failed, the
 * moment is stamped and the reference kept for the retry. The row handed to the provider is the
 * row as it stands, reference included, which is why the revoke's statement leaves it in place.
 * The record is written against that same reference on a row still revoked, so a link that
 * reconnected the row while the provider was being asked keeps its new reference; a row that moved
 * on is read back as it now is. A row with no reference — the keyring's — has nothing to record.
 */
async function releaseFromProvider(
  ctx: ServiceContext,
  principal: Principal,
  deps: ConnectionDeps,
  row: ConnectionRow,
): Promise<{ row: ConnectionRow; providerRelease: ProviderRelease }> {
  const provider = providerNamed(deps.providers, row.provider);
  let providerRelease: ProviderRelease;
  if (!provider) {
    providerRelease = { provider: row.provider, released: true };
  } else {
    try {
      await provider.revoke(row);
      providerRelease = { provider: provider.name, released: true };
    } catch (error) {
      const failure =
        error instanceof Error ? error.name || "Error" : error === null ? "null" : typeof error;
      providerRelease = { provider: provider.name, released: false, failure };
    }
  }
  const ref = row.providerRef;
  if (ref === null) return { row, providerRelease };
  const recorded = await deps.recordProviderRelease(
    ctx.db,
    principal.personId,
    row.id,
    providerRelease.released ? { released: true, ref } : { released: false, ref, at: deps.now() },
  );
  const current = recorded ?? (await deps.findConnection(ctx.db, principal.personId, row.id));
  return { row: current ?? row, providerRelease };
}
