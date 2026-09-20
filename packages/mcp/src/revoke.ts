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
 *
 * `alternatives` are the live connections of the same vendor in the agent's scope when there are
 * several (GRA-122): a tool follows one such connection only when it is the only one (`run.ts`), so
 * with two or more the refusal names them and the step is the person's — reconnect the revoked
 * row, or say which of the others the tool is for. They ride on the body as `alternatives` too.
 */
export function revokedConnectionRefusal(
  connection: ConnectionOutput,
  alternatives: readonly Pick<ConnectionOutput, "id" | "displayName">[] = [],
): Refusal {
  const revoked = `${connection.displayName} (${connection.vendor}) was revoked by the person, so nothing can run against it.`;
  if (alternatives.length === 0) {
    return refusal(
      "connection_revoked",
      `${revoked} Ask them to reconnect it in the console (Connections, then Re-enter or Reconnect on the connection). A tool bound to it runs again once they have; promote brings a demoted one back into your list.`,
      { connectionId: connection.id },
    );
  }
  const named = alternatives.map((other) => `${other.displayName} (${other.id})`).join(", ");
  return refusal(
    "connection_revoked",
    `${revoked} ${alternatives.length} other live ${connection.vendor} connections are in this agent's scope — ${named} — so the tool cannot follow one on its own; it does when there is exactly one. Ask the person either to reconnect ${connection.displayName} in the console (Connections, then Re-enter or Reconnect on the connection), or to say which of the others to use, and acquire against that one authors the tool there.`,
    {
      connectionId: connection.id,
      alternatives: alternatives.map((other) => ({
        connectionId: other.id,
        displayName: other.displayName,
      })),
    },
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
