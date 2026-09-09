import type { AgentScope, Principal, ServiceContext } from "@graft/core";

import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";

/**
 * What every tool handler is handed for one agent's session: the deps, the agent (as the scope every
 * agent-scoped service takes and the principal every person-scoped one takes — both from the one
 * `requireAgent` at the door, ADR 0007), the notifier that announces working-set changes, and the
 * agent's drafts directory on the toolbox.
 */
export type SessionContext = {
  deps: McpDeps;
  scope: AgentScope;
  principal: Principal;
  ctx: ServiceContext;
  notifier: ToolListChangedNotifier;
  drafts: string;
};
