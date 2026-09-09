import type { WorkingSetChangeCause } from "@graft/db/schema/working-set";

/**
 * ADR 0009's rule as a pure function: which of an agent's promoted tools the sweep demotes now, given
 * the working set's usage records, the agent's cap and idle window, whether the agent has a run in
 * flight, and the clock. No `ctx`, no `deps`, so every clause has a test that reads like the ADR
 * (`sweep.decision.test.ts`); the sweep (`@graft/mcp`'s `sweep.ts`) only applies what this returns.
 *
 * - **A run in flight: nothing.** Demotion is deferred while the agent has a run in flight, whatever
 *   the set looks like; the next sweep decides afresh.
 * - **Idle.** A tool whose last use is older than the window demotes with cause `idle`. A tool never
 *   called since it was promoted counts from its promotion, so a tool promoted and forgotten ages out
 *   like one used and forgotten.
 * - **Cap.** When more tools remain than the cap allows, the least recently used beyond the cap
 *   demote with cause `cap` — never a tool used inside the window. A promotion is not a use, so the
 *   cap's candidates are the tools promoted inside the window and not yet called, oldest promotion
 *   first. The consequence is deliberate: a working set whose every tool was used inside the window
 *   sits above the cap until some of them age out. **The cap is a backstop against a list that never
 *   shrinks, not a hard limit** — a limit that demoted a tool the agent used yesterday would degrade
 *   the very task the rule exists to protect (ADR 0009).
 *
 * A use recorded before the tool's promotion belongs to an earlier promotion of the same tool — the
 * ledger keeps a tool's whole history across promote and demote — and is read as no use of this one.
 * Ties break by promotion time and then tool id, so two sweeps over the same records decide the same
 * and a test can assert order.
 */

export type SweepEntry = {
  toolId: string;
  promotedAt: Date;
  /** When the agent last invoked the tool; null for never. */
  lastUsedAt: Date | null;
};

export type SweepCause = Extract<WorkingSetChangeCause, "idle" | "cap">;

export type SweepDemotion = { toolId: string; cause: SweepCause };

export type SweepDecisionInput = {
  entries: readonly SweepEntry[];
  cap: number;
  idleWindowDays: number;
  now: Date;
  inFlight: boolean;
};

export type SweepDecision = { demote: SweepDemotion[] };

export const DAY_MS = 86_400_000;

/** A use since this promotion, or null: a use before it was of an earlier promotion. */
function useSincePromotion(entry: SweepEntry): number | null {
  if (!entry.lastUsedAt) return null;
  const used = entry.lastUsedAt.getTime();
  return used >= entry.promotedAt.getTime() ? used : null;
}

/** The moment the idle window counts from. */
function lastActive(entry: SweepEntry): number {
  return useSincePromotion(entry) ?? entry.promotedAt.getTime();
}

/** Least recently active first; ties by promotion time, then tool id. */
function byRecency(a: SweepEntry, b: SweepEntry): number {
  return (
    lastActive(a) - lastActive(b) ||
    a.promotedAt.getTime() - b.promotedAt.getTime() ||
    (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0)
  );
}

export function sweepDecision(input: SweepDecisionInput): SweepDecision {
  if (input.inFlight) return { demote: [] };

  // Strictly older than the window: a tool unused for exactly the window is not yet past it.
  const cutoff = input.now.getTime() - input.idleWindowDays * DAY_MS;
  const ordered = [...input.entries].sort(byRecency);

  const demote: SweepDemotion[] = [];
  const kept: SweepEntry[] = [];
  for (const entry of ordered) {
    if (lastActive(entry) < cutoff) demote.push({ toolId: entry.toolId, cause: "idle" });
    else kept.push(entry);
  }

  const excess = kept.length - input.cap;
  if (excess <= 0) return { demote };

  // Already in recency order, and for a never-used tool that is its promotion time.
  const candidates = kept.filter((entry) => useSincePromotion(entry) === null);
  for (const entry of candidates.slice(0, excess)) {
    demote.push({ toolId: entry.toolId, cause: "cap" });
  }
  return { demote };
}
