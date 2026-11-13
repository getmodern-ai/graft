import {
  chargeRelayCall,
  defaultRelayBudgetDeps,
  hasRelayBudget,
  peekRelayBudget,
  pruneRelayCallCounts,
  type RelayBudgetDeps,
  type RelayBudgetLimits,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { RelayBudgetPeek, RelayBudgetRefusedEvent } from "@graft/mcp";
import type { Capture } from "@graft/observability";
import type { ProxyEvent, RelayBudget } from "@graft/proxy";

/**
 * The server's half of the relay budget (GRA-349; ADR 0019 as amended 2026-11-14): the ceilings
 * read off the environment, the proxy's hook bound to Postgres through `@graft/core`, the boot
 * line's clause, and the prune on the sweep's cadence. Unset, there is no hook at all, so a
 * deployment with no ceiling pays nothing per relayed call.
 */

/** The two ceilings as the environment set them; absent is no ceiling. */
export function relayBudgetLimitsFrom(env: {
  GRAFT_RELAY_BUDGET_AGENT_HOURLY?: number | undefined;
  GRAFT_RELAY_BUDGET_PERSON_DAILY?: number | undefined;
}): RelayBudgetLimits {
  return {
    agentHourly: env.GRAFT_RELAY_BUDGET_AGENT_HOURLY ?? null,
    personDaily: env.GRAFT_RELAY_BUDGET_PERSON_DAILY ?? null,
  };
}

/** The boot line's clause: `, relay budget off`, or the ceilings that are set. */
export function relayBudgetClause(limits: RelayBudgetLimits): string {
  if (!hasRelayBudget(limits)) return ", relay budget off";
  const parts = [
    limits.agentHourly !== null ? `${limits.agentHourly}/agent-hour` : null,
    limits.personDaily !== null ? `${limits.personDaily}/person-day` : null,
  ].filter((part) => part !== null);
  return `, relay budget ${parts.join(" ")}`;
}

/** The proxy's hook over the database, or undefined when no ceiling is set. */
export function createRelayBudget(
  db: DbOrTx,
  limits: RelayBudgetLimits,
  deps: RelayBudgetDeps = defaultRelayBudgetDeps,
): RelayBudget | undefined {
  if (!hasRelayBudget(limits)) return undefined;
  return {
    charge: (call) =>
      chargeRelayCall({ db }, { personId: call.personId, agentId: call.agentId }, limits, deps),
  };
}

/**
 * Delete the counts the budget no longer reads, on a plain timer beside the working-set sweep's
 * and on its cadence. Nothing runs when no ceiling is set, since nothing is written. The timer
 * does not hold the process open.
 */
export function startRelayCallPrune(
  db: DbOrTx,
  limits: RelayBudgetLimits,
  options: { intervalSeconds: number; onError: (error: unknown) => void },
  deps: RelayBudgetDeps = defaultRelayBudgetDeps,
): { stop: () => void } {
  if (!hasRelayBudget(limits)) return { stop: () => undefined };
  const timer = setInterval(() => {
    pruneRelayCallCounts({ db }, deps).catch(options.onError);
  }, options.intervalSeconds * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * The run's door reads the budget through this (GRA-350; `@graft/mcp`'s `relay-budget-door.ts`):
 * `@graft/core`'s `peekRelayBudget` over the count and ceilings the proxy charges against, so the
 * door and the proxy judge alike. Undefined when no ceiling is set, so `McpDeps.relayBudget` stays
 * unset and the door asks nothing.
 */
export function createRelayBudgetPeek(
  db: DbOrTx,
  limits: RelayBudgetLimits,
  deps: RelayBudgetDeps = defaultRelayBudgetDeps,
): RelayBudgetPeek | undefined {
  if (!hasRelayBudget(limits)) return undefined;
  return { peek: (scope) => peekRelayBudget({ db }, scope, limits, deps) };
}

/** How many agent, ceiling and window keys the capture below holds before it forgets the oldest. */
export const RELAY_BUDGET_EXHAUSTED_KEYS = 10_000;

/**
 * `relay_budget_exhausted` (GRA-350; `@graft/observability`'s `events.ts`), off the proxy's event
 * and off the run's door: captured for a call or a run the budget refused, at most once per agent,
 * ceiling and window across the two, so a loop
 * knocking on a spent budget all hour is one event. The window is the refusal's `resetsAt`, so a
 * ceiling still spent in a later window is counted again.
 *
 * The keys live in this process, bounded: a key whose window has passed is dropped as a new one
 * lands, and past `maxKeys` the oldest goes. A restart or a second replica may count one window
 * twice; that is a duplicate on a chart, never a loop unseen.
 */
export function createRelayBudgetExhaustedCapture(
  capture: (input: Capture) => void,
  options: { maxKeys?: number; now?: () => number } = {},
): {
  /** A call the proxy refused (`ServerDeps.onProxyEvent`). */
  fromProxyEvent: (event: ProxyEvent) => void;
  /**
   * A run the door refused (`McpDeps.onRelayBudgetRefused`): a loop of one relayed call per run
   * fills the budget on an allowed call and then meets only the door, so the proxy never refuses
   * it (Greptile on #299). The same keys, so a window counted by either is not counted by the other.
   */
  fromDoor: (event: RelayBudgetRefusedEvent) => void;
} {
  const maxKeys = options.maxKeys ?? RELAY_BUDGET_EXHAUSTED_KEYS;
  const now = options.now ?? Date.now;
  /** key -> when its window ends, in insertion order. */
  const seen = new Map<string, number>();
  const count = (input: {
    personId: string;
    agentId: string;
    ceiling: string;
    limit: number;
    used: number;
    resetsAt: string;
    tool: string | null;
    relay: string | null;
    dryRun: boolean;
  }) => {
    const key = `${input.agentId}|${input.ceiling}|${input.resetsAt}`;
    if (seen.has(key)) return;
    const at = now();
    for (const [old, endsAt] of seen) {
      if (endsAt <= at) seen.delete(old);
    }
    while (seen.size >= maxKeys) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    seen.set(key, Date.parse(input.resetsAt));
    capture({
      distinctId: input.personId,
      event: "relay_budget_exhausted",
      properties: {
        ceiling: input.ceiling,
        limit: input.limit,
        used: input.used,
        resets_at: input.resetsAt,
        tool: input.tool,
        agent_id: input.agentId,
        relay: input.relay,
        dry_run: input.dryRun,
      },
    });
  };
  return {
    fromProxyEvent: (event) => {
      const budget = event.budget;
      if (budget?.outcome !== "exhausted" || !event.personId || !event.agentId) return;
      count({
        personId: event.personId,
        agentId: event.agentId,
        ceiling: budget.ceiling,
        limit: budget.limit,
        used: budget.used,
        resetsAt: budget.resetsAt,
        tool: event.tool,
        relay: event.relay,
        dryRun: event.dryRun,
      });
    },
    fromDoor: (event) =>
      count({
        personId: event.personId,
        agentId: event.agentId,
        ceiling: event.verdict.ceiling,
        limit: event.verdict.limit,
        used: event.verdict.used,
        resetsAt: event.verdict.resetsAt.toISOString(),
        tool: event.tool,
        relay: event.relay,
        dryRun: event.dryRun,
      }),
  };
}
