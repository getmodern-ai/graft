import { readAskCardHtml } from "@graft/ask-card";
import { type AgentScope, requireAgent, type ServiceContext } from "@graft/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ElicitForm } from "./approval";
import { ASK_CARD_MIME_TYPE, ASK_CARD_RESOURCE, ASK_CARD_RESOURCE_URI } from "./ask-card";
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

/**
 * The playbook a client that loads no skill reads (GRA-54): the `instructions` field of the
 * `initialize` result, which Claude.ai, ChatGPT and a bare MCP client show their model, and which
 * a harness with the Hermes skill installed reads beside it. It carries the order of operations,
 * the handoff rule, the secrets rule, `run_tool` for a client that snapshots its list and where its
 * input schema is read (GRA-78), and the approval grain (ADR 0003, ADR 0006, ADR 0008 as amended);
 * the long form of each is the tool's own description in `tools/`. Held under `INSTRUCTIONS_BUDGET`
 * because some clients truncate the field, and pinned sentence for sentence to
 * `skills/hermes-graft/SKILL.md` by `session.test.ts`, so the skill and the handshake cannot
 * disagree on a rule. Graft's vocabulary, sentence case, no em dashes, no exclamation marks.
 */
export const SERVER_INSTRUCTIONS = [
  "Graft extends your tool list with your working set: the authored tools promoted for you, callable as vendor__name, plus these fixed ones.",
  "When a task has no tool, work in this order. Call find_tool first: a match may exist and be demoted. If one does, promote it; it is in your list at once, no authoring needed. If the vendor has no connection in your scope, call request_connection. Call acquire only when nothing fits, with the connection id and a goal. It answers a jobId at once: poll acquire_status and relay the newest progress line in one sentence, only when it changed. Do not start a second acquire for the same goal, and do not drive the authoring tools (read_web_page, write_file, check_tool, publish_tool) or an execute__ tool unless the person asked you to author by hand; they build tools and do not answer the person.",
  "Any answer with a url and an awaiting_ word (approval, connection, credential) is a handoff: the next step is the person's, in the console. Send them the link exactly as returned, say what it is for, then wait; when they say it is done, call the same tool again with the same arguments. Never ask the person for an API key, a password or a token in chat, whatever the vendor calls it. The console is where secrets go; you never see one.",
  "Some clients snapshot the tool list per conversation, so a tool just promoted or acquired may not be in yours: run_tool { vendor, name, input } calls it by name. The acquire result and find_tool carry the tool's inputSchema for run_tool. Re-fetch on notifications/tools/list_changed.",
  "Approvals are the person's. A read-only tool never asks. Any other tool asks once, and the answer holds, a destructive tool too; the person can set a tool to ask every time in the console. acquire asks once per agent per connection.",
].join("\n\n");

/** How long `SERVER_INSTRUCTIONS` may be; some clients truncate the field, so the long form lives in the descriptions. */
export const INSTRUCTIONS_BUDGET = 1_800;

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

/**
 * The client's form elicitation, once `initialize` has said it has one — null otherwise, and the
 * ask goes through a handoff instead (ADR 0006: elicitation is layered on top, for approvals only,
 * where the client supports it). The SDK normalises a bare `elicitation: {}` to form support.
 */
function elicitFormOf(server: Server): ElicitForm | null {
  if (!server.getClientCapabilities()?.elicitation?.form) return null;
  return (params) => server.elicitInput({ ...params, mode: "form" });
}

/** A session for an agent already resolved — the HTTP layer resolves once and reuses across requests. */
export function createAgentSession(
  deps: McpDeps,
  scope: AgentScope,
  notifier: ToolListChangedNotifier,
): AgentSession {
  const server = new Server(SERVER_INFO, {
    // `resources` for the one ask card page a host fetches by `ui://` URI (GRA-84; `ask-card.ts`).
    capabilities: { tools: { listChanged: true }, resources: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  const session: SessionContext = {
    deps,
    scope,
    principal: { personId: scope.personId },
    ctx: { db: deps.db },
    notifier,
    drafts: draftsDir(scope.agentId),
    channel: { elicit: () => elicitFormOf(server) },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listToolsFor(session),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callToolFor(session, request.params.name, argumentsOf(request.params.arguments)),
  );

  /**
   * The ask card (GRA-84): one resource, listed for every agent and read as the built page. The
   * same bytes for every deployment and every agent — nothing about the person or the ask is in
   * the page; the card learns both from the tool result the host hands it — so no scope is read
   * here. A URI this server never listed is `InvalidParams`, the SDK's own word for it.
   */
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [ASK_CARD_RESOURCE],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== ASK_CARD_RESOURCE_URI) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    const text = await (deps.askCardHtml ?? readAskCardHtml)();
    return { contents: [{ uri, mimeType: ASK_CARD_MIME_TYPE, text }] };
  });

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
