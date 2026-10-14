import type { PendingActionClosedReason } from "@graft/db/schema/pending-action";

/**
 * How a finished ask reads on the console's Done list (GRA-292), browser-safe so the console and
 * the server read a row alike. Imports nothing but a type.
 */

/**
 * `answered`: the person answered it, whatever happened after. `closed`: a revoke closed it
 * unanswered, `closedReason` saying which. `expired`: it ran to its expiry unanswered, which is
 * also how an ask closed by a revoke before `closed_reason` existed (migration 0019) reads, since
 * nothing recorded the difference then.
 */
export type PendingActionDoneState = "answered" | "closed" | "expired";

export function pendingActionDoneState(row: {
  answeredAt: Date | null;
  closedReason: PendingActionClosedReason | null;
}): PendingActionDoneState {
  if (row.answeredAt) return "answered";
  return row.closedReason ? "closed" : "expired";
}

/**
 * When a finished ask finished: the answer's moment, else its expiry, which a revoke's close stamps
 * to the moment of the revoke. The Done list's order and cursor key (`@graft/db`'s
 * `listDonePendingActions` computes the same coalesce in SQL).
 */
export function pendingActionFinishedAt(row: { answeredAt: Date | null; expiresAt: Date }): Date {
  return row.answeredAt ?? row.expiresAt;
}

/**
 * What the ask was about, lifted out of its payload, so a Change action can read the approval that
 * stands **now** (`/approvals` for a tool, `/vendor-approvals` for an integration, the connection
 * for a build) rather than replay the answer given then. Null where the kind carries none: only a
 * `tool` ask names a tool, and a connection proposal names its connection only once answered with
 * one (`ConnectionAnswer`) or when it widens a row it already names.
 */
export type PendingActionSubject = {
  toolId: string | null;
  vendor: string | null;
  connectionId: string | null;
};

export function pendingActionSubject(row: {
  kind: string;
  payload: Record<string, unknown>;
  connectionId: string | null;
  answer: Record<string, unknown> | null;
}): PendingActionSubject {
  const widens = row.payload.widens;
  const widened =
    widens && typeof widens === "object"
      ? stringOf((widens as Record<string, unknown>).connectionId)
      : null;
  return {
    toolId: row.kind === "tool" ? stringOf(row.payload.toolId) : null,
    vendor: stringOf(row.payload.vendor),
    connectionId:
      row.connectionId ??
      stringOf(row.payload.connectionId) ??
      widened ??
      stringOf(row.answer?.connectionId),
  };
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
