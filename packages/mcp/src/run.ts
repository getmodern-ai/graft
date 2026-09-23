import { randomUUID } from "node:crypto";
import type { AskCard } from "@graft/ask-card/shape";
import {
  type AgentScope,
  type ConnectionOutput,
  getAgentScope,
  getConnection,
  getToolByName,
  getToolVersion,
  isConnectionUsable,
  listConnections,
  type Principal,
  rebindToolIfConnectionDead,
  recordDryRun,
  recordUsage,
  type ServiceContext,
  ServiceError,
  touchToolUsed,
} from "@graft/core";
import type { UsageOutcome } from "@graft/db/schema/usage";
import {
  type BlobLedgerEntry,
  EXIT_TIMEOUT,
  EXIT_USAGE,
  MODULE_ENTRIES,
  readRunnerEnvelope,
} from "@graft/runner";
import type { SandboxHandle, SandboxProcessResult } from "@graft/sandbox";
import { MAX_CAPABILITY_TOKEN_TTL_SECONDS, mintCapabilityToken } from "@graft/token";
import { sandboxPath } from "@graft/toolbox";
import { type AskChannel, gateToolCall } from "./approval";
import { blobQuotaOvershoot, recordBlobsWithinQuota } from "./blob-budget";
import { admitBlobs, blobAgentEnvironment, blobRunEnvironment } from "./blob-door";
import { blobsOnWire, withBlobs } from "./blobs";
import { boundResult } from "./bounds";
import type { McpDeps } from "./deps";
import { admitUnderGrant, detachedHoldMs, heldInFlight } from "./in-flight";
import { type Refusal, refusal } from "./result";
import { revokedConnectionRefusal } from "./revoke";
import {
  commandEnvironment,
  type DetachedStart,
  describeDetachedStart,
  errorMessage,
  openAgentSandbox,
  RUN_SCRATCH_DIR,
  remountToolbox,
  runnerPathIn,
  seededRunnerPath,
  startDetached,
} from "./sandbox";
import { compileInputSchema } from "./schema";
import { authoredToolName } from "./tool-names";

/**
 * Running an authored tool for an agent — the path a first-class call and `run_tool` share (ADR
 * 0003: `run_tool` exists for the turn a tool was just published in, and runs exactly what the
 * first-class tool runs).
 *
 * In order: the tool and its current version — or the version the caller names, for `acquire`'s
 * dry run of one not yet activated — from the person's toolbox (ADR 0007); the connection — the
 * tool's default, or the one the caller names (`acquire`'s dry run names the job's, GRA-122) —
 * which must be in the agent's scope — the scope is where the security property lives, and a tool
 * bound to a connection the agent was never given is refused here, before any token exists; the
 * input against the stored schema; then **mint, run, tally** in that order — the
 * capability token first, so an unconfigured deployment answers without provisioning anything; the
 * runner over the version directory the pointer names, with the token in the process environment
 * and nowhere else (ADR 0010); then `last_used_at` and the ledger row, whatever the run said
 * (ADR 0009: every invocation moves the clock; ADR 0012: every outcome is recorded). The approval
 * gate (`approval.ts`, ADR 0008) sits between the scope check and the mint, and nowhere else. The
 * whole call holds the agent in flight — the gate's wait included, so the sweep never demotes a tool
 * whose ask is open — and a detached start keeps the hold by process name (`in-flight.ts`), which
 * is what keeps the sweep off a tool while a turn is using it (ADR 0009).
 *
 * A run never reads the toolbox through a store: the sandbox sees the mounted volume, and the runner
 * loads the module from `/tools/<version path>` (ADR 0002's seam is what makes that true on every
 * backing). The vendor's answer, or the runner's failure, comes back verbatim (GRA-1, user story 37).
 *
 * **A tool whose default connection this agent cannot use follows the one live connection of its
 * vendor in the agent's scope** (GRA-122). An authored tool is bound to a vendor rather than a row
 * (CONTEXT.md, *Authored tool*), and the row it defaults to is the one it was authored against; when
 * the person revoked that row and connected the vendor again under a new one — a link provider's
 * second proposal used to make a new row beside the released one — every tool of the vendor
 * answered `connection_revoked` until re-authored, with no rebind anywhere. Now the connection a
 * run uses is resolved **per agent**: the default when this agent holds it live; otherwise — the
 * default revoked, or a live row another agent of the person's holds and this one was never given
 * (the tool row is the person's, the scopes are per agent, ADR 0007) — the one live, usable
 * connection of the tool's vendor in this agent's scope; with none, or with several, the refusal
 * stands and names the step (`revokedConnectionRefusal`, `notInScopeRefusal`). The row's default
 * is **rebound only when it is revoked** — dead for every agent, so moving it takes nothing from
 * anyone and the next call reads it directly — through `rebindToolIfConnectionDead`, which reads
 * the default's row locked and writes only if it is still dead, so a reconnection landing meanwhile
 * wins and the run goes to the reconnected row; a live default outside this agent's scope is
 * another agent's and stays, and this agent's calls resolve to its own row each time (Greptile on
 * #98). The
 * scope is read before the choice, so a live row the agent was never given is never followed; the
 * approval gate still sits after the choice, so a write asks on the connection it will run against
 * (ADR 0008). A caller that names the connection (`connectionId`) gets no following: it said which.
 *
 * **A blob the module wrote comes back on the runner's ledger, never through the model** (GRA-186;
 * ADR 0023). The runner prints an envelope, `{ result, blobs }`, and this file is where it is read
 * (`describeModuleRun`): the module's result goes on as it always did — bounded, wrapped as a
 * dry-run report, recorded — and the ledger becomes one `blob` row per line (`blobs.ts`) before
 * the answer carries the same list beside the result. `GRAFT_AGENT` (`blob-door.ts`'s
 * `blobAgentEnvironment`, on every capability run) and `GRAFT_TOOL_VERSION` go into the exec's
 * environment for the sidecar the runner writes, and `GRAFT_BLOBS_DIR` names the mount
 * (`commandEnvironment`); the runner deletes all three before the module loads.
 *
 * **A ref the input names is judged at the door, before a sandbox is touched** (GRA-187;
 * `blob-door.ts`). After the input is validated and before the approval gate, the agent's live
 * bytes are measured against the quota (`blob_quota`) and every `blob://` leaf of the input is
 * looked up under the person and the agent (`blob_not_found`, `blob_expired`), each a refusal in
 * the shape above with a `refused` ledger row. Reading a blob asks nothing (ADR 0008), and a dry
 * run passes the same door, so `acquire`'s job learns of a dead ref here rather than inside a run.
 * A run the door admits is handed what it may still commit, `GRAFT_BLOB_BUDGET_BYTES`, beside
 * `GRAFT_AGENT`; the runner refuses the write that would pass it as `blob_quota` as the bytes
 * stream in, so a module looping `ctx.blob.write` cannot commit past the quota inside one run
 * (Greptile on #145).
 */

/**
 * The exit code the run script uses for "nothing runnable at the module path", distinct from every
 * code the runner itself exits with (`0`, `1`, `2`, `64`) so the one recovery it triggers — mount the
 * toolbox again and retry once — never fires on a module that ran and failed. `66` is sysexits'
 * EX_NOINPUT, kept for the same meaning.
 */
export const EXIT_MODULE_MISSING = 66;

/**
 * Seconds a token outlives the run it was minted for. The kill bound is the backing's and the wait
 * outlasts it by a few seconds, so a vendor request in flight at the deadline still carries a valid
 * token. A minute rather than those few seconds because the costs are not symmetric: the slack is a
 * token nobody holds, no slack is a vendor 401 that reads as a broken credential.
 */
export const TOKEN_SLACK_SECONDS = 60;

/** How long a token lives for a run bounded at `timeoutSeconds`: the bound plus the slack, under the ceiling. */
export function tokenTtlFor(timeoutSeconds: number): number {
  return Math.min(MAX_CAPABILITY_TOKEN_TTL_SECONDS, timeoutSeconds + TOKEN_SLACK_SECONDS);
}

/** How one run is to go, as one value, so the token's life, the environment and the ledger agree. */
export type RunMode = { detached: boolean; timeoutSeconds: number; dryRun: boolean };

/** The runner's failure, in Cando's shape: the sentence, the code, the tail of stderr. */
export type RunFailure = { error: string; exitCode: number | null; stderrTail: string };

/** How much of stderr comes back. The end is where the useful part is. */
const STDERR_TAIL_BYTES = 4_000;
const STDERR_MARKER = "__GRAFT_STDERR__";

/**
 * Mint a capability token for one connection and run with it in the process environment — the
 * sequence an authored tool's run and an execute tool share, so the two cannot disagree about the
 * order or what the process is told. `claim` is the token's `tool`: the authored tool's wire name
 * for its run, `execute` for the execute tool.
 */
export async function runWithCapability<T>(args: {
  deps: McpDeps;
  scope: AgentScope;
  connectionId: string;
  claim: string;
  mode: RunMode;
  run: (env: Record<string, string>) => Promise<T>;
}): Promise<T | Refusal> {
  const { deps, scope, mode } = args;
  if (!deps.keys) {
    return refusal(
      "proxy_unconfigured",
      "This deployment has no capability token key pair, so nothing can reach a vendor from a sandbox yet. Say so rather than retrying.",
    );
  }
  let token: string;
  try {
    token = await mintCapabilityToken(
      {
        personId: scope.personId,
        agentId: scope.agentId,
        connectionIds: [args.connectionId],
        tool: args.claim,
        ttlSeconds: tokenTtlFor(mode.timeoutSeconds),
        ...(mode.dryRun ? { dryRun: true } : {}),
      },
      deps.keys,
      deps.now?.(),
    );
  } catch (error) {
    return refusal(
      "token_mint_failed",
      `Could not mint a capability token: ${errorMessage(error)}`,
    );
  }
  return args.run({
    ...commandEnvironment(mode.timeoutSeconds, await seededRunnerPath(deps)),
    GRAFT_PROXY_URL: deps.proxyPublicUrl,
    GRAFT_CONNECTION: args.connectionId,
    GRAFT_TOKEN: token,
    // The agent for the sidecar of any blob the run writes: on every capability run, since an
    // `execute__` command may invoke `$GRAFT_RUNNER` on a by-hand module (Greptile on #159).
    ...blobAgentEnvironment(scope),
    // The runner's own switch into dry-run mode; the claim on the token is what the proxy enforces.
    ...(mode.dryRun ? { GRAFT_DRY_RUN: "1" } : {}),
  });
}

export type ModuleRunOutcome =
  /**
   * The module's result, the blobs the run wrote (`[]` for a module that wrote none), and how
   * many ledger lines the reader refused (`RunnerEnvelope.dropped`; zero from this repository's runner).
   */
  | { ok: true; result: unknown; blobs: BlobLedgerEntry[]; blobsDropped: number }
  | { ok: true; detached: DetachedStart }
  /**
   * The runner's failure, and the blobs the module committed before it failed (GRA-187): a module
   * that writes and then throws has bytes on the mount, and the runner prints their ledger behind
   * the same `ENVELOPE_MARKER` line a result's envelope sits behind, before the error, so
   * `readRunnerEnvelope` reads both. `[]` for every other failure, a timeout included, whose
   * committed blobs are the sweep's to adopt (GRA-189).
   */
  | { ok: false; failure: RunFailure; blobs: BlobLedgerEntry[]; blobsDropped: number };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The shell test for "nothing runnable at this path": neither a file nor a directory holding an entry. */
function moduleAbsent(module: string): string {
  return [
    `[ ! -f ${module} ]`,
    ...MODULE_ENTRIES.map((entry) => `[ ! -f ${module}/${entry} ]`),
  ].join(" && ");
}

function moduleMissingMessage(modulePath: string): string {
  return `${modulePath} is not on the toolbox, even after mounting it again. The published version may have been removed; republish the tool.`;
}

/**
 * The runner over a module, on a sandbox already mounted and seeded. The input goes to a scratch
 * file rather than argv (argument limits); stderr is separated into a file and its tail printed
 * after a marker, so the exit code and both streams come back from one process. A missing module
 * directory mounts the toolbox again and retries once: a sandbox mounted before a publish may see
 * the new directory late, while a fresh mount sees it at once.
 */
export async function runModule(
  handle: SandboxHandle,
  args: {
    scope: AgentScope;
    modulePath: string;
    input: unknown;
    env: Record<string, string>;
    mode: RunMode;
  },
): Promise<ModuleRunOutcome> {
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const inputFile = `${RUN_SCRATCH_DIR}/${id}.json`;
  const stderrFile = `${RUN_SCRATCH_DIR}/${id}.err`;
  await handle.writeTree(
    [{ path: `${id}.json`, content: JSON.stringify(args.input ?? {}) }],
    RUN_SCRATCH_DIR,
  );

  const module = shellQuote(args.modulePath);
  // This server's runner, `/graft/<hash>/runner.mjs`, as the environment carries it (GRA-193).
  const runner = shellQuote(runnerPathIn(args.env));
  const absent = moduleAbsent(module);
  // A dry run is always waited: the report is the point.
  const detached = args.mode.detached && !args.mode.dryRun;

  if (detached) {
    if (!(await moduleIsPresent(handle, absent))) {
      await remountToolbox(handle, args.scope);
      if (!(await moduleIsPresent(handle, absent))) {
        return {
          ok: false,
          failure: {
            error: moduleMissingMessage(args.modulePath),
            exitCode: EXIT_MODULE_MISSING,
            stderrTail: "",
          },
          blobs: [],
          blobsDropped: 0,
        };
      }
    }
    const script = [
      `if ${absent}; then exit ${EXIT_MODULE_MISSING}; fi;`,
      `node ${runner} ${module} < ${shellQuote(inputFile)}; code=$?;`,
      `rm -f ${shellQuote(inputFile)}; exit $code`,
    ].join(" ");
    const started = await startDetached(handle, {
      command: script,
      env: args.env,
      timeoutSeconds: args.mode.timeoutSeconds,
      prefix: "tool",
    });
    return { ok: true, detached: started };
  }

  const script = [
    `if ${absent}; then exit ${EXIT_MODULE_MISSING}; fi;`,
    `node ${runner} ${module} < ${shellQuote(inputFile)} 2> ${shellQuote(stderrFile)}; code=$?;`,
    `printf '\\n${STDERR_MARKER}\\n'; tail -c ${STDERR_TAIL_BYTES} ${shellQuote(stderrFile)};`,
    `rm -f ${shellQuote(inputFile)} ${shellQuote(stderrFile)}; exit $code`,
  ].join(" ");

  const attempt = async (suffix: string) => {
    const name = `tool-${id}${suffix}`;
    await handle.execDetached(script, {
      name,
      timeoutSeconds: args.mode.timeoutSeconds,
      env: args.env,
    });
    return handle.waitForProcess(name, { maxWaitSeconds: args.mode.timeoutSeconds + 5 });
  };

  let result = await attempt("");
  if (result.status !== "running" && result.exitCode === EXIT_MODULE_MISSING) {
    await remountToolbox(handle, args.scope);
    result = await attempt("-retry");
  }
  return describeModuleRun(result, args.modulePath, args.mode.timeoutSeconds);
}

const PRESENT_MARKER = "__GRAFT_PRESENT__:";

async function moduleIsPresent(handle: SandboxHandle, absent: string): Promise<boolean> {
  const output = await handle.exec(
    `if ${absent}; then echo ${PRESENT_MARKER}no; else echo ${PRESENT_MARKER}yes; fi`,
  );
  return output.includes(`${PRESENT_MARKER}yes`);
}

/** The process result in the runner's own terms — exit codes read by name. */
export function describeModuleRun(
  result: SandboxProcessResult,
  modulePath: string,
  timeoutSeconds: number,
): ModuleRunOutcome {
  const [stdout, stderrTail = ""] = splitAtMarker(result.stdout);
  const stderr = stderrTail.trim();
  // A failure that followed a write carries the ledger behind the runner's marker (the outcome
  // type); a killed or timed-out process printed nothing, so its list is empty.
  const failure = (error: string): ModuleRunOutcome => {
    const envelope = readRunnerEnvelope(stdout);
    return {
      ok: false,
      failure: { error, exitCode: result.exitCode, stderrTail: stderr },
      blobs: envelope?.blobs ?? [],
      blobsDropped: envelope?.dropped ?? 0,
    };
  };

  if (result.status === "running") {
    return failure(
      `The tool was still running after ${timeoutSeconds} seconds and was left behind. Its output so far: ${stdout.trim().slice(-500)}`,
    );
  }
  if (result.status === "killed") {
    return failure(
      `The tool was killed before it finished — it ran past the ${timeoutSeconds}-second limit.`,
    );
  }
  if (result.exitCode === EXIT_MODULE_MISSING) return failure(moduleMissingMessage(modulePath));
  if (result.exitCode === EXIT_TIMEOUT) {
    return failure(`The tool timed out inside the runner: ${stderr || "no output"}`);
  }
  if (result.exitCode === EXIT_USAGE) {
    return failure(`The runner refused the invocation: ${stderr || "no output"}`);
  }
  if (result.exitCode !== 0) {
    return failure(`The tool failed (exit code ${result.exitCode}): ${stderr || "no output"}`);
  }

  const text = stdout.trim();
  if (text === "") return { ok: true, result: null, blobs: [], blobsDropped: 0 };
  const unwrapped = unwrapEnvelope(text);
  return (
    unwrapped ??
    failure(
      `The tool exited 0 but its stdout carries no runner envelope. The runner prints the module's result behind its marker line and nothing else, so the module printed to stdout itself: ${text.slice(-500)}`,
    )
  );
}

/**
 * The runner's stdout read in its own terms: the envelope behind its marker line (`@graft/runner`'s
 * `readRunnerEnvelope`), the module's result and the blobs the run wrote. Text with no marker is
 * null, for the caller to word as a failure. Every run on this path goes through the runner this
 * server seeded (`sandbox.ts`'s `seedRunner`, GRA-193: under `/graft/<hash>/`, handed to the
 * command as `GRAFT_RUNNER`), and that runner prints the envelope on every exit that prints
 * anything, so a bare JSON result here is a module that printed to stdout itself and never an
 * older runner; GRA-186 read one as a result with no blobs for a sandbox seeded before it, GRA-193
 * closed the case for a sync run, and GRA-199 took the tolerance out. The detached result file
 * keeps one, narrower, for the reason `sandbox.ts`'s `readRunnerResult` gives.
 */
export function unwrapEnvelope(text: string): ModuleRunOutcome | null {
  const envelope = readRunnerEnvelope(text);
  if (!envelope) return null;
  return {
    ok: true,
    result: envelope.result,
    blobs: envelope.blobs,
    blobsDropped: envelope.dropped,
  };
}

function splitAtMarker(stdout: string): [string, string?] {
  const index = stdout.lastIndexOf(STDERR_MARKER);
  if (index === -1) return [stdout];
  return [stdout.slice(0, index), stdout.slice(index + STDERR_MARKER.length)];
}

/**
 * The dry-run report as `runner.mjs` writes it — its header is the contract. Reads and write
 * requests are what was verified; `unverified` names what was not.
 */
export type DryRunReport = {
  dryRun: true;
  passed: boolean;
  reads: unknown[];
  writesPreviewed: unknown[];
  writesRefused: unknown[];
  omitted?: number;
  moduleResult?: unknown;
  moduleError?: string;
  verified: { reads: boolean; writeRequests: boolean };
  unverified: string[];
};

export function readDryRunReport(value: unknown): DryRunReport | null {
  if (typeof value !== "object" || value === null) return null;
  const report = value as Partial<DryRunReport>;
  if (
    report.dryRun !== true ||
    typeof report.passed !== "boolean" ||
    !Array.isArray(report.reads) ||
    !Array.isArray(report.writesPreviewed) ||
    !Array.isArray(report.writesRefused) ||
    typeof report.verified !== "object" ||
    report.verified === null ||
    !Array.isArray(report.unverified)
  ) {
    return null;
  }
  return report as DryRunReport;
}

export type AuthoredRunArgs = {
  vendor: string;
  name: string;
  input: unknown;
  mode: RunMode;
  /** How an ask reaches the person, when the rule says ask (`approval.ts`). */
  channel: AskChannel;
  /**
   * A version of the tool to run instead of the one the pointer names — `acquire`'s dry run of a
   * version not yet activated (GRA-77), whose report `recordDryRun` then stamps on that version.
   * Refused as `version_not_found` when it is not this tool's. Unset, the pointer decides, and a
   * tool with none is refused as `tool_has_no_version`.
   */
  versionId?: string;
  /**
   * The connection to run against instead of the tool's default — `acquire`'s dry run passes the
   * job's (GRA-122): a version published onto an existing tool row is proved against the connection
   * the job authored it for, not against a default the person may have revoked since. Held to the
   * same check as the default: in the agent's scope, which names the person's rows and no others
   * (`connection_not_in_scope` otherwise). Unset, the default decides, and a default this agent
   * cannot use follows the one live connection of the vendor in its scope (the header).
   */
  connectionId?: string;
  /**
   * A caller's own check on the tool and the version as this run reads them, made inside the
   * agent's in-flight hold, before the connection, the input and the gate (GRA-208, Greptile on
   * #166). The console's run (`apps/server/src/tool-run.ts`) refuses a tool that is not read-only
   * or not promoted; judged on its own read, a republish or a demotion landing before this one
   * would slip past it, and the working-set sweep demotes nothing while a run is held. A refusal
   * is recorded `refused` and answered as the run's own.
   */
  admit?: (
    tool: NonNullable<Awaited<ReturnType<typeof getToolByName>>>,
    versionId: string,
  ) => Promise<{ reason: string; message: string } | null>;
};

/**
 * The vendor's answer verbatim, or — marked — a refusal, the runner's failure, or the approval
 * gate's `awaiting_approval`; the caller sorts the last onto the wire as a result and the others as
 * errors (`result.ts`'s `toolAwaitingOrError`, GRA-112).
 */
export type AuthoredRunAnswer =
  | { isError: false; answer: unknown }
  /**
   * `card` rides beside the gate's `awaiting_approval` — the tool ask as a chat product renders it
   * (GRA-116) — with the message in its card form beside it (GRA-120; `card-client.ts`).
   */
  | { isError: true; answer: Record<string, unknown>; card?: AskCard; cardMessage?: string };

/**
 * Run one authored tool for an agent, end to end — see the header. Every exit records a ledger
 * row: `ok` for a result or a detached start (a capability was issued and the process runs),
 * `error` for a failure, `refused` for a refusal before anything ran.
 */
export async function runAuthoredTool(
  deps: McpDeps,
  scope: AgentScope,
  args: AuthoredRunArgs,
): Promise<AuthoredRunAnswer> {
  return heldInFlight(deps.inFlight, scope.agentId, () => runHeld(deps, scope, args));
}

async function runHeld(
  deps: McpDeps,
  scope: AgentScope,
  args: AuthoredRunArgs,
): Promise<AuthoredRunAnswer> {
  const ctx: ServiceContext = { db: deps.db };
  const principal = { personId: scope.personId };
  const wireName = authoredToolName(args.vendor, args.name);
  const startedAt = Date.now();

  const record = async (
    outcome: UsageOutcome,
    ids: { toolId?: string; versionId?: string } = {},
  ) => {
    await recordUsage(
      ctx,
      scope,
      {
        toolId: ids.toolId ?? null,
        versionId: ids.versionId ?? null,
        toolName: wireName,
        outcome,
        dryRun: args.mode.dryRun,
        latencyMs: Date.now() - startedAt,
      },
      deps.ledger,
    );
  };
  const refuse = async (
    reason: string,
    message: string,
    ids?: { toolId?: string; versionId?: string },
    details?: Record<string, unknown>,
  ): Promise<AuthoredRunAnswer> => {
    await record("refused", ids);
    return { answer: refusal(reason, message, details), isError: true };
  };

  const tool = await getToolByName(
    ctx,
    principal,
    { vendor: args.vendor, name: args.name },
    deps.tool,
  );
  if (!tool) {
    return refuse(
      "tool_not_found",
      `No tool named ${args.name} for ${args.vendor} is in this toolbox. find_tool searches it.`,
    );
  }
  const ids = { toolId: tool.id };
  const versionId = args.versionId ?? tool.currentVersionId;
  const found = versionId ? await getToolVersion(ctx, principal, versionId, deps.tool) : null;
  // A version read by id must be this tool's: the read is scoped to the person, not the tool.
  const version = found && found.toolId === tool.id ? found : null;
  if (!version) {
    return args.versionId
      ? refuse(
          "version_not_found",
          `${wireName} has no version ${args.versionId} in this toolbox.`,
          ids,
        )
      : refuse(
          "tool_has_no_version",
          `${wireName} has no version that passed its dry run, so there is nothing to run. acquire authors one.`,
          ids,
        );
  }
  const versioned = { toolId: tool.id, versionId: version.id };
  const admission = args.admit ? await args.admit(tool, version.id) : null;
  if (admission) return refuse(admission.reason, admission.message, versioned);

  const bound = args.connectionId ?? tool.defaultConnectionId;
  if (!bound) {
    return refuse(
      "connection_not_bound",
      `${wireName} is bound to no connection, so there is nothing to run it against.`,
      versioned,
    );
  }
  const scopeIds = await getAgentScope(ctx, scope, deps.agent);
  const inScope = scopeIds.includes(bound);
  if (args.connectionId && !inScope) {
    return refuse(
      "connection_not_in_scope",
      `${wireName} was asked to run against connection ${bound}, which is not in this agent's scope. The person can add it in the console.`,
      versioned,
    );
  }
  // After the scope check and before the gate: a revoked connection's approvals are gone with it,
  // and asking the person for them again is not the next step (GRA-69).
  const connection = inScope ? await getConnection(ctx, principal, bound, deps.connection) : null;
  const revoked = connection?.revokedAt != null;
  if (args.connectionId && revoked && connection) {
    await record("refused", versioned);
    return { answer: revokedConnectionRefusal(connection), isError: true };
  }
  let connectionId = bound;
  let gated = tool;
  if (!inScope || revoked) {
    // The header's last paragraph (GRA-122): the one live connection of the vendor in this agent's
    // scope, or the refusal naming what stands in the way.
    const live = await liveConnectionsOfVendor(ctx, principal, tool.vendor, bound, scopeIds, deps);
    const [target] = live;
    if (!target || live.length !== 1) {
      await record("refused", versioned);
      return {
        answer:
          revoked && connection
            ? revokedConnectionRefusal(connection, live)
            : notInScopeRefusal(wireName, bound, live),
        isError: true,
      };
    }
    connectionId = target.id;
    if (revoked) {
      // Dead for every agent, so the row follows — unless the person reconnected it meanwhile, in
      // which case it is live again and the run goes there; a live default outside this scope is
      // another agent's and stays (the header).
      let result: Awaited<ReturnType<typeof rebindToolIfConnectionDead>>;
      try {
        result = await rebindToolIfConnectionDead(ctx, principal, tool.id, target.id, deps.tool);
      } catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "NOT_FOUND") throw error;
        return refuse(
          "tool_not_found",
          `${wireName} left the toolbox while its connection was being chosen; find_tool searches it.`,
          versioned,
        );
      }
      gated = result.tool;
      if (!result.rebound) connectionId = result.tool.defaultConnectionId ?? target.id;
    }
  }

  const validator = compileInputSchema(tool.inputSchema);
  if ("error" in validator) {
    return refuse("input_schema_invalid", validator.error, versioned);
  }
  const verdict = validator(args.input);
  // The schema rides beside the problems so the second call is right (GRA-78): the caller may be
  // `run_tool` on a client whose list never showed the tool and its schema.
  if (!verdict.ok) {
    return refuse("input_invalid", verdict.message, versioned, { inputSchema: tool.inputSchema });
  }

  // The blob door (GRA-187; `blob-door.ts`): the quota, then every ref the input names, judged over
  // the rows before the gate asks anyone and before a sandbox is touched. A dry run passes it too.
  // Admitted and granted as one step (`admitUnderGrant`, `in-flight.ts`; GRA-200 after Greptile on
  // #157): the budget is outstanding from the admission until the run settles, so a second run
  // admitted meanwhile is handed the remainder after this one's; a detached start moves the grant
  // onto its process name below before this release runs.
  const door = await admitUnderGrant(deps.inFlight, scope.agentId, () =>
    admitBlobs(deps, scope, verdict.value),
  );
  if (!door.ok) {
    await record("refused", versioned);
    return { answer: door.refusal, isError: true };
  }
  const admitted = door.admission;
  const releaseGrant = door.release;
  // The narrowed values the admitted run reads, captured once for the function below.
  const runVersion = version;
  const runTool = tool;
  const input = verdict.value;
  try {
    return await runAdmitted();
  } finally {
    releaseGrant();
  }

  async function runAdmitted(): Promise<AuthoredRunAnswer> {
    // The approval gate (ADR 0008): after the scope check, before the mint. A dry run passes it: reads
    // reach the vendor as they would for a read-only tool and every write stops at the proxy on the
    // token's claim, so nothing changes at the vendor and no trust is spent — publishing's dry run
    // (`publish_tool`) asks nothing for the same reason.
    if (!args.mode.dryRun) {
      const gate = await gateToolCall(
        ctx,
        scope,
        { tool: gated, connectionId },
        deps,
        args.channel,
      );
      if (!gate.pass) {
        await record("refused", versioned);
        return {
          answer: gate.answer,
          isError: true,
          card: gate.card,
          cardMessage: gate.cardMessage,
        };
      }
    }

    const outcome = await runWithCapability({
      deps,
      scope,
      connectionId,
      claim: wireName,
      mode: args.mode,
      run: async (env): Promise<ModuleRunOutcome> => {
        let handle: SandboxHandle;
        try {
          handle = await openAgentSandbox(deps, scope);
        } catch (error) {
          return {
            ok: false,
            failure: {
              error: `The sandbox is unavailable right now: ${errorMessage(error)}`,
              exitCode: null,
              stderrTail: "",
            },
            blobs: [],
            blobsDropped: 0,
          };
        }
        return runModule(handle, {
          scope,
          modulePath: sandboxPath(runVersion.path),
          input: input,
          // The version whose run this is, for the sidecar of any blob it writes (ADR 0023), and
          // the agent with what the run may still commit under its quota (the header; `blob-door.ts`).
          env: {
            ...env,
            GRAFT_TOOL_VERSION: runVersion.id,
            ...blobRunEnvironment(scope, admitted),
          },
          mode: args.mode,
        });
      },
    });

    if ("error" in outcome && outcome.error === "refused") {
      await record("refused", versioned);
      return { answer: outcome, isError: true };
    }
    const run = outcome as ModuleRunOutcome;

    // A capability was issued and the runner ran: the clock moves whatever the module said (ADR 0009).
    await touchToolUsed(ctx, scope, runTool.id, deps.workingSet);

    if (!run.ok) {
      // A module that wrote and then failed committed its blobs all the same (the outcome type): the
      // rows land as they do on a success, and the failure names the refs beside its own fields.
      // Measured against the store and held to the quota as every ledger is (`blob-budget.ts`;
      // GRA-200): this runner honours the budget, so the check is defence in depth here.
      const recorded = await recordBlobsWithinQuota(
        deps,
        scope,
        runVersion.id,
        run.blobs,
        run.blobsDropped,
      );
      const overshoot = blobQuotaOvershoot(recorded);
      await record("error", versioned);
      return {
        answer: {
          ...run.failure,
          ...blobsOnWire(recorded.listed, recorded.dropped),
          ...(overshoot ? { ...overshoot, error: `${run.failure.error} ${overshoot.error}` } : {}),
        },
        isError: true,
      };
    }
    if ("detached" in run) {
      // Before the call's own hold and grant release, so the agent is never momentarily unheld or
      // ungranted: the process carries both until its poll settles it or its time is up.
      deps.inFlight?.track(
        scope.agentId,
        run.detached.processName,
        detachedHoldMs(run.detached.timeoutSeconds),
        admitted.budgetBytes,
      );
      await record("ok", versioned);
      return { answer: describeDetachedStart(run.detached), isError: false };
    }
    // The blobs the run wrote, one row each, before the answer names them (the header; `blobs.ts`).
    // A dry run's blobs are real files under the mount and get their rows like any other. Measured
    // against the store and held to the quota (`blob-budget.ts`; GRA-200, after Greptile on #157):
    // the record is the rule on every path, and a run past the quota is answered a failure.
    const recorded = await recordBlobsWithinQuota(
      deps,
      scope,
      runVersion.id,
      run.blobs,
      run.blobsDropped,
    );
    const overshoot = blobQuotaOvershoot(recorded);
    if (overshoot) {
      await record("error", versioned);
      return {
        answer: {
          ...overshoot,
          exitCode: 0,
          stderrTail: "",
          ...blobsOnWire(recorded.listed, recorded.dropped),
        },
        isError: true,
      };
    }
    if (args.mode.dryRun) {
      const report = readDryRunReport(run.result);
      await recordDryRun(
        ctx,
        principal,
        runVersion.id,
        {
          report: report ?? { dryRun: true, passed: false, missing: true },
          writesInvolved: report
            ? report.writesPreviewed.length + report.writesRefused.length > 0
            : false,
        },
        deps.tool,
      );
      await record(report ? "ok" : "error", versioned);
      return report
        ? {
            answer: { dryRun: report, ...blobsOnWire(recorded.listed, recorded.dropped) },
            isError: false,
          }
        : {
            answer: {
              error: "The run produced no dry-run report; the runner did not run in dry-run mode.",
              exitCode: 0,
              stderrTail: "",
            },
            isError: true,
          };
    }
    await record("ok", versioned);
    return {
      answer: withBlobs(boundResult(run.result), recorded.listed, recorded.dropped),
      isError: false,
    };
  }
}

/**
 * The refusal for a tool whose default connection is live but not in this agent's scope, and which
 * no single live connection of the vendor in the scope can stand in for (the header; GRA-122). With
 * none, the sentence GRA-1 left; with several, they are named — in the sentence and under
 * `alternatives`, as `revokedConnectionRefusal` names them — and the choice is the person's.
 */
function notInScopeRefusal(
  wireName: string,
  connectionId: string,
  alternatives: readonly ConnectionOutput[],
): Refusal {
  const runs = `${wireName} runs against connection ${connectionId}, which is not in this agent's scope.`;
  if (alternatives.length === 0) {
    return refusal("connection_not_in_scope", `${runs} The person can add it in the console.`);
  }
  const named = alternatives.map((other) => `${other.displayName} (${other.id})`).join(", ");
  return refusal(
    "connection_not_in_scope",
    `${runs} ${alternatives.length} live connections of the same vendor are — ${named} — so the tool cannot follow one on its own; it does when there is exactly one. Ask the person to add ${connectionId} to this agent's scope in the console, or to say which of the others to use; acquire against that one authors the tool there.`,
    {
      alternatives: alternatives.map((other) => ({
        connectionId: other.id,
        displayName: other.displayName,
      })),
    },
  );
}

/**
 * The live connections of a vendor this agent may run against, other than the tool's default — the
 * candidates a tool whose default this agent cannot use may follow (the header; GRA-122). In the
 * scope, and usable as `request_connection` judges usable (`isConnectionUsable`: not revoked, its
 * provider enabled, its credential or consent in place), so a row the agent was never given, or one
 * that would refuse the call anyway, is neither followed nor named.
 */
async function liveConnectionsOfVendor(
  ctx: ServiceContext,
  principal: Principal,
  vendor: string,
  defaultId: string,
  scopeIds: readonly string[],
  deps: McpDeps,
): Promise<ConnectionOutput[]> {
  const rows = await listConnections(ctx, principal, deps.connection);
  return rows.filter(
    (row) =>
      row.vendor === vendor &&
      row.id !== defaultId &&
      scopeIds.includes(row.id) &&
      isConnectionUsable(row, deps.connection.providers),
  );
}
