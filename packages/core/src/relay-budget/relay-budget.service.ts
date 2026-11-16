import type { RelayBudgetVerdict } from "@graft/proxy/types";

import type { ServiceContext } from "../context";
import type { AgentScope } from "../tenancy";
import type { RelayBudgetDeps } from "./relay-budget.deps";
import {
  HOUR_MS,
  hasRelayBudget,
  hourStartOf,
  judgeRelayBudget,
  personWindowStart,
  type RelayBudgetLimits,
} from "./relay-budget.rules";

/**
 * The relay budget (GRA-349; ADR 0019 as amended 2026-11-14): counts a relayed call against the
 * agent's hour and the person's day, or refuses it. The proxy asks before every relayed call leaves
 * (`ProxyDeps.relayBudget`), with the scope off the capability token it verified.
 *
 * **Read, judge, then count.** Two statements, not one: a refused call is never counted, so a loop
 * that keeps knocking does not push its own reset further out. Two calls judged at the same moment
 * may both pass with one slot left, so the ceiling can be passed by as many calls as are in flight
 * at once for one person, a handful against a ceiling of hundreds; the alternative is a row lock
 * on every relayed call, which costs every honest call to bound a loop more tightly than it needs.
 */
export async function chargeRelayCall(
  ctx: ServiceContext,
  scope: AgentScope,
  limits: RelayBudgetLimits,
  deps: RelayBudgetDeps,
): Promise<RelayBudgetVerdict> {
  if (!hasRelayBudget(limits)) return { allowed: true };
  const now = deps.now();
  const verdict = await judgeAt(ctx, scope, limits, deps, now);
  if (verdict.allowed) await deps.recordRelayCall(ctx.db, scope, hourStartOf(now));
  return verdict;
}

/**
 * Whether the agent's next relayed call would go, counting nothing (GRA-350): the read and the
 * judgement `chargeRelayCall` makes, never its write. A run's door asks it before a sandbox is
 * touched for a tool whose connection relays (`@graft/mcp`'s `run.ts`). The proxy still charges
 * every call that leaves, so a peek that says yes promises nothing about the calls the run makes.
 */
export async function peekRelayBudget(
  ctx: ServiceContext,
  scope: AgentScope,
  limits: RelayBudgetLimits,
  deps: RelayBudgetDeps,
): Promise<RelayBudgetVerdict> {
  if (!hasRelayBudget(limits)) return { allowed: true };
  return judgeAt(ctx, scope, limits, deps, deps.now());
}

async function judgeAt(
  ctx: ServiceContext,
  scope: AgentScope,
  limits: RelayBudgetLimits,
  deps: RelayBudgetDeps,
  now: Date,
): Promise<RelayBudgetVerdict> {
  const buckets = await deps.listRelayCallBuckets(ctx.db, scope.personId, personWindowStart(now));
  return judgeRelayBudget({ agentId: scope.agentId, buckets, limits, now });
}

/** How long an hour's count is kept: twice the person's window, so nothing the budget reads is gone. */
export const RELAY_CALL_COUNT_RETENTION_MS = 48 * HOUR_MS;

/** Delete every hour of counts past the retention, whoever's: run on the sweep's timer. */
export async function pruneRelayCallCounts(
  ctx: ServiceContext,
  deps: RelayBudgetDeps,
): Promise<number> {
  const before = new Date(hourStartOf(deps.now()).getTime() - RELAY_CALL_COUNT_RETENTION_MS);
  return deps.deleteRelayCallCountsBefore(ctx.db, before);
}
