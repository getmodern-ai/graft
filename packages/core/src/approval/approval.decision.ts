import type { ApprovalDecision } from "@graft/db/schema/approval";

/**
 * ADR 0008 as a pure function: what happens when an agent calls a tool, given the tool's derived
 * annotations and the standing approval, if any. No `ctx`, no `deps`, so every branch of the rule
 * has a test that reads like the ADR.
 *
 * - A read-only tool **passes**, whatever the approval says — reads never ask.
 * - Any other tool with no approval **asks**; with `allow` it passes; with `deny` it is refused.
 *   Destructive and write are one case here (ADR 0008, amendment of 2026-09-15): the destructive
 *   annotation changes what the ask *says*, not how often it comes.
 * - A tool the person has set to **ask every call** asks whatever its `allow` says; the standing
 *   row then carries the setting and the answer, and each call's yes is the pending action's.
 *   A `deny` is a refusal whether or not the setting is on.
 */

export type ToolAnnotations = { readOnly: boolean; destructive: boolean };

export type ApprovalState = { decision: ApprovalDecision; askEveryCall: boolean };

export type ApprovalVerdict = "pass" | "ask" | "deny";

export function approvalDecision(input: {
  annotations: ToolAnnotations;
  approval: ApprovalState | null;
}): ApprovalVerdict {
  const { annotations, approval } = input;
  if (annotations.readOnly) return "pass";
  if (!approval) return "ask";
  if (approval.decision === "deny") return "deny";
  if (approval.askEveryCall) return "ask";
  return "pass";
}
