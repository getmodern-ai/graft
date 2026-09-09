import { type AgentScope, requireAgent, type ServiceContext } from "@graft/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { SessionContext } from "./context";
import type { McpDeps } from "./deps";
import type { ToolListChangedNotifier } from "./notifier";
import { argumentsOf } from "./result";
import { draftsDir } from "./sandbox";
import { callToolFor, listToolsFor } from "./tools";

/**
 * One agent's MCP session: an SDK `Server` whose handlers are closed over the agent (ADR 0007: the
 * bearer token resolves to its agent at the door and nothing downstream reads a token again), and
 * which announces the agent's working-set changes through the notifier for as long as it lives.
 *
 * The low-level `Server` rather than `McpServer`, deliberately: the high-level class registers tools
 * one by one with Zod shapes and owns the list-changed notification itself, while this list is a
 * database read per `tools/list` — meta-tools plus whatever is promoted right now, each with a JSON
 * Schema the toolbox stores — and the notification is rate-limited per agent across sessions
 * (`notifier.ts`). The SDK marks `Server` as the advanced path; this is that path.
 */

export const SERVER_INFO = { name: "graft", version: "0.1.0" } as const;

/** What the harness may show its model about this server; short, because it rides every session. */
export const SERVER_INSTRUCTIONS =
  "Graft: your tool list is your working set — the tools currently promoted for you, each callable directly. " +
  "When no tool covers a task, find_tool searches your toolbox (demoted tools included) and promote brings one back; " +
  "acquire has Graft author a new tool against one of your connections. The list changes when the working set does; re-fetch it on notifications/tools/list_changed.";

export type AgentSession = {
  server: Server;
  scope: AgentScope;
  close: () => Promise<void>;
};

/** The door for a bearer token: resolves the agent or throws `UNAUTHORIZED` (`ServiceError`). */
export async function openAgentSession(
  deps: McpDeps,
  token: string | null | undefined,
  notifier: ToolListChangedNotifier,
): Promise<AgentSession> {
  const ctx: ServiceContext = { db: deps.db };
  const scope = await requireAgent(ctx, token, deps.agent);
  return createAgentSession(deps, scope, notifier);
}

/** A session for an agent already resolved — the HTTP layer resolves once and reuses across requests. */
export function createAgentSession(
  deps: McpDeps,
  scope: AgentScope,
  notifier: ToolListChangedNotifier,
): AgentSession {
  const session: SessionContext = {
    deps,
    scope,
    principal: { personId: scope.personId },
    ctx: { db: deps.db },
    notifier,
    drafts: draftsDir(scope.agentId),
  };

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: true } },
    instructions: SERVER_INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listToolsFor(session),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callToolFor(session, request.params.name, argumentsOf(request.params.arguments)),
  );

  const detach = notifier.attach(scope.agentId, () => server.sendToolListChanged());
  server.onclose = detach;

  return {
    server,
    scope,
    close: async () => {
      detach();
      await server.close();
    },
  };
}
