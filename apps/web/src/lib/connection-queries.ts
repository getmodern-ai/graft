import type { ConnectionOutput, RevokeConnectionResult } from "@graft/core";
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

/**
 * The tools a connection stands behind: bound by vendor, never by row (ADR 0007), which is what
 * lets a revoked connection's tools stay and re-ask after reconnection.
 */
export function toolsOfConnection(tools: readonly Tool[], connection: Connection): Tool[] {
  return tools.filter((tool) => tool.vendor === connection.vendor);
}

/** A connection with no credential — never entered, or revoked — has tools that cannot run yet. */
export function isAwaitingCredential(connection: Connection): boolean {
  return connection.credentialSetAt === null;
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
