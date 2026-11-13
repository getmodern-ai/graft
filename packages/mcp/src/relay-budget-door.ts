import type { AgentScope } from "@graft/core";
import { relayBudgetMessage } from "@graft/proxy/relay-budget";
import { isRelayScheme, type RelayBudgetVerdict } from "@graft/proxy/types";

/**
 * The relay budget's door (GRA-350; ADR 0019 as amended 2026-11-14). The proxy counts every relayed
 * call and refuses past a ceiling (GRA-349), so a run by an agent already past one would reach a
 * sandbox only to have each of its calls refused. `run.ts` asks here once the connection the run
 * goes over is resolved and the input is valid, before the approval gate and the blob door, so
 * `run_tool`, an authored tool's own name and the console's run (`apps/server/src/tool-run.ts`),
 * which all run through `runAuthoredTool`, are refused alike. A dry run is too: its reads are
 * relayed and counted.
 *
 * **It peeks and never charges.** The proxy stays the one place a call is counted and the one place
 * a ceiling is enforced; a yes here promises nothing about the calls the run then makes, and a run
 * that crosses a ceiling part-way is answered by the proxy's refusal (`run.ts`'s `proxyLimit`).
 * **It fails open**, as the proxy's rung does: a peek that throws lets the run go.
 */

/** The budget as the door reads it: `@graft/core`'s `peekRelayBudget` bound by the server. */
export type RelayBudgetPeek = {
  peek: (scope: Pick<AgentScope, "personId" | "agentId">) => Promise<RelayBudgetVerdict>;
};

/** The refusal's reason, the proxy's word for the same ceiling. */
export const RELAY_BUDGET_EXHAUSTED = "relay_budget_exhausted";

/**
 * The refusal for a run past a ceiling, with the proxy's own sentence (`relayBudgetMessage`), or
 * null when the run may go: no row read, a connection that does not relay, a budget with room, or
 * a peek that failed.
 */
export async function relayBudgetSpent(
  budget: RelayBudgetPeek,
  scope: Pick<AgentScope, "personId" | "agentId">,
  connection: { scheme: string } | null,
): Promise<{ reason: typeof RELAY_BUDGET_EXHAUSTED; message: string } | null> {
  if (!connection || !isRelayScheme(connection.scheme)) return null;
  let verdict: RelayBudgetVerdict;
  try {
    verdict = await budget.peek({ personId: scope.personId, agentId: scope.agentId });
  } catch {
    return null;
  }
  if (verdict.allowed) return null;
  return { reason: RELAY_BUDGET_EXHAUSTED, message: relayBudgetMessage(verdict) };
}
