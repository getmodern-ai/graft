import {
  type AgentScope,
  adoptBlob,
  type BlobSweepAction,
  type BlobSweepEntry,
  blobSweepDecision,
  demoteTool,
  isTmpName,
  lastUsedAtByTool,
  listActiveAgentScopes,
  listUnremovedBlobs,
  listWorkingSet,
  markBlobRemoved,
  type ServiceContext,
  type SweepCause,
  type SweepEntry,
  sweepDecision,
} from "@graft/core";
import type { BlobStore } from "@graft/toolbox";

import { ABANDONED_BLOB_WRITE_SECONDS } from "./bounds";
import type { McpDeps } from "./deps";
import { errorMessage } from "./sandbox";

/**
 * The sweep: ADR 0009's rule applied to every agent's working set, on a plain timer inside the server
 * (GRA-1, "No Temporal"). Per agent it reads the working set and the ledger, asks `sweepDecision`
 * (`@graft/core`, the pure rule) what to demote, demotes each through `demoteTool` with the cause the
 * decision named — so the record is the same one the agent's own `demote` writes (ADR 0012: contraction
 * and improvement share one ledger) — and fires `tools/list_changed` once through the same
 * rate-limited notifier the meta-tools use (ADR 0003). An agent with a run in flight is skipped whole
 * and decided afresh next time (`in-flight.ts`).
 *
 * Two clocks feed the decision, and the later of them wins: `working_set.last_used_at`, which the run
 * path stamps and the index serves, and the ledger's last line for the tool (ADR 0012's record), which
 * catches an invocation the stamp missed — a run refused before it ran still says the agent reached
 * for the tool. The decision itself discounts a use older than the promotion.
 *
 * A revoked agent is not swept: its token resolves to nothing, so its list is nobody's, and its
 * working set stays as its history left it. Defaults for a new agent are the schema's (`agent`
 * table: a cap of twenty, a window of twenty-one days); the row's own values override them, which
 * is what the console edits (GRA-1, user story 22).
 *
 * **The second pass, on the same timer, is the blobs'** (ADR 0023, "the sweep deletes"; GRA-189).
 * After the working-set pass for an agent, and under the same in-flight skip, since a run may be
 * writing a blob, it reads the agent's unremoved rows and the names its blob store lists, reads the
 * sidecar and the age of every directory no row claims, asks `blobSweepDecision` (`@graft/core`,
 * the pure rule) what to do, and applies the plan through `McpDeps.blobStore` and the blob service:
 * an expired blob's directory goes and its row is marked `removed_at` (never deleted, so the door
 * can say expired rather than not found), an orphan with a sidecar becomes a row, an orphan without
 * one goes, a `.tmp` older than `ABANDONED_BLOB_WRITE_SECONDS` goes. Each removal of a blob fires
 * `McpDeps.onBlobSwept` once; the counts ride on the report under `blobs`, which the server puts on
 * the sweep's wide event. Nothing under `tools/` is ever in a plan: the store reaches `.blobs/` alone.
 */

export type SweepDemotion = { agentId: string; toolId: string; cause: SweepCause };

/** One blob action the sweep took, or would take under `apply: false`, for one agent. */
export type SweepBlobAction = BlobSweepAction & { agentId: string };

/** The blob pass's counts, per outcome, and what was freed: the shape of `sweep.blobs` on the wide event. */
export type SweepBlobCounts = {
  kept: number;
  removed: number;
  marked: number;
  adopted: number;
  orphansRemoved: number;
  tmpRemoved: number;
  /**
   * Actions not applied because a run started for the agent after its pass began; the rest of
   * that agent's pass waits for the next tick, and the agent is in `SweepReport.deferred`.
   */
  deferred: number;
  /** The bytes of every `remove`, `remove_orphan` and `remove_tmp` whose size was known. */
  bytesRemoved: number;
};

export type SweepReport = {
  /** The clock the sweep was handed. */
  at: string;
  /** How many agents were considered — every agent whose token still resolves, across persons. */
  agents: number;
  /** Agents skipped for a run in flight; the next sweep decides for them. */
  skipped: string[];
  /** Agents whose blob pass stopped part way because a run started during it; the next sweep finishes. */
  deferred: string[];
  demoted: SweepDemotion[];
  /** The blob pass (GRA-189): the counts, and every action but a `keep`. */
  blobs: SweepBlobCounts & { actions: SweepBlobAction[] };
  /** Agents whose sweep threw; the others were swept regardless. */
  failed: { agentId: string; error: string }[];
};

export type RunSweepOptions = {
  /**
   * `false` decides and reports but demotes and notifies nothing — what the dev script prints under
   * `--plan`, and what a caller with no view of this process's in-flight registry should prefer.
   */
  apply?: boolean;
  /**
   * How old a `.tmp` blob directory must be before it is read as abandoned; `ABANDONED_BLOB_WRITE_SECONDS`
   * in milliseconds by default. A test seam: a suite cannot wait an hour, and a deployment never sets it.
   */
  abandonedWriteMs?: number;
};

/** One blob directory the sweep removed, as `McpDeps.onBlobSwept` is told of it. */
export type BlobSweptEvent = {
  agentId: string;
  personId: string;
  blobId: string;
  /** The row's size for an expired blob; what the store saw of an orphan's `data`, or null with none. */
  bytes: number | null;
  /** A row past its expiry, or a committed directory no row and no readable sidecar claimed. */
  cause: "expired" | "orphan";
};

const EMPTY_BLOB_COUNTS: SweepBlobCounts = {
  kept: 0,
  removed: 0,
  marked: 0,
  adopted: 0,
  orphansRemoved: 0,
  tmpRemoved: 0,
  deferred: 0,
  bytesRemoved: 0,
};

/**
 * What the decision needs of one agent's directories: the store's listing, and for every name no row
 * claims, the sidecar (a committed directory) and the age and size (`stat`). A directory with a row
 * needs nothing read: the row carries its size and its expiry.
 *
 * A read that fails is this agent's failure, not an absence: `readMeta`'s null is the store's own
 * not-found signal and the only thing the decision may read as "no sidecar", and `stat`'s null the
 * only "gone". Anything else (a symlink refused, a permission, a backing's error) propagates, the
 * agent's pass ends with the error on the report, and the blob is judged again next tick. A read
 * error turned into an absence would be a removal.
 */
async function readBlobEntries(
  store: BlobStore,
  agentId: string,
  rowIds: ReadonlySet<string>,
): Promise<BlobSweepEntry[]> {
  const names = await store.list(agentId);
  return Promise.all(
    names.map(async (name): Promise<BlobSweepEntry> => {
      if (rowIds.has(name)) return { name };
      const stat = await store.stat(agentId, name);
      if (isTmpName(name)) return { name, stat };
      const sidecar = await store.readMeta(agentId, name);
      return { name, sidecar, stat };
    }),
  );
}

/**
 * The blob pass for one agent: decide, then apply each action through the store and the service,
 * counting as it goes. An action that throws stops the agent's pass and is the agent's failure; the
 * next sweep decides afresh, and a directory removed before the throw has its row marked or not as
 * the order here says: the directory first, then the row, so a crash between the two leaves a
 * `mark` for the next pass rather than a marked row with bytes still on disk.
 *
 * **A run may start while this pass is reading.** The agent was not in flight when the pass began,
 * but the reads above are awaited and a call can arrive between them and commit a blob. Two
 * defences, neither of which needs the run and the sweep to lock each other: every destructive
 * action re-reads the in-flight registry first and, if a run has started, the rest of this
 * agent's pass is deferred to the next tick and counted as such; and an adoption whose id turns out
 * to be taken is read as "a row exists now", so the blob is kept, never removed. The run's own
 * insert is idempotent on the id since #144 (`insertBlobs` is `on conflict ("id") do nothing`), so
 * the other order, the sweep adopting first, leaves the run's row write a no-op rather than a
 * failure.
 */
async function sweepBlobs(
  ctx: ServiceContext,
  deps: McpDeps,
  store: BlobStore,
  scope: AgentScope,
  now: Date,
  options: { apply: boolean; abandonedWriteMs: number },
  report: SweepReport,
): Promise<void> {
  const rows = await listUnremovedBlobs(ctx, scope, deps.blob);
  const entries = await readBlobEntries(store, scope.agentId, new Set(rows.map((row) => row.id)));
  const decision = blobSweepDecision({
    agentId: scope.agentId,
    rows: rows.map((row) => ({
      id: row.id,
      bytes: row.bytes,
      expiresAt: row.expiresAt,
      removedAt: row.removedAt,
    })),
    entries,
    now,
    abandonedWriteMs: options.abandonedWriteMs,
  });

  const counts = report.blobs;
  const swept = (blobId: string, bytes: number | null, cause: BlobSweptEvent["cause"]) => {
    counts.bytesRemoved += bytes ?? 0;
    deps.onBlobSwept?.({ agentId: scope.agentId, personId: scope.personId, blobId, bytes, cause });
  };
  const record = (action: BlobSweepAction) => {
    report.blobs.actions.push({ ...action, agentId: scope.agentId });
  };
  /** True, and the rest of the pass deferred, when a run started for this agent since the pass began. */
  const runStarted = (remaining: number): boolean => {
    if (!options.apply || !(deps.inFlight?.has(scope.agentId) ?? false)) return false;
    counts.deferred += remaining;
    if (!report.deferred.includes(scope.agentId)) report.deferred.push(scope.agentId);
    return true;
  };

  for (const [index, action] of decision.actions.entries()) {
    const remaining = decision.actions.length - index;
    switch (action.action) {
      case "keep":
        counts.kept += 1;
        break;
      case "remove":
        if (runStarted(remaining)) return;
        record(action);
        if (options.apply) {
          await store.remove(scope.agentId, action.blobId);
          if (action.mark) await markBlobRemoved(ctx, scope, action.blobId, deps.blob);
          swept(action.blobId, action.bytes, "expired");
        }
        counts.removed += 1;
        break;
      case "mark":
        record(action);
        if (options.apply) await markBlobRemoved(ctx, scope, action.blobId, deps.blob);
        counts.marked += 1;
        break;
      case "adopt": {
        if (options.apply) {
          const row = await adoptBlob(ctx, scope, action.blobId, action.row, deps.blob);
          if (row === null) {
            // A row exists now: the run that wrote this blob landed its row between the read above
            // and here (its run is in flight; this pass would not have started otherwise), or the
            // sweep once removed it and its directory has come back. Neither is this pass's to
            // remove: the blob is kept and judged as a row next tick, where a removed row's
            // directory is `remove` again and a live one is `keep`.
            counts.kept += 1;
            break;
          }
        }
        record(action);
        counts.adopted += 1;
        break;
      }
      case "remove_orphan":
        if (runStarted(remaining)) return;
        record(action);
        if (options.apply) {
          await store.remove(scope.agentId, action.blobId);
          swept(action.blobId, action.bytes, "orphan");
        }
        counts.orphansRemoved += 1;
        break;
      case "remove_tmp":
        if (runStarted(remaining)) return;
        record(action);
        if (options.apply) {
          await store.remove(scope.agentId, action.name);
          counts.bytesRemoved += action.bytes ?? 0;
        }
        counts.tmpRemoved += 1;
        break;
    }
  }
}

/** The later of the two clocks, or null when neither has a moment. */
function later(a: Date | null, b: Date | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b > a ? b : a;
}

export async function runSweep(
  ctx: ServiceContext,
  deps: McpDeps,
  now: Date,
  options: RunSweepOptions = {},
): Promise<SweepReport> {
  const apply = options.apply ?? true;
  const abandonedWriteMs = options.abandonedWriteMs ?? ABANDONED_BLOB_WRITE_SECONDS * 1_000;
  const agents = await listActiveAgentScopes(ctx, deps.agent);
  const report: SweepReport = {
    at: now.toISOString(),
    agents: agents.length,
    skipped: [],
    deferred: [],
    demoted: [],
    blobs: { ...EMPTY_BLOB_COUNTS, actions: [] },
    failed: [],
  };

  for (const agent of agents) {
    const scope: AgentScope = { personId: agent.personId, agentId: agent.agentId };
    try {
      // Read once; a run that starts between here and the demotes has already resolved its tool, so
      // the worst case is a list refreshed one turn early, never a call that fails.
      const inFlight = deps.inFlight?.has(agent.agentId) ?? false;
      if (inFlight) {
        report.skipped.push(agent.agentId);
        continue;
      }

      const [entries, usage] = await Promise.all([
        listWorkingSet(ctx, scope, deps.workingSet),
        lastUsedAtByTool(ctx, scope, deps.ledger),
      ]);
      const usedAt = new Map(usage.map((row) => [row.toolId, row.lastUsedAt]));
      const records: SweepEntry[] = entries.map((entry) => ({
        toolId: entry.toolId,
        promotedAt: entry.promotedAt,
        lastUsedAt: later(entry.lastUsedAt, usedAt.get(entry.toolId)),
      }));

      const decision = sweepDecision({
        entries: records,
        cap: agent.workingSetCap,
        idleWindowDays: agent.idleWindowDays,
        now,
        inFlight,
      });

      let changed = 0;
      for (const { toolId, cause } of decision.demote) {
        if (apply) {
          const result = await demoteTool(ctx, scope, toolId, cause, deps.workingSet);
          if (!result.changed) continue;
          changed += 1;
        }
        report.demoted.push({ agentId: agent.agentId, toolId, cause });
      }
      if (changed > 0) deps.notifier?.changed(agent.agentId);

      // The blob pass, for the same agent, under the same in-flight skip (ADR 0023).
      if (deps.blobStore) {
        await sweepBlobs(
          ctx,
          deps,
          deps.blobStore,
          scope,
          now,
          { apply, abandonedWriteMs },
          report,
        );
      }
    } catch (error) {
      report.failed.push({ agentId: agent.agentId, error: errorMessage(error) });
    }
  }

  return report;
}

export type StartSweepOptions = {
  /** Seconds between sweeps — `GRAFT_SWEEP_INTERVAL_SECONDS`. A test may pass a fraction. */
  intervalSeconds: number;
  /** The clock; `deps.now`, then the real one. */
  now?: () => Date;
  onReport?: (report: SweepReport) => void;
  /** A sweep that threw as a whole — before any agent, or in the roster read. Per-agent failures are in the report. */
  onError?: (error: unknown) => void;
};

export type SweepHandle = {
  /** Run one sweep now; a sweep already running is joined rather than doubled. */
  runNow(): Promise<SweepReport>;
  stop(): void;
};

/**
 * The scheduler `apps/server` starts at boot: one `setInterval`, unref'd so it never holds the
 * process open, and never two sweeps at once — a tick that lands during a sweep joins it. Errors
 * reach `onError` and never the event loop, so a failing sweep is a logged line and not a crashed
 * server; the next tick tries again.
 */
export function startSweep(deps: McpDeps, options: StartSweepOptions): SweepHandle {
  const clock = options.now ?? deps.now ?? (() => new Date());
  let running: Promise<SweepReport> | null = null;

  const runNow = (): Promise<SweepReport> => {
    if (running) return running;
    running = runSweep({ db: deps.db }, deps, clock())
      .then((report) => {
        options.onReport?.(report);
        return report;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => {
    runNow().catch((error) => options.onError?.(error));
  }, options.intervalSeconds * 1_000);
  timer.unref?.();

  return {
    runNow,
    stop: () => clearInterval(timer),
  };
}
