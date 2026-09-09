import type { ConnectionOutput, RevokeConnectionResult } from "@graft/core";
import type { ConnectionCallOutput } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import type { Tool } from "./agent-queries";
import { api, type Jsonified } from "./api";

/**
 * Connections, as the console lists and revokes them (ADR 0007: a connection is the person's, and a
 * revoke reaches every agent at once). Entering and re-entering a credential arrive with GRA-28;
 * the routes exist on the server already (`PUT /api/connections/:id/credential`).
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
