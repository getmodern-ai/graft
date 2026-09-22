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
import {
  ASK_CARD_MIME_TYPE,
  ASK_CARD_RESOURCE,
  ASK_CARD_RESOURCE_URI,
  UI_EXTENSION_ID,
} from "./ask-card";
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
 * a harness with the Hermes skill installed reads beside it. **Every rule of conduct lives here and
 * nowhere else on the wire** (GRA-111): the order of operations, the handoff rule, the secrets rule,
 * the keyless and rotation rules, the build approval on the connection page, `run_tool` for a
 * client that snapshots its list and where its input schema is read (GRA-78), the approval grain
 * (ADR 0003, ADR 0006, ADR 0008 as amended), whose tool `answer_ask` is, and what `cardShown: true`
 * on an awaiting answer means (GRA-120: the ask is on a card in the conversation, so the url is
 * for a person who cannot see it). The tool descriptions
 * in `tools/` describe capabilities and carry no rule, because ChatGPT's classifier flagged
 * rule-bearing descriptions as a "Suspicious Instruction" on every call (GRA-111), and both hosts'
 * published guidance says the same: OpenAI puts "required tool sequences" in `instructions`,
 * Anthropic's review criteria say "Describe what the tool does. Do not tell Claude how to behave."
 * Held under `INSTRUCTIONS_BUDGET`, with the order of operations and the handoff rule in the first
 * 512 characters (OpenAI's front-loading rule), and pinned sentence for sentence to
 * `skills/hermes-graft/SKILL.md` by `session.test.ts`, so the skill and the handshake cannot
 * disagree on a rule. Graft's vocabulary, sentence case, no em dashes, no exclamation marks.
 *
 * The budget is spent to the last few characters, so a clause added here is paid for by
 * tightening another: GRA-190's blob rule cost the facts the descriptions already carry (that
 * `acquire` waits for the job and `acquire_status` for news, the four authoring tools' names, which
 * `ADVANCED_WHEN` opens each of them with) and "from Graft" in the opener, said by the handshake
 * itself. Measure with `SERVER_INSTRUCTIONS.length` before adding a word.
 */

/**
 * The one rule of conduct about a blob (GRA-190; ADR 0023), said in the same words by the Hermes
 * skill: a file crosses from one tool to the next as the ref, and the producing tool runs first so
 * the consuming tool's `acquire` has a real ref for its dry run rather than the fixture the job
 * mints without one (`acquire/job.ts`). The reason is the skill's and `acquire`'s description's;
 * here the rule alone, for the budget.
 */
export const BLOB_RULE =
  "A file moves between tools as a blob:// ref in one result and the next input, never as content; run the producing tool before acquiring the consuming one.";

export const SERVER_INSTRUCTIONS = [
  "Your working set: authored tools promoted for you as vendor__name, and the fixed ones.",
  "When a task has no tool, work in this order. Call find_tool first: a demoted match may exist; promote it, no authoring needed. No vendor connection in your scope: call request_connection. Call acquire only when nothing fits; while it runs, poll acquire_status and relay the newest progress line in a sentence. Do not start a second acquire for the same goal. There is no route to a vendor except through a Graft tool. Do not drive the authoring tools or execute__ tools unless the person asked you to author by hand.",
  "An answer with a url and an awaiting_ word (approval, connection, credential, scope) is a handoff: the next step is the person's, in the console. Send the link exactly as returned, then wait; when they say so, call the same tool again with the same arguments. If cardShown is true the ask is on a card in this conversation: relay the url only if they say they cannot see it. Never ask the person for an API key, a password or a token in chat, by any name. The console is where secrets go; you never see one. Never propose a made-up key for a vendor that documents none. A rotated or expired credential is request_credential on the existing connection, never a new one. The connection page offers the build approval, on by default; left on, acquire starts without a second link, so do not tell the person to expect one.",
  // The blob rule (GRA-190; ADR 0023) rides with run_tool's paragraph, since both are about what a
  // tool's result and the next call's input carry. The facts behind it (the `blobs` list, the
  // door's three refusals, the fixture) are the descriptions' (`tools/meta.ts`, `blobs.ts`).
  `Some clients snapshot the tool list per conversation: run_tool { vendor, name, input } calls it by name. The acquire result and find_tool carry the tool's inputSchema for run_tool. Re-fetch on notifications/tools/list_changed. ${BLOB_RULE}`,
  "A read-only tool never asks. Any other tool asks once, and the answer holds, a destructive tool too; the person can set a tool to ask every time. acquire asks once per agent per connection. answer_ask is the ask card's, not yours.",
].join("\n\n");

/**
 * How long `SERVER_INSTRUCTIONS` may be, and how long any one tool description may be: Claude Code
 * caps both at 2KB per server (its CHANGELOG, 2.1.84: "MCP tool descriptions and server
 * instructions are now capped at 2KB"), the one documented cap; ChatGPT and Claude.ai publish none.
 * GRA-54's 1,800 was a guess under it; the research on GRA-111 is the source for this figure.
 */
export const INSTRUCTIONS_BUDGET = 2_048;

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

/**
 * Whether the client's `initialize` declared the MCP Apps extension (`extensions` is the SDK's
 * open record of extension ids). ChatGPT declares it; Claude.ai web renders apps without
 * declaring it, which is why the card's tool pointers are unconditional. **An observation, not a
 * signal**: it rides every tool call's wide event so an operator can see which clients declare it
 * (`ToolCallEvent.uiExtensionDeclared`), and the card gate admits nobody on it, because a client
 * writes its own handshake (ADR 0006 as amended 2026-09-21, GRA-150; `card-client.ts`).
 */
function uiExtensionDeclared(server: Server): boolean {
  const extensions = server.getClientCapabilities()?.extensions;
  return extensions !== undefined && UI_EXTENSION_ID in extensions;
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
    uiExtensionDeclared: () => uiExtensionDeclared(server),
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
