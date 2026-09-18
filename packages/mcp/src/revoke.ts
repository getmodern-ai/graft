import {
  type Principal,
  type RevokeConnectionResult,
  revokeConnection,
  type ServiceContext,
} from "@graft/core";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";

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
