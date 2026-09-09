import type { ApprovalDecision } from "@graft/db/schema/approval";

/**
 * ADR 0008 as a pure function: what happens when an agent calls a tool, given the tool's derived
 * annotations and the standing approval, if any. No `ctx`, no `deps`, so every branch of the rule
 * has a test that reads like the ADR.
 *
 * - A read-only tool **passes**, whatever the approval says — reads never ask.
 * - A tool that is not read-only with no approval **asks**; with `allow` it passes; with `deny` it
 *   is refused.
 * - A destructive tool **asks on every call** until the person relaxes it in the console, after
 *   which its `allow` holds like an ordinary write's. A `deny` on a destructive tool is a refusal
 *   whether or not it was relaxed.
 */

export type ToolAnnotations = { readOnly: boolean; destructive: boolean };

export type ApprovalState = { decision: ApprovalDecision; perCallRelaxed: boolean };

export type ApprovalVerdict = "pass" | "ask" | "deny";

export function approvalDecision(input: {
  annotations: ToolAnnotations;
  approval: ApprovalState | null;
}): ApprovalVerdict {
  const { annotations, approval } = input;
  if (annotations.readOnly) return "pass";
  if (!approval) return "ask";
  if (approval.decision === "deny") return "deny";
  if (annotations.destructive && !approval.perCallRelaxed) return "ask";
  return "pass";
}
