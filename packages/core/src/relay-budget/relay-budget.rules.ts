import type { RelayBudgetCeiling, RelayBudgetVerdict } from "@graft/proxy/types";

/**
 * The relay budget's decision (GRA-349; ADR 0019 as amended 2026-11-14), pure and browser-safe. A
 * relayed call costs the deployment what its upstream charges, so the deployment may set two
 * ceilings: an agent's relayed calls in the current clock hour, and a person's across all their
 * agents over a rolling 24 hours. Either may be absent, and both absent is no budget at all, which
 * is the default in both forms.
 *
 * The count is kept in hourly buckets per agent (`relay_call_count`), so "rolling" is to the hour:
 * the person's day is the current hour and the 23 before it, and an hour's calls leave the window
 * 24 hours after the hour began.
 */

export const HOUR_MS = 60 * 60 * 1000;

/** How many hourly buckets the person's window holds: this hour and the 23 before it. */
export const PERSON_WINDOW_HOURS = 24;

/** The deployment's two ceilings; null is no ceiling. */
export type RelayBudgetLimits = { agentHourly: number | null; personDaily: number | null };

/** No ceilings: what a deployment that set neither runs with. */
export const NO_RELAY_BUDGET: RelayBudgetLimits = { agentHourly: null, personDaily: null };

/** One agent's relayed calls in one clock hour. */
export type RelayCallBucket = { agentId: string; hourStart: Date; calls: number };

export function hasRelayBudget(limits: RelayBudgetLimits): boolean {
  return limits.agentHourly !== null || limits.personDaily !== null;
}

/** The start of the clock hour `now` is in, UTC. */
export function hourStartOf(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

/** The oldest bucket the person's window counts. */
export function personWindowStart(now: Date): Date {
  return new Date(hourStartOf(now).getTime() - (PERSON_WINDOW_HOURS - 1) * HOUR_MS);
}

type Refusal = Extract<RelayBudgetVerdict, { allowed: false }>;

/**
 * Whether one more relayed call by `agentId` may go, given every bucket of the agent's person in
 * the window. The count is judged before the call is added, so the call that would make the count
 * pass a ceiling is the one refused, and a refused call is never counted. When both ceilings are
 * reached the refusal names the one that lifts later, since that is when a call will next go.
 */
export function judgeRelayBudget(input: {
  agentId: string;
  buckets: readonly RelayCallBucket[];
  limits: RelayBudgetLimits;
  now: Date;
}): RelayBudgetVerdict {
  const { agentId, limits, now } = input;
  const hour = hourStartOf(now).getTime();
  const windowStart = personWindowStart(now).getTime();
  const inWindow = input.buckets.filter((bucket) => bucket.hourStart.getTime() >= windowStart);

  const refusals: Refusal[] = [];

  if (limits.agentHourly !== null) {
    const used = inWindow
      .filter((bucket) => bucket.agentId === agentId && bucket.hourStart.getTime() === hour)
      .reduce((total, bucket) => total + bucket.calls, 0);
    if (used >= limits.agentHourly) {
      refusals.push(refusal("agent_hour", limits.agentHourly, used, new Date(hour + HOUR_MS)));
    }
  }

  if (limits.personDaily !== null) {
    const used = inWindow.reduce((total, bucket) => total + bucket.calls, 0);
    if (used >= limits.personDaily) {
      refusals.push(
        refusal(
          "person_day",
          limits.personDaily,
          used,
          personReset(inWindow, used, limits.personDaily),
        ),
      );
    }
  }

  if (refusals.length === 0) return { allowed: true };
  return refusals.reduce((later, next) =>
    next.resetsAt.getTime() > later.resetsAt.getTime() ? next : later,
  );
}

function refusal(
  ceiling: RelayBudgetCeiling,
  limit: number,
  used: number,
  resetsAt: Date,
): Refusal {
  return { allowed: false, ceiling, limit, used, resetsAt };
}

/**
 * When the person's next call fits: the oldest hours leave the window one at a time, each 24 hours
 * after it began, and the first moment enough have left for the count to sit under the limit is
 * the answer.
 */
function personReset(buckets: readonly RelayCallBucket[], used: number, limit: number): Date {
  const mustLeave = used - limit + 1;
  const byHour = new Map<number, number>();
  for (const bucket of buckets) {
    const start = bucket.hourStart.getTime();
    byHour.set(start, (byHour.get(start) ?? 0) + bucket.calls);
  }
  let left = 0;
  for (const start of [...byHour.keys()].sort((a, b) => a - b)) {
    left += byHour.get(start) ?? 0;
    if (left >= mustLeave) return new Date(start + PERSON_WINDOW_HOURS * HOUR_MS);
  }
  // Reached only for a limit under 1, which the environment refuses: the newest hour's exit.
  return new Date(Math.max(...byHour.keys()) + PERSON_WINDOW_HOURS * HOUR_MS);
}
