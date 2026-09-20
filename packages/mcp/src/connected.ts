import type { Principal, ServiceContext } from "@graft/core";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";

/**
 * A connection made or reconnected, announced to the sessions it changes: `tools/list_changed` to
 * every agent whose scope reaches the row — every agent on `all`, and every agent whose list names
 * it (ADR 0007 as amended 2026-09-19; `listAgentIdsForConnection` is the one statement) — the way
 * `revokeConnectionAndNotify` (`revoke.ts`) announces the row leaving. Before the amendment only
 * the requesting agent's list changed on a connect, so only it was told; now the row enters every
 * `all` agent's scope the moment it exists, and a session left untold would keep a stale list until
 * it reconnected (Greptile on #88). The core holds no notifier, so this lives here, and **the path
 * that makes or reconnects the row is the one announcer**, after its transaction:
 * `request_connection`'s gateway connect (`connection-request.ts`), the ask card's keyless confirm
 * (`tools/answer-ask.ts`), and the server's create, reconnect, credential re-entry on a revoked
 * row, ask submit and link return (`apps/server/src/api.ts`, `provider-link.ts`). The settle in
 * which a waiting `request_connection` reads a recorded answer announces nothing: the list changed
 * when the row was made, and a second event for an unchanged list would only make clients
 * re-fetch (Greptile on #88). Answers the agents told, sorted, so a caller's answer can name them
 * as the revoke's does.
 */
export async function notifyAgentsReachingConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: Pick<McpDeps, "connection">,
  notifier: Pick<ToolListChangedNotifier, "changed"> | undefined,
): Promise<string[]> {
  const agentIds = await deps.connection.listAgentIdsForConnection(
    ctx.db,
    principal.personId,
    connectionId,
  );
  for (const agentId of agentIds) notifier?.changed(agentId);
  return agentIds;
}
