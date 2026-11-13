import {
  chargeRelayCall,
  defaultRelayBudgetDeps,
  hasRelayBudget,
  pruneRelayCallCounts,
  type RelayBudgetDeps,
  type RelayBudgetLimits,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { RelayBudget } from "@graft/proxy";

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
