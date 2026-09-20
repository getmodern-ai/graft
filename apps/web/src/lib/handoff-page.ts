import { FROM_CARD_CLOSE_MS } from "@graft/core/connection/card.rules";

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
    "You can close this tab — your agent picks the answer up on its next call, and Pending actions in the console has the record.",
} as const;

/** The document title while the page is up: the agent's name when the ask names one. */
export function handoffTitle(agentName?: string | null): string {
  return agentName ? `Graft — ${agentName} asks` : "Graft — Pending action";
}
