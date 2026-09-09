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

import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from "./bounds";
import type { SessionContext } from "./context";
import { toolError, toolRefusal, toolResult } from "./result";
import { runAuthoredTool } from "./run";
import { authoredToolName, parseAuthoredToolName, parseExecuteToolName } from "./tool-names";
import { AUTHORING_TOOLS } from "./tools/authoring";
import { callExecuteTool, executeToolDefinition } from "./tools/execute";
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

/** The names every agent's list carries whatever its working set holds. */
export const META_TOOL_NAMES: readonly string[] = FIXED_TOOLS.map((tool) => tool.definition.name);

/** An authored tool as the harness sees it: the row's prose, schema and derived annotations. */
export function authoredToolDefinition(tool: AuthoredToolRow): Tool {
  return {
    name: authoredToolName(tool.vendor, tool.name),
    description: tool.description,
    // Stored as `type: "object"` — the tool service refuses anything else at create.
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive },
  };
}

export async function listToolsFor(session: SessionContext): Promise<Tool[]> {
  const { ctx, principal, scope, deps } = session;
  const [scopeIds, connections, workingSet] = await Promise.all([
    getAgentScope(ctx, scope, deps.agent),
    listConnections(ctx, principal, deps.connection),
    listWorkingSet(ctx, scope, deps.workingSet),
  ]);
  const inScope = new Set(scopeIds);
  return [
    ...FIXED_TOOLS.map((tool) => tool.definition),
    ...connections
      .filter((connection) => inScope.has(connection.id))
      .map((connection) => executeToolDefinition(connection)),
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

async function dispatch(
  session: SessionContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const fixed = FIXED_BY_NAME.get(name);
  if (fixed) return fixed.handle(args, session);

  const connectionId = parseExecuteToolName(name);
  if (connectionId) {
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
      return run.isError ? toolError(run.answer) : toolResult(run.answer);
    }
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Unknown tool: ${name}. find_tool searches the toolbox; run_tool runs a tool that is not in your list.`,
  );
}
