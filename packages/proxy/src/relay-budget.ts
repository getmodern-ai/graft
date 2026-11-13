import { describeFailure, type Refused, refuse } from "./failure";
import type {
  ProxyBudgetTrace,
  RelayBudget,
  RelayBudgetCall,
  RelayBudgetCeiling,
  RelayBudgetVerdict,
} from "./types";

/**
 * The relay budget's rung (GRA-349; ADR 0019 as amended 2026-11-14). A relayed call costs the
 * deployment whatever its upstream charges, and one looping agent once made tens of thousands of
 * them. So just before each relayed hop is sent, the host's budget counts it or refuses it.
 * The proxy holds no store and no numbers: it asks, and turns a refusal into a 429 the caller and
 * the wide event can both read.
 *
 * **It fails open.** A counter that throws lets the call through and says so on the event, as the
 * rate limiter does (`@graft/ratelimit`): a store's hiccup must not close the one route to a vendor.
 */

/** Whole seconds until `resetsAt`, at least 1: a `Retry-After` of 0 says "retry now", which it just did. */
export function retryAfterSeconds(resetsAt: Date, nowMs: number): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - nowMs) / 1000));
}

/** `2026-10-12 14:00 UTC`: what the sentence names, read by an agent and relayed to a person. */
function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The refusal's sentence: which ceiling, the count that reached it, when calls resume, and the
 * likeliest cause. A result, not a description, so the advice to stop is allowed here.
 */
export function relayBudgetMessage(verdict: {
  ceiling: RelayBudgetCeiling;
  limit: number;
  used: number;
  resetsAt: Date;
}): string {
  const advice =
    "An agent that reaches this limit is usually calling the same tool in a loop: stop, and tell the person what you were doing.";
  if (verdict.ceiling === "agent_hour") {
    return `This agent has made ${count(verdict.used)} relayed calls this hour, its limit of ${count(verdict.limit)} an hour; relayed calls resume at ${utc(verdict.resetsAt)}. ${advice}`;
  }
  return `This person's agents have made ${count(verdict.used)} relayed calls in the last 24 hours, the limit of ${count(verdict.limit)} a day; relayed calls resume from ${utc(verdict.resetsAt)}. ${advice}`;
}

/**
 * Ask the budget about one relayed call. Null when the call may go (counted, or the counter could
 * not answer); a 429 refusal when a ceiling refused it. Either way `trace.budget` records what
 * happened, except on a plain allowed call, which is the event's null.
 */
export async function chargeRelayBudget(
  budget: RelayBudget,
  call: RelayBudgetCall,
  nowMs: number,
  trace: { budget: ProxyBudgetTrace | null },
  requestBytes: number,
): Promise<Refused | null> {
  let verdict: RelayBudgetVerdict;
  try {
    verdict = await budget.charge(call);
  } catch (error) {
    trace.budget = { outcome: "unavailable", failure: describeFailure(error) };
    return null;
  }
  if (verdict.allowed) return null;
  trace.budget = {
    outcome: "exhausted",
    ceiling: verdict.ceiling,
    limit: verdict.limit,
    used: verdict.used,
    resetsAt: verdict.resetsAt.toISOString(),
  };
  return refuse(429, "relay_budget_exhausted", relayBudgetMessage(verdict), {
    requestBytes,
    retryAfterSeconds: retryAfterSeconds(verdict.resetsAt, nowMs),
  });
}
