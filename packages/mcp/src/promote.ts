import { type AgentScope, promoteTool, type ServiceContext } from "@graft/core";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";

/**
 * The end of a publish, for the agent that asked: the tool goes into the working set with cause
 * `publish` (ADR 0003, ADR 0009: expansion has an author) and `tools/list_changed` fires when that
 * changed anything. One function so `publish_tool` (`tools/authoring.ts`) and `acquire`'s job
 * (`acquire/job.ts`) cannot drift on the cause or on when the harness is told.
 */
export async function promotePublished(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: Pick<McpDeps, "workingSet">,
  notifier: Pick<ToolListChangedNotifier, "changed"> | undefined,
): Promise<{ changed: boolean }> {
  const change = await promoteTool(ctx, scope, toolId, "publish", deps.workingSet);
  if (change.changed) notifier?.changed(scope.agentId);
  return { changed: change.changed };
}
