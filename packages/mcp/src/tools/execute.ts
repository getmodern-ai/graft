import { type ConnectionOutput, getConnection, recordUsage } from "@graft/core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { requireBuildApproval } from "../approval";
import { ASK_CARD_TOOL_META } from "../ask-card";
import { recordBlobsWithinQuota, withRecordedBlobs } from "../blob-budget";
import { admitBlobs, blobRunEnvironment } from "../blob-door";
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MAX_OUTPUT_CHARS,
  readCommandInput,
} from "../bounds";
import { toolAskResult } from "../card-client";
import type { SessionContext } from "../context";
import { admitUnderGrant, heldInFlight } from "../in-flight";
import { type Refusal, toolError, toolRefusal, toolResult } from "../result";
import { revokedConnectionRefusal } from "../revoke";
import { runWithCapability } from "../run";
import {
  isPolledProcess,
  openAgentSandbox,
  type PolledProcess,
  runCommand,
  withSandbox,
} from "../sandbox";
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
 *
 * Every execute call, dry run included, needs the connection's **build approval** (`approval.ts`,
 * ADR 0008): code running against a connection at all is the moment reads of the person's data
 * begin, which is exactly what that approval is for. Once per agent per connection; `acquire`
 * (GRA-29) requires the same row.
 *
 * **The blob door stands here too** (GRA-200; ADR 0023, "1 GiB live per agent, refused at the door
 * as `blob_quota` before the run"). A command may run the runner, and a module the runner loads may
 * write a blob, so an execute call passes `admitBlobs` (`../blob-door.ts`) before the gate as a
 * `run_tool` does: an agent at its quota is refused `blob_quota` in this tool's own refusal shape
 * with a `refused` ledger row and no exec, and an admitted call hands the process
 * `GRAFT_BLOB_BUDGET_BYTES` and `GRAFT_BLOB_QUOTA_BYTES` and holds its grant on the in-flight
 * registry until the process settles, the detached one on its process name. The quota alone is
 * judged: the input is a shell command, not JSON the runner reads, so a ref inside it is the
 * runner's own `blob_not_found` to answer inside the run. The command's output is the caller's
 * too, so the ledger it prints is held to the store and the quota when it is recorded
 * (`../blob-budget.ts`).
 */

export const EXECUTE_CLAIM = "execute";

export function executeToolDefinition(connection: ConnectionOutput): Tool {
  const label = connection.displayName || connection.vendor;
  return {
    name: executeToolName(connection.id),
    description:
      `Advanced: runs code against ${label} (${connection.vendor}) by hand, for an agent the person asked to author a tool itself rather than through acquire. A shell command in the agent's sandbox that can call ${label} through the proxy with this connection's credential injected; nothing else is granted. ` +
      `The process has GRAFT_PROXY_URL, GRAFT_CONNECTION, GRAFT_TOKEN and GRAFT_RUNNER (the runner's path in this sandbox) set: a module run as \`echo '{}' | node "$GRAFT_RUNNER" <module directory or index.ts>\` reaches ${label} through ctx.fetch('/<vendor path>'). A module to be published uses ctx alone: the runner removes every GRAFT_* variable before the module loads, and check_tool refuses a module that names them or a literal vendor host. ` +
      `Answers like run_command, the exit code and the output cut to its last ${MAX_OUTPUT_CHARS} characters, and is killed after timeoutSeconds (default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}, at most ${MAX_COMMAND_TIMEOUT_SECONDS} when waiting). ` +
      `With dryRun: true the proxy makes GET and HEAD calls for real and stops every other method before it reaches ${label}, answering 202 with header x-graft-dry-run: intercepted and a JSON preview of the request that would have been sent. ` +
      "The first call against a connection may answer awaiting_approval with a url: a handoff whose next step is the person's, in the console; the same call, once they have answered, runs. " +
      "Marked destructive because the hint is the carried command's, which the host cannot know per call. " +
      detachedAdvice(),
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'A shell command, e.g. `echo \'{"limit":5}\' | node "$GRAFT_RUNNER" <module directory>`.',
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
    // As destructive as the command it carries, which a host cannot know per call (GRA-114).
    annotations: { readOnlyHint: false, destructiveHint: true },
    // The first call against a connection may answer the tool ask's card (GRA-116; `../tools.ts`).
    _meta: ASK_CARD_TOOL_META,
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
  // The list no longer carries this tool for a revoked row (`../tools.ts`); a client that snapshots
  // its list may still call it, and is told what happened rather than asked for a build approval on
  // a connection the person just revoked (GRA-69).
  const connection = await getConnection(ctx, session.principal, connectionId, deps.connection);
  if (connection?.revokedAt) return toolError(revokedConnectionRefusal(connection));
  const parsed = readCommandInput(args);
  if ("error" in parsed) return toolRefusal("input_invalid", parsed.error);
  const dryRun = args.dryRun === true;
  const startedAt = Date.now();
  const record = (outcome: "ok" | "error" | "refused") =>
    recordUsage(
      ctx,
      scope,
      {
        toolName: executeToolName(connectionId),
        outcome,
        dryRun,
        latencyMs: Date.now() - startedAt,
      },
      deps.ledger,
    );

  // The blob door (GRA-200; the header): a by-hand agent is under the same quota as a `run_tool`,
  // judged before the gate asks anyone and before a sandbox is touched (ADR 0023). The command is
  // not JSON the runner reads, so the quota alone is judged here.
  // Admitted and granted as one step (`admitUnderGrant`, `in-flight.ts`; Greptile on #157): a
  // second call of this agent's admitted while this one runs is handed the remainder after this
  // one's. Outstanding until the process settles: released in `finally` whatever happens below, and
  // carried on the process name past that for a detached start, which `heldInFlight` tracks with
  // the same figure before this release runs.
  const door = await admitUnderGrant(deps.inFlight, scope.agentId, () =>
    admitBlobs(deps, scope, null),
  );
  if (!door.ok) {
    await record("refused");
    return toolError(door.refusal);
  }
  const admitted = door.admission;
  try {
    const gate = await requireBuildApproval(ctx, scope, connectionId, deps, session.channel);
    if (!gate.pass) {
      await record("refused");
      return toolAskResult(session, gate);
    }

    // In flight for the call, and by process name after a detached start (ADR 0009; `in-flight.ts`).
    const ran: PolledProcess | { error: string } | Refusal = await heldInFlight(
      deps.inFlight,
      scope.agentId,
      () =>
        runWithCapability({
          deps,
          scope,
          connectionId,
          claim: EXECUTE_CLAIM,
          mode: { detached: parsed.detached, timeoutSeconds: parsed.timeoutSeconds, dryRun },
          run: (env) =>
            withSandbox(
              () => openAgentSandbox(deps, scope),
              // The agent for a sidecar and what the process may still commit under the agent's
              // quota, beside the token (the header; `../blob-door.ts`'s `blobRunEnvironment`).
              // Advice on this path, since the command is the caller's and may replace a variable:
              // the record below is the rule.
              (handle) =>
                runCommand(handle, parsed, { ...env, ...blobRunEnvironment(scope, admitted) }),
            ),
        }),
      admitted.budgetBytes,
    );
    // A runner the command invoked wrote these blobs (GRA-186; `../blobs.ts`): their rows land here,
    // as a detached run's land at the poll, with no version since the command names none. The
    // envelope is the command's own output and nothing in it is evidence (`../blob-budget.ts`;
    // ADR 0023; Greptile on #157): the ledger's ids are measured against the store and the rows,
    // the quota is judged over what was measured, and the answer names what was recorded.
    const polled = isPolledProcess(ran) ? ran : null;
    const outcome: Record<string, unknown> = polled
      ? withRecordedBlobs(
          polled.answer,
          await recordBlobsWithinQuota(deps, scope, null, polled.blobs, polled.dropped),
        )
      : ran;

    const refused = "error" in outcome && outcome.error === "refused";
    const failed = !refused && "error" in outcome;
    const ok = !refused && !failed && (!("exitCode" in outcome) || outcome.exitCode === 0);
    await record(refused ? "refused" : ok ? "ok" : "error");
    return refused || failed ? toolError(outcome) : toolResult(outcome);
  } finally {
    door.release();
  }
}
