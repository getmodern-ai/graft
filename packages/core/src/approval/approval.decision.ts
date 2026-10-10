import type { ApprovalDecision } from "@graft/db/schema/approval";

import { stockLineageOf, type VersionOrigin } from "../stock/stock-advance.decision";

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
 * - **A new version asks again once** for a tool that is not read-only: an `allow` given for
 *   another version than the one this call runs asks, and the yes is then given for that version
 *   (ADR 0008's republish rule, which a remix follows; GRA-245). The version is the one the run
 *   executes, pinned before the gate, never a pointer read after it. A `deny` holds across a
 *   version, so a republish is no way past the person's no. A new *stock* version on an untouched
 *   copy carries the approval onto itself unless `annotationsWiden` says otherwise (ADR 0008 as
 *   amended 2026-10-09; `@graft/publish`'s `advanceStockCopy`), so its allow stays current.
 */

export type ToolAnnotations = { readOnly: boolean; destructive: boolean };

export type ApprovalState = {
  decision: ApprovalDecision;
  askEveryCall: boolean;
  /** Whether the answer was given for the version this call runs (`approval.tool_version_id`). */
  forThisVersion: boolean;
};

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
  if (!approval.forThisVersion) return "ask";
  return "pass";
}

/**
 * Whether a new version's annotations widen what the approval was given for: read-only to a write,
 * or non-destructive to destructive (ADR 0008 as amended 2026-10-09). A narrowing never does.
 */
export function annotationsWiden(previous: ToolAnnotations, next: ToolAnnotations): boolean {
  return (previous.readOnly && !next.readOnly) || (!previous.destructive && next.destructive);
}

/**
 * Whether an answer to an ask about one version of a stock copy holds for a later one (ADR 0008 as
 * amended 2026-10-09; GRA-245, Greptile on #190): an answer that arrives after a non-widening
 * advance would have been carried onto the new version had it been given before it. True only when
 * every version of the tool came from stock (an untouched copy, so every version after the asked one
 * is an advance), the asked version is earlier than `toVersionId`, and the annotations of `to` do
 * not widen the ones the ask showed. Judged against what the person was shown, not against each
 * step: an answer recorded before the advances would have been carried step by step.
 */
export function answerCarriesTo(input: {
  versions: readonly (VersionOrigin & { versionId: string; versionNumber: number })[];
  fromVersionId: string;
  toVersionId: string;
  shown: ToolAnnotations;
  to: ToolAnnotations;
}): boolean {
  if (stockLineageOf(input.versions) !== "stock") return false;
  const from = input.versions.find((version) => version.versionId === input.fromVersionId);
  const to = input.versions.find((version) => version.versionId === input.toVersionId);
  if (!from || !to || from.versionNumber >= to.versionNumber) return false;
  return !annotationsWiden(input.shown, input.to);
}
