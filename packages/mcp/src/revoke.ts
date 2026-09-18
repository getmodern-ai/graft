import {
  type ConnectionOutput,
  type Principal,
  type RevokeConnectionResult,
  revokeConnection,
  type ServiceContext,
} from "@graft/core";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";
import { type Refusal, refusal } from "./result";

/**
 * What a revoke means to this server, in two halves: the refusal every path that still reaches a
 * revoked connection answers with, and the announcement to the sessions the revoke changed.
 */

/**
 * The refusal for a call, or an answer, that reaches a connection the person revoked, worded as
 * `request_connection`'s `connection_revoked` is (`connection-request.ts`) so every surface agrees
 * (GRA-69). The list no longer offers such a connection (`tools.ts`), but `run_tool`, a client that
 * snapshots its list, and an ask left open across the revoke (`approval.ts`) can still reach it,
 * and the next step is never an approval on a revoked connection nor the proxy's 409: it is the
 * person's reconnection, and this says so.
 */
export function revokedConnectionRefusal(connection: ConnectionOutput): Refusal {
  return refusal(
    "connection_revoked",
    `${connection.displayName} (${connection.vendor}) was revoked by the person, so nothing can run against it. Ask them to reconnect it in the console (Connections, then Re-enter or Reconnect on the connection). A tool bound to it runs again once they have; promote brings a demoted one back into your list.`,
    { connectionId: connection.id },
  );
}

/**
 * A revoke, announced to the sessions it changes: the core's `revokeConnection`, then
 * `tools/list_changed` to every agent the result names (ADR 0003: tool-list churn is a first-class
 * event), the way `promotePublished` (`promote.ts`) announces a publish. The core holds no
 * notifier, so the announcement lives here and `apps/server`'s revoke route calls this rather than
 * the service (GRA-69). What the next `tools/list` shows is decided elsewhere: the execute tool is
 * gone because `listToolsFor` (`tools.ts`) skips a revoked row, and the connection's promoted tools
 * are gone because the revoke deleted their entries (ADR 0009 as amended 2026-09-18).
 */
export async function revokeConnectionAndNotify(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: Pick<McpDeps, "connection">,
  notifier: Pick<ToolListChangedNotifier, "changed"> | undefined,
): Promise<RevokeConnectionResult | null> {
  const result = await revokeConnection(ctx, principal, connectionId, deps.connection);
  if (result) {
    for (const agentId of result.affectedAgentIds) notifier?.changed(agentId);
  }
  return result;
}
