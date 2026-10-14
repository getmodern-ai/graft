import { FROM_CARD_CLOSE_MS } from "@graft/core/connection/card.rules";

import { ApiError } from "./api";

/**
 * What the handoff page does once an ask is answered (GRA-144; ADR 0006 as amended 2026-09-21).
 *
 * The page a relayed link opens — `/pending/<id>?t=<token>` — is a focused page outside the console
 * shell: one ask, then done. Which "done" depends on how the person arrived, read from the route's
 * search and nothing else, so the decision is a function and the route only carries it out.
 *
 * - A **link visit** (`t` present) — a terminal harness's relayed link, or a chat product's card
 *   popup — closes itself: the agent finds the answer on its next call, and the person was
 *   somewhere else a moment ago. The card popup also tells its opener first (`from=card`, the
 *   contract `card.rules.ts` describes), which a terminal's tab has no opener to tell.
 * - A **console visit** (no `t`, the deep link typed or followed by hand) goes back to the list, as
 *   the page always did.
 *
 * A browser refuses `window.close()` on a tab the person opened themselves, so a link visit that is
 * still open a moment after asking shows the answered state instead — the same fallback the OAuth
 * callback page uses (`routes/oauth.callback.tsx`).
 */
export type HandoffVisit = { t?: string; from?: "card" };

export type AfterAnswer = { kind: "close"; announce: boolean } | { kind: "back-to-list" };

export function afterAnswer(visit: HandoffVisit): AfterAnswer {
  if (visit.t === undefined || visit.t.length === 0) return { kind: "back-to-list" };
  return { kind: "close", announce: visit.from === "card" };
}

/** How long the settled card stays before the page tries to close — the card popup's own delay. */
export const HANDOFF_CLOSE_MS = FROM_CARD_CLOSE_MS;
/** How long after asking to close before the page concludes the browser refused. */
export const HANDOFF_CLOSE_CHECK_MS = 200;

/** The answered state a link visit shows when the browser would not close the tab. */
export const HANDOFF_ANSWERED = {
  title: "Done",
  message:
    "You can close this tab. Your agent picks the answer up on its next call, and Pending actions in the console has the record.",
} as const;

/** The refusals the server names in `details.reason` for a link (`@graft/mcp`'s `handoff.ts`). */
export type HandoffRefusalReason = "tampered" | "expired" | "consumed";

/** The server's `details.reason` on a refused link read, or null for any other failure. */
export function handoffRefusalReason(error: unknown): HandoffRefusalReason | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("reason" in details)) return null;
  const reason = (details as { reason: unknown }).reason;
  return reason === "tampered" || reason === "expired" || reason === "consumed" ? reason : null;
}

/**
 * Whether a failed link read stays out of the global query toast (the read's `meta.quietError`,
 * which `query-error-retry.ts` asks). An answer from the server never toasts: the page draws it,
 * and Retry cannot reopen a link that was used, expired or never issued (GRA-334). A request that
 * never arrived still toasts, since Retry is what helps there.
 */
export function handoffReadIsQuiet(error: unknown): boolean {
  return error instanceof ApiError;
}

/** The refusal page's headline and sentence for a link that does not open. */
export function handoffRefusal(error: unknown): { title: string; message: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: "This link cannot be opened",
      message: "Could not reach the server. Nothing has been approved or declined.",
    };
  }
  const reason = handoffRefusalReason(error);
  // A used link is an answered ask: "nothing has been approved or declined" would be false.
  if (reason === "consumed") {
    return {
      title: "This link was already used",
      message:
        "This ask has been answered and your agent has taken the answer. Pending actions in the console has the record.",
    };
  }
  const title =
    reason === "tampered"
      ? "This link is not one Graft issued"
      : reason === "expired"
        ? "This link has expired"
        : error.status === 404
          ? "There is no such pending action"
          : "This link cannot be opened";
  return {
    title,
    message: `${error.message.replace(/\.$/, "")}. Nothing has been approved or declined.`,
  };
}

/** What a link visit draws. */
export type HandoffView<A> =
  | { kind: "loading" }
  | { kind: "ask"; action: A }
  | { kind: "answered" }
  | { kind: "refused"; title: string; message: string };

/**
 * A link visit's view from its read and whether this page answered (GRA-334).
 *
 * An answer given on this page settles it, whatever a later read says: once the agent takes the
 * answer, and for an answer the answer route consumes itself (a tool ask's, ADR 0008), every read of
 * the link is a `409 consumed`. So after an answer from here the page shows the settled card when
 * the cache holds the answer and the answered state when it does not, never the refusal. Before
 * that, a refused read is the refusal page, except that a settled ask already on screen stays.
 */
export function handoffView<A extends { answeredAt: string | null }>(read: {
  pending: boolean;
  error: unknown;
  action: A | undefined;
  answeredHere: boolean;
}): HandoffView<A> {
  const { pending, error, action, answeredHere } = read;
  if (answeredHere) {
    if (action?.answeredAt) return { kind: "ask", action };
    if (error) return { kind: "answered" };
  }
  if (pending) return { kind: "loading" };
  if (action && (!error || action.answeredAt)) return { kind: "ask", action };
  return { kind: "refused", ...handoffRefusal(error) };
}

/** The document title while the page is up: the agent's name when the ask names one. */
export function handoffTitle(agentName?: string | null): string {
  return agentName ? `Graft — ${agentName} asks` : "Graft — Pending action";
}
