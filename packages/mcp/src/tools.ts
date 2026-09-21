import {
  getAgentScope,
  getToolByName,
  isPromoted,
  listConnections,
  listWorkingSet,
  ServiceError,
} from "@graft/core";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ASK_CARD_TOOL_META } from "./ask-card";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from "./bounds";
import { agentDrivesByHand, hiddenToolRefusal } from "./by-hand";
import { toolAskResult } from "./card-client";
import type { SessionContext } from "./context";
import type { ToolCallEvent } from "./deps";
import { toolError, toolRefusal, toolResult } from "./result";
import { runAuthoredTool } from "./run";
import { authoredToolName, parseAuthoredToolName, parseExecuteToolName } from "./tool-names";
import { AUTHORING_TOOLS } from "./tools/authoring";
import { callExecuteTool, executeToolDefinition } from "./tools/execute";
import { queryWords } from "./tools/find-tool.match";
import { META_TOOLS, type MetaTool } from "./tools/meta";

/**
 * The tool list and the dispatch — ADR 0003 made concrete: the fixed meta-tools, the execute tool
 * of every connection in the agent's scope, and **exactly the authored tools promoted for this
 * agent**, each as a first-class tool carrying the schema the toolbox stores and the annotations the
 * check derived (ADR 0008: `readOnlyHint` and `destructiveHint` come from the row, never from
 * anything the model declared).
 */

const FIXED_TOOLS: readonly MetaTool[] = [...META_TOOLS, ...AUTHORING_TOOLS];
const FIXED_BY_NAME = new Map(FIXED_TOOLS.map((tool) => [tool.definition.name, tool]));
/** The authoring set by name — what a chat product's agent neither lists nor calls (`by-hand.ts`). */
const AUTHORING_BY_NAME = new Set(AUTHORING_TOOLS.map((tool) => tool.definition.name));

/** The names every agent's list carries whatever its working set holds. */
export const META_TOOL_NAMES: readonly string[] = FIXED_TOOLS.map((tool) => tool.definition.name);

/**
 * An authored tool as the harness sees it: the row's prose, schema and derived annotations, and
 * the ask card's resource (GRA-116): a write's first call answers `awaiting_approval` with the tool
 * ask's card, and a host renders a card only for a tool whose definition names the resource — so
 * every tool that can ask carries it, the card drawing nothing for a result that is not an ask.
 */
export function authoredToolDefinition(tool: AuthoredToolRow): Tool {
  return {
    name: authoredToolName(tool.vendor, tool.name),
    description: tool.description,
    // Stored as `type: "object"` — the tool service refuses anything else at create.
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
    _meta: ASK_CARD_TOOL_META,
  };
}

export async function listToolsFor(session: SessionContext): Promise<Tool[]> {
  const { ctx, principal, scope, deps } = session;
  const [scopeIds, connections, workingSet, byHand] = await Promise.all([
    getAgentScope(ctx, scope, deps.agent),
    listConnections(ctx, principal, deps.connection),
    listWorkingSet(ctx, scope, deps.workingSet),
    agentDrivesByHand(session),
  ]);
  const inScope = new Set(scopeIds);
  // A chat product's agent lists the meta-tools and its promoted tools alone (GRA-125): the
  // authoring set and the execute__ tools are for an agent driven by hand (`by-hand.ts`).
  return [
    ...(byHand ? FIXED_TOOLS : META_TOOLS).map((tool) => tool.definition),
    // A revoked connection has no execute tool: nothing can run against it until the person
    // reconnects it, which clears `revokedAt` and puts the tool back by itself (ADR 0007; GRA-69).
    // The scope grant stays, so reconnection needs no second step in the console.
    ...(byHand
      ? connections
          .filter((connection) => inScope.has(connection.id) && connection.revokedAt === null)
          .map((connection) => executeToolDefinition(connection))
      : []),
    ...workingSet.map((entry) => authoredToolDefinition(entry.tool)),
  ];
}

/**
 * One call. A fixed tool by name; an execute tool by its connection; otherwise a first-class
 * authored tool, which must be promoted for this agent — a tool in the toolbox but not in the list is
 * reached through `run_tool`, not by a name the harness was never shown. A `ServiceError` a service
 * threw becomes a refusal the model can read; anything else is logged and answered without its
 * message, because a message from a dependency might carry anything.
 */
export async function callToolFor(
  session: SessionContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const result = await answer(session, name, args);
  // The hook sees every answer, an unknown tool's `McpError` excepted — that one never reached a tool.
  session.deps.onToolCall?.(toolCallEvent(session, name, result, Date.now() - startedAt, args));
  return result;
}

async function answer(
  session: SessionContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return await dispatch(session, name, args);
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof ServiceError) {
      return toolRefusal(error.code.toLowerCase(), error.message, error.details ?? {});
    }
    console.error(`mcp: ${name} failed`, error);
    return toolError({
      error: "internal",
      message: `Something went wrong running ${name}. Try again, and say so if it repeats.`,
    });
  }
}

/**
 * The call as `McpDeps.onToolCall` is told it (`deps.ts`): the answer's `isError` and refusal shape
 * read back, and for the tools `eventDetail` names, what the call was about.
 */
export function toolCallEvent(
  session: Pick<SessionContext, "scope" | "uiExtensionDeclared">,
  name: string,
  result: CallToolResult,
  latencyMs: number,
  args: Record<string, unknown> = {},
): ToolCallEvent {
  const kind = FIXED_BY_NAME.has(name)
    ? "meta"
    : parseExecuteToolName(name)
      ? "execute"
      : "authored";
  const body = result.structuredContent;
  const refused = result.isError === true && body?.error === "refused";
  const detail = eventDetail(name, args, body ?? {});
  return {
    tool: name,
    kind,
    agentId: session.scope.agentId,
    personId: session.scope.personId,
    outcome: result.isError === true ? (refused ? "refused" : "error") : "ok",
    ...(refused && typeof body?.reason === "string" ? { reason: body.reason } : {}),
    latencyMs,
    ...(detail ? { detail } : {}),
    // Observed, never trusted: the gate reads the client's callback host (GRA-150, `deps.ts`).
    uiExtensionDeclared: session.uiExtensionDeclared(),
  };
}

type EventDetail = NonNullable<ToolCallEvent["detail"]>;

/**
 * Per tool, what the wide event may say of the call beyond its outcome (GRA-155) — read from the
 * arguments and the answer, never the person's data: `find_tool`'s query is counted in words and
 * not copied, everything else is a count, an id or a name. A `find_tool`
 * that answered `ok` with no hit and an `acquire` that built a copy were the same line in the log
 * until this.
 */
export function eventDetail(
  name: string,
  args: Record<string, unknown>,
  body: Record<string, unknown>,
): EventDetail | undefined {
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  switch (name) {
    case "find_tool": {
      // The query's size, never its text: an agent's search words can carry the person's names
      // and ids (Greptile on #122), and the wide event carries no person-typed content.
      const query = str(args.query);
      const hits = Array.isArray(body.tools) ? body.tools.length : undefined;
      return {
        ...(query ? { queryWords: queryWords(query).length } : {}),
        ...(hits !== undefined ? { hits } : {}),
      };
    }
    case "acquire": {
      const goal = str(args.goal);
      const jobId = str(body.jobId);
      return {
        ...(goal ? { goalLength: goal.length } : {}),
        similarOffered: body.reason === "similar_tools_exist",
        ...(jobId ? { jobId } : {}),
      };
    }
    case "acquire_status": {
      const jobId = str(args.jobId) ?? str(body.jobId);
      const status = str(body.status);
      return { ...(jobId ? { jobId } : {}), ...(status ? { status } : {}) };
    }
    case "run_tool": {
      const vendor = str(args.vendor);
      const tool = str(args.name);
      return vendor && tool ? { tool: authoredToolName(vendor, tool) } : undefined;
    }
    default:
      return undefined;
  }
}

async function dispatch(
  session: SessionContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const fixed = FIXED_BY_NAME.get(name);
  if (fixed) {
    // Hidden from a chat product's agent, and refused when called anyway (GRA-125; `by-hand.ts`).
    if (AUTHORING_BY_NAME.has(name) && !(await agentDrivesByHand(session))) {
      return hiddenToolRefusal(name);
    }
    return fixed.handle(args, session);
  }

  const connectionId = parseExecuteToolName(name);
  if (connectionId) {
    if (!(await agentDrivesByHand(session))) return hiddenToolRefusal(name);
    const scopeIds = await getAgentScope(session.ctx, session.scope, session.deps.agent);
    return callExecuteTool(session, connectionId, scopeIds, args);
  }

  const key = parseAuthoredToolName(name);
  if (key) {
    const { ctx, principal, scope, deps } = session;
    const tool = await getToolByName(ctx, principal, key, deps.tool);
    if (tool && (await isPromoted(ctx, scope, tool.id, deps.workingSet))) {
      const run = await runAuthoredTool(deps, scope, {
        vendor: key.vendor,
        name: key.name,
        input: args,
        mode: { detached: false, timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS, dryRun: false },
        channel: session.channel,
      });
      return run.isError ? toolAskResult(session, run) : toolResult(run.answer);
    }
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Unknown tool: ${name}. find_tool searches the toolbox; run_tool runs a tool that is not in your list.`,
  );
}
