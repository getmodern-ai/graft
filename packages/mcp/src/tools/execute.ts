import { type ConnectionOutput, recordUsage } from "@graft/core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_OUTPUT_CHARS,
  readCommandInput,
} from "../bounds";
import type { SessionContext } from "../context";
import { toolError, toolRefusal, toolResult } from "../result";
import { runWithCapability } from "../run";
import { openAgentSandbox, runCommand, withSandbox } from "../sandbox";
import { executeToolName } from "../tool-names";
import { commandTimingProperties, detachedAdvice } from "./authoring";

/**
 * A connection's **execute tool** — `execute__<connectionId>`, one per connection in the agent's
 * scope (CONTEXT.md, *Scope*): a shell command in the agent's sandbox with a capability token for
 * that one connection in the process environment, so code the agent has not published yet can reach
 * the vendor through the proxy (ADR 0010). It is the raw form of an authored tool's run, and `run.ts`
 * is where the two share their mint-run-tally sequence.
 *
 * The token's `tool` claim is `execute`, so the proxy's wide event says what kind of exec made the
 * call. `dryRun: true` mints the dry-run claim and otherwise runs the command as it is: the claim is
 * the whole guarantee — the proxy forwards `GET`/`HEAD` and stops every other method with a preview
 * — so nothing here inspects what the command does.
 */

export const EXECUTE_CLAIM = "execute";

export function executeToolDefinition(connection: ConnectionOutput): Tool {
  const label = connection.displayName || connection.vendor;
  return {
    name: executeToolName(connection.id),
    description:
      `Run code against ${label} (${connection.vendor}): a shell command in your sandbox that can call ${label} through the proxy with this connection's credential injected. Nothing else is granted. ` +
      `The process has GRAFT_PROXY_URL, GRAFT_CONNECTION and GRAFT_TOKEN set: a module run as \`echo '{}' | node /graft/runner.mjs <module directory or index.ts>\` reaches ${label} through ctx.fetch('/<vendor path>'). A module you will publish must use ctx alone: the runner removes every GRAFT_* variable before the module loads, and check_tool refuses one that names them. Never write the vendor's host or a key into code. ` +
      `Answers like run_command — the exit code and the output, cut to its last ${MAX_OUTPUT_CHARS} characters — and is killed after timeoutSeconds (default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}, at most ${MAX_COMMAND_TIMEOUT_SECONDS} when waiting). ` +
      `With dryRun: true the proxy makes GET and HEAD calls for real and stops every other method before it reaches ${label}, answering 202 with header x-graft-dry-run: intercepted and a JSON preview of the request that would have been sent. ` +
      detachedAdvice(),
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "A shell command, e.g. `echo '{\"limit\":5}' | node /graft/runner.mjs <module directory>`.",
        },
        ...commandTimingProperties(),
        dryRun: {
          type: "boolean",
          description: `Dry run (default false): GET and HEAD reach ${label} for real; every other method stops at the proxy with a 202 preview instead of being sent. Nothing changes at ${label}.`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

/**
 * One execute call: the arguments as `run_command` reads them, a token for this connection, the
 * command with the proxy's three variables in its environment, and a ledger line under the tool's
 * wire name (ADR 0012) — `ok` from the exit code, and a detached start counts as ok because the
 * capability was issued and the process runs.
 */
export async function callExecuteTool(
  session: SessionContext,
  connectionId: string,
  scopeIds: readonly string[],
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const { deps, scope, ctx } = session;
  if (!scopeIds.includes(connectionId)) {
    return toolRefusal(
      "connection_not_in_scope",
      `Connection ${connectionId} is not in this agent's scope. The person can add it in the console.`,
    );
  }
  const parsed = readCommandInput(args);
  if ("error" in parsed) return toolRefusal("input_invalid", parsed.error);
  const dryRun = args.dryRun === true;
  const startedAt = Date.now();

  const outcome = await runWithCapability({
    deps,
    scope,
    connectionId,
    claim: EXECUTE_CLAIM,
    mode: { detached: parsed.detached, timeoutSeconds: parsed.timeoutSeconds, dryRun },
    run: (env) =>
      withSandbox(
        () => openAgentSandbox(deps, scope),
        (handle) => runCommand(handle, parsed, env),
      ),
  });

  const refused = "error" in outcome && outcome.error === "refused";
  const failed = !refused && "error" in outcome;
  const ok = !refused && !failed && (!("exitCode" in outcome) || outcome.exitCode === 0);
  await recordUsage(
    ctx,
    scope,
    {
      toolName: executeToolName(connectionId),
      outcome: refused ? "refused" : ok ? "ok" : "error",
      dryRun,
      latencyMs: Date.now() - startedAt,
    },
    deps.ledger,
  );
  return refused || failed ? toolError(outcome as Record<string, unknown>) : toolResult(outcome);
}
