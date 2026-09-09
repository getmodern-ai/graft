import type { BuildAskPayload, ToolAskPayload } from "@graft/mcp/approval";
import type { PendingActionCard } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";

/**
 * Pending actions and handoffs as the console sees them (ADR 0006, ADR 0008), on GRA-23's routes
 * (`apps/server/src/api.ts`, "Pending actions and approvals"). The card is the server's shape,
 * jsonified; its `payload` is the ask's own — `@graft/mcp`'s `ToolAskPayload` for a tool call,
 * `BuildAskPayload` for an `acquire` — and `readAsk` is the one place that narrows it, so a screen
 * never reads `payload.x` on faith. A later kind (GRA-28's connection and credential asks) adds a
 * branch here and a card file beside the others; `pending-action-card.tsx` dispatches on the kind.
 */

export type PendingAction = Jsonified<PendingActionCard>;

export type Ask =
  | { kind: "tool"; action: PendingAction; payload: Jsonified<ToolAskPayload> }
  | { kind: "build"; action: PendingAction; payload: Jsonified<BuildAskPayload> }
  | { kind: "other"; action: PendingAction };

/** Narrow a card's payload by its kind. A payload missing what its kind promises reads as `other`. */
export function readAsk(action: PendingAction): Ask {
  const payload = action.payload;
  if (action.kind === "tool" && typeof payload.toolId === "string") {
    return { kind: "tool", action, payload: payload as Jsonified<ToolAskPayload> };
  }
  if (action.kind === "build" && typeof payload.connectionId === "string") {
    return { kind: "build", action, payload: payload as Jsonified<BuildAskPayload> };
  }
  return { kind: "other", action };
}

/** The person's answer: `allow`, and for a destructive tool whether to relax its per-call ask too. */
export type PendingAnswer = { allow: boolean; relax?: boolean };

export const pendingKeys = {
  all: ["pending-actions"] as const,
  one: (id: string) => ["pending-actions", id] as const,
};

/** The open asks across every agent, newest first, each with its handoff link. */
export const pendingActionsQuery = queryOptions({
  queryKey: pendingKeys.all,
  queryFn: () => api<{ pendingActions: PendingAction[] }>("/pending-actions"),
});

/**
 * One action by its handoff link — the server verifies `t` against the row and refuses a tampered
 * (403), already-used (409) or expired (410) link with `details.reason`, which the page turns into
 * its refusal. A link is required here: without one the server refuses as tampered, and the list is
 * where a signed-in person reads an action they did not arrive at by link.
 */
export const pendingActionQuery = (id: string, token: string) =>
  queryOptions({
    queryKey: [...pendingKeys.one(id), token] as const,
    queryFn: () =>
      api<{ pendingAction: PendingAction }>(
        `/pending-actions/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`,
      ),
  });

export function answerPendingAction(id: string, answer: PendingAnswer) {
  return api<{ pendingAction: PendingAction }>(
    `/pending-actions/${encodeURIComponent(id)}/answer`,
    { method: "POST", body: answer },
  );
}

/** Whether the action can still be answered from here. */
export function isOpen(action: PendingAction, now: Date = new Date()): boolean {
  return action.answeredAt === null && new Date(action.expiresAt).getTime() > now.getTime();
}
