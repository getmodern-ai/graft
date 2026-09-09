import type { AgentScope, Principal, ServiceContext } from "@graft/core";

import type { AskChannel } from "./approval";
import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";

/**
 * What every tool handler is handed for one agent's session: the deps, the agent (as the scope every
 * agent-scoped service takes and the principal every person-scoped one takes — both from the one
 * `requireAgent` at the door, ADR 0007), the notifier that announces working-set changes, the
 * agent's drafts directory on the toolbox, and the channel an approval reaches the person through
 * (`approval.ts`, ADR 0006).
 */
export type SessionContext = {
  deps: McpDeps;
  scope: AgentScope;
  principal: Principal;
  ctx: ServiceContext;
  notifier: ToolListChangedNotifier;
  drafts: string;
  channel: AskChannel;
};
