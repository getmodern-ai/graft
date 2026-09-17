import type { ConnectionOutput, RevokeConnectionResult } from "@graft/core";
import { GATEWAY_PROVIDER } from "@graft/core/connection/gateway-provider";
import { KEYRING_PROVIDER } from "@graft/core/connection/provider";
import type { AuthScheme } from "@graft/proxy/types";
import type { ConnectionCallOutput } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import type { Tool } from "./agent-queries";
import { api, type Jsonified } from "./api";
import type { ConnectionRegistration } from "./connection-form";
import type { PendingAction } from "./pending-action-queries";

/**
 * Connections, as the console lists, creates, re-credentials and revokes them (ADR 0007: a
 * connection is the person's, and a revoke reaches every agent at once). A credential travels in a
 * request body to the server and to nothing else here — no query reads one back, and the server
 * answers `credentialSetAt` alone (GRA-28; CONTEXT.md, *Connection*: write-only after entry). The
 * two submits on a pending action are the connection handoff's own routes (`apps/server/src/api.ts`,
 * "The connection handoff's submits"), apart from the generic answer because of what they carry.
 */

export type Connection = Jsonified<ConnectionOutput>;
export type ConnectionCall = Jsonified<ConnectionCallOutput>;
export type RevokeResult = Jsonified<RevokeConnectionResult>;

export const connectionKeys = {
  all: ["connections"] as const,
  calls: (connectionId: string) => ["connections", connectionId, "calls"] as const,
};

export const toolKeys = {
  all: ["tools"] as const,
};

export const connectionsQuery = queryOptions({
  queryKey: connectionKeys.all,
  queryFn: () => api<{ connections: Connection[] }>("/connections"),
});

/**
 * The connection's recent vendor calls — from the ledger, since the proxy's wide events are not
 * persisted (the route's comment in `apps/server/src/api.ts` says so; GRA-26).
 */
export const connectionCallsQuery = (connectionId: string, limit = 25) =>
  queryOptions({
    queryKey: [...connectionKeys.calls(connectionId), limit] as const,
    queryFn: () =>
      api<{ calls: ConnectionCall[] }>(
        `/connections/${encodeURIComponent(connectionId)}/usage?limit=${limit}`,
      ),
  });

/** The person's whole toolbox, demoted tools included — a connection's tools are the vendor's rows. */
export const toolsQuery = queryOptions({
  queryKey: toolKeys.all,
  queryFn: () => api<{ tools: Tool[] }>("/tools"),
});

export function revokeConnection(connectionId: string) {
  return api<RevokeResult>(`/connections/${encodeURIComponent(connectionId)}/revoke`, {
    method: "POST",
  });
}

/** The way back for a revoked gateway connection: nothing to enter, the stamp cleared (GRA-58). */
export function reconnectConnection(connectionId: string) {
  return api<{ connection: Connection }>(
    `/connections/${encodeURIComponent(connectionId)}/reconnect`,
    { method: "POST" },
  );
}

/**
 * Ask the provider again to release what it still holds for a revoked connection (ADR 0019): the
 * card's Retry while `providerReleaseFailedAt` says the account is still at the provider.
 */
export function retryProviderRelease(connectionId: string) {
  return api<{ connection: Connection; providerRelease: RevokeResult["providerRelease"] }>(
    `/connections/${encodeURIComponent(connectionId)}/release`,
    { method: "POST" },
  );
}

/**
 * The tools a connection stands behind: bound by vendor, never by row (ADR 0007), which is what
 * lets a revoked connection's tools stay and re-ask after reconnection.
 */
export function toolsOfConnection(tools: readonly Tool[], connection: Connection): Tool[] {
  return tools.filter((tool) => tool.vendor === connection.vendor);
}

/**
 * A connection with no credential — never entered, or revoked — has tools that cannot run yet. A
 * `none` connection never has one and is connected from registration (GRA-66).
 */
export function isAwaitingCredential(connection: Connection): boolean {
  return connection.credentialSetAt === null && connection.scheme !== "none";
}

/** A keyring connection's scheme is one the form enters a credential for — never a relay scheme (ADR 0019). */
export type KeyringConnection<C extends Pick<Connection, "provider"> = Connection> = C & {
  scheme: AuthScheme;
};

/**
 * Whether the connection's credential is Graft's to hold — entered in the console, re-entered
 * there, revoked into nothing (ADR 0019). A connection from any other provider holds no credential
 * here: what the card shows is where it is connected through, and the credential buttons are not
 * offered. `@graft/core/connection/provider` is browser-safe for exactly this read. A type
 * predicate, because the keyring's rows carry a signing scheme by construction (its `connect`
 * shape lists exactly those), which is what the credential form's helpers take.
 */
export function isKeyringConnection<C extends Pick<Connection, "provider">>(
  connection: C,
): connection is KeyringConnection<C> {
  return connection.provider === KEYRING_PROVIDER;
}

/**
 * A connection through the deployment's API gateway (ADR 0019, GRA-58): connected with no person
 * step, no credential here, and Reconnect as its one way back from a revoke — the keyring's is a
 * credential re-entered, and a link provider's is its own flow.
 */
export function isGatewayConnection(connection: Pick<Connection, "provider">): boolean {
  return connection.provider === GATEWAY_PROVIDER;
}

/**
 * The provider's badge on a card, in the person's words: the gateway is *their* API gateway, and
 * a provider this console has no words for yet is named as the row names it.
 */
export function providerLabel(connection: Pick<Connection, "provider">): string {
  if (isGatewayConnection(connection)) return "Through your API gateway";
  return `via ${connection.provider}`;
}

/**
 * Where a connection stands, as the card's badge and button read it (ADR 0005 for the two consent
 * states): revoked; no credential entered; an OAuth consent not yet completed, or refused since;
 * or connected.
 */
export type ConnectionStatus =
  | "revoked"
  | "awaiting_credential"
  | "awaiting_consent"
  | "consent_required"
  | "connected";

export function connectionStatus(connection: Connection): ConnectionStatus {
  if (connection.revokedAt) return "revoked";
  // A connection another provider holds is connected by existing: its credential is at the
  // provider, so a null `credentialSetAt` says nothing about it (ADR 0019). A provider with a state
  // of its own between the two — a link not yet followed — adds it with its card (GRA-59).
  if (!isKeyringConnection(connection)) return "connected";
  if (connection.credentialSetAt === null) return "awaiting_credential";
  if (connection.oauth && connection.oauth.status !== "connected") return connection.oauth.status;
  return "connected";
}

/**
 * The three routes that store a credential answer `authorizeUrl` beside the connection when the
 * scheme runs a consent (ADR 0005): the console opens it in a popup (`oauth-consent.ts`). Absent
 * for every other scheme, whose credential is complete as entered.
 */
export type StoredCredential = { connection: Connection; authorizeUrl?: string };

/** The person's own Add connection: registered with its credential in one transaction (GRA-28). */
export function createConnection(
  input: ConnectionRegistration & { credential: Record<string, string> },
) {
  return api<StoredCredential>("/connections", { method: "POST", body: input });
}

/** Re-enter a credential with no agent asking — a rotated key, or the reconnection after a revoke. */
export function setConnectionCredential(connectionId: string, credential: Record<string, string>) {
  return api<{ connection: Connection }>(
    `/connections/${encodeURIComponent(connectionId)}/credential`,
    { method: "PUT", body: { fields: credential } },
  );
}

/**
 * The submit for an agent's `connection` ask: the proposal as edited, and the secret. For an OAuth
 * consent the ask comes back still open — the callback answers it once the tokens are stored.
 */
export function submitConnectionProposal(
  actionId: string,
  input: ConnectionRegistration & { credential: Record<string, string> },
) {
  return api<StoredCredential & { pendingAction: PendingAction }>(
    `/pending-actions/${encodeURIComponent(actionId)}/connection`,
    { method: "POST", body: input },
  );
}

/** The submit for an agent's `credential` ask: the secret alone. */
export function submitCredentialRequest(actionId: string, credential: Record<string, string>) {
  return api<StoredCredential & { pendingAction: PendingAction }>(
    `/pending-actions/${encodeURIComponent(actionId)}/credential`,
    { method: "POST", body: { credential } },
  );
}

/** One connection, fresh from the server — the consent's poll reads this. */
export function fetchConnection(connectionId: string) {
  return api<{ connection: Connection }>(`/connections/${encodeURIComponent(connectionId)}`);
}
