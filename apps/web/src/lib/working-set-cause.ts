import type { WorkingSetChange } from "./agent-queries";

/**
 * Why the working set changed, in the person's words (ADR 0009: expansion has an author, and
 * contraction has three: the agent, the rule, and a revoke). The cause is the record's own word;
 * this is the sentence beside it in the agent's history (`components/agent/working-set-history.tsx`).
 * A `revoke` says the tool left because it could not run, not because it was unwanted (ADR 0009
 * as amended 2026-09-18, GRA-69); the card's description says promote brings it back.
 */
export const WORKING_SET_CAUSE: Record<WorkingSetChange["cause"], string> = {
  agent: "The agent asked",
  publish: "Published by the agent",
  idle: "Unused past the idle window",
  cap: "Over the working-set cap",
  revoke: "Its connection was revoked",
};
