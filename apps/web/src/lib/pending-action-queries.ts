import type { BuildAskPayload, ToolAskPayload } from "@graft/mcp/approval";
import type {
  ConnectionProposalPayload,
  CredentialAskPayload,
  ScopeAskPayload,
} from "@graft/mcp/connection-request";
import type { AnswerBody, DonePendingActionsOutput, PendingActionCard } from "@graft/server/api";
import { infiniteQueryOptions, type QueryClient, queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import { handoffReadIsQuiet } from "./handoff-page";

/**
 * Pending actions and handoffs as the console sees them (ADR 0006, ADR 0008), on GRA-23's routes
 * (`apps/server/src/api.ts`, "Pending actions and approvals"). The card is the server's shape,
 * jsonified; its `payload` is the ask's own — `@graft/mcp`'s `ToolAskPayload` for a tool call,
 * `BuildAskPayload` for an `acquire`, `ConnectionProposalPayload` and `CredentialAskPayload` for
 * GRA-28's two connection handoffs, `ScopeAskPayload` for GRA-104's ask to use a connection the
 * person already holds — and `readAsk` is the one place that narrows it, so a screen never reads
 * `payload.x` on faith. A later kind adds a branch here and a card file beside the others;
 * `pending-action-card.tsx` dispatches on the kind.
 */

export type PendingAction = Jsonified<PendingActionCard>;

export type Ask =
  | { kind: "tool"; action: PendingAction; payload: Jsonified<ToolAskPayload> }
  | { kind: "build"; action: PendingAction; payload: Jsonified<BuildAskPayload> }
  | { kind: "connection"; action: PendingAction; payload: Jsonified<ConnectionProposalPayload> }
  /** A `connection` ask a provider that connects with a link covers (ADR 0019; GRA-59): one button, no form. */
  | {
      kind: "connection-link";
      action: PendingAction;
      payload: Jsonified<ConnectionProposalPayload> & { provider: string };
    }
  | { kind: "credential"; action: PendingAction; payload: Jsonified<CredentialAskPayload> }
  /** An agent's ask to use a connection the person holds that it was not given (GRA-104). */
  | { kind: "scope"; action: PendingAction; payload: Jsonified<ScopeAskPayload> }
  | { kind: "other"; action: PendingAction };

/** The handoff token's query parameter, as `@graft/mcp`'s `handoff.ts` names it in every `url`. */
export const HANDOFF_TOKEN_PARAM_NAME = "t";

/** Narrow a card's payload by its kind. A payload missing what its kind promises reads as `other`. */
export function readAsk(action: PendingAction): Ask {
  const payload = action.payload;
  if (action.kind === "tool" && typeof payload.toolId === "string") {
    return { kind: "tool", action, payload: payload as Jsonified<ToolAskPayload> };
  }
  if (action.kind === "build" && typeof payload.connectionId === "string") {
    return { kind: "build", action, payload: payload as Jsonified<BuildAskPayload> };
  }
  if (
    action.kind === "connection" &&
    typeof payload.vendor === "string" &&
    typeof payload.primaryHost === "string" &&
    typeof payload.scheme === "string" &&
    Array.isArray(payload.hosts)
  ) {
    // The provider the proposal was routed to draws the card: a link provider's has a button where
    // the keyring's has the form. An ask recorded before providers existed is the keyring's.
    if (payload.providerConnect === "link" && typeof payload.provider === "string") {
      return {
        kind: "connection-link",
        action,
        payload: payload as Jsonified<ConnectionProposalPayload> & { provider: string },
      };
    }
    return { kind: "connection", action, payload: payload as Jsonified<ConnectionProposalPayload> };
  }
  if (
    action.kind === "credential" &&
    typeof payload.connectionId === "string" &&
    typeof payload.scheme === "string"
  ) {
    return { kind: "credential", action, payload: payload as Jsonified<CredentialAskPayload> };
  }
  if (
    action.kind === "scope" &&
    typeof payload.connectionId === "string" &&
    typeof payload.vendor === "string" &&
    typeof payload.displayName === "string" &&
    Array.isArray(payload.hosts)
  ) {
    return { kind: "scope", action, payload: payload as Jsonified<ScopeAskPayload> };
  }
  return { kind: "other", action };
}

/**
 * The person's answer: `allow`; for a tool ask whether it should ask every call from now on
 * (absent leaves the setting as it stands); for a scope ask whether the agent may also build
 * against the connection (GRA-104). The server's `answerBody`, imported rather than written twice.
 */
export type PendingAnswer = AnswerBody;

export const pendingKeys = {
  all: ["pending-actions"] as const,
  /** Under `all`, so every invalidation of the inbox refreshes Done too. Two parts, never a link read's three. */
  done: ["pending-actions", "done"] as const,
  one: (id: string) => ["pending-actions", id] as const,
};

/** The open asks across every agent, newest first, each with its handoff link. */
export const pendingActionsQuery = queryOptions({
  queryKey: pendingKeys.all,
  queryFn: () => api<{ pendingActions: PendingAction[] }>("/pending-actions"),
});

/**
 * Requests > Done (GRA-292's read; GRA-312): the finished asks, newest finish first, a page at a
 * time by the server's opaque cursor, which "Show older" follows.
 */
export const donePendingActionsQuery = infiniteQueryOptions({
  queryKey: pendingKeys.done,
  queryFn: ({ pageParam }) =>
    api<Jsonified<DonePendingActionsOutput>>(
      `/pending-actions?state=done${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
    ),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.nextCursor,
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
    // A link is read once per visit: the server settles its answer on the first read, and a link
    // it refused (consumed, expired, tampered) will not open on a later one. Left at the defaults,
    // a settled tab re-read its link every time it regained focus — 210 refused reads from three
    // tabs in one day (GRA-164). The page's own answer path updates the cache without a refetch.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // The page draws every refusal itself and a Retry cannot reopen a link (GRA-334).
    meta: { quietError: handoffReadIsQuiet },
  });

/** Whether a query key is a link read (`pendingActionQuery`) rather than the list. */
export function isLinkReadKey(queryKey: readonly unknown[], id?: string): boolean {
  return (
    queryKey.length === 3 &&
    queryKey[0] === pendingKeys.all[0] &&
    (id === undefined || queryKey[1] === id)
  );
}

/**
 * The answer route's record: the row, not the card, so only the answer's own fields are read off
 * it (`recordApprovalAnswer` in `@graft/mcp`'s `ask-answer.ts`).
 */
export type AnswerRecord = {
  pendingAction: Pick<PendingAction, "answeredAt" | "answer" | "consumedAt">;
};

export function answerPendingAction(id: string, answer: PendingAnswer) {
  return api<AnswerRecord>(`/pending-actions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: answer,
  });
}

/**
 * After an answer through the answer route: the link reads of this ask take the recorded answer
 * from the reply, and every other pending read is refetched. A link read is never refetched here,
 * because the answer route consumes a tool ask's answer in the same transaction and the agent
 * takes the rest, so the read would answer `409 consumed` for an answer just given (GRA-334).
 */
export function settleAnsweredAsk(queryClient: QueryClient, id: string, record: AnswerRecord) {
  const { answeredAt, answer, consumedAt } = record.pendingAction;
  queryClient.setQueriesData<{ pendingAction: PendingAction }>(
    { queryKey: pendingKeys.one(id) },
    (current) =>
      current
        ? { pendingAction: { ...current.pendingAction, answeredAt, answer, consumedAt } }
        : current,
  );
  void queryClient.invalidateQueries({
    queryKey: pendingKeys.all,
    predicate: (query) => !isLinkReadKey(query.queryKey, id),
  });
}

/** Whether the action can still be answered from here. */
export function isOpen(action: PendingAction, now: Date = new Date()): boolean {
  return action.answeredAt === null && new Date(action.expiresAt).getTime() > now.getTime();
}
