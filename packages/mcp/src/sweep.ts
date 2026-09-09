import {
  type AgentScope,
  demoteTool,
  lastUsedAtByTool,
  listActiveAgentScopes,
  listWorkingSet,
  type ServiceContext,
  type SweepCause,
  type SweepEntry,
  sweepDecision,
} from "@graft/core";

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
 */

export type SweepDemotion = { agentId: string; toolId: string; cause: SweepCause };

export type SweepReport = {
  /** The clock the sweep was handed. */
  at: string;
  /** How many agents were considered — every agent whose token still resolves, across persons. */
  agents: number;
  /** Agents skipped for a run in flight; the next sweep decides for them. */
  skipped: string[];
  demoted: SweepDemotion[];
  /** Agents whose sweep threw; the others were swept regardless. */
  failed: { agentId: string; error: string }[];
};

export type RunSweepOptions = {
  /**
   * `false` decides and reports but demotes and notifies nothing — what the dev script prints under
   * `--plan`, and what a caller with no view of this process's in-flight registry should prefer.
   */
  apply?: boolean;
};

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
  const agents = await listActiveAgentScopes(ctx, deps.agent);
  const report: SweepReport = {
    at: now.toISOString(),
    agents: agents.length,
    skipped: [],
    demoted: [],
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
