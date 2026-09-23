import { FROM_CARD_CLOSE_MS, openedFromCard } from "@graft/core/connection/card.rules";
import { SETUP_AGENT_PARAM } from "@graft/core/setup/setup.rules";

/**
 * What the Setup page reads off its URL and does once Setup is finished (GRA-210). The page is
 * reached two more ways than the console's own intercept: `find_tool`'s offer relayed as a link
 * (`/setup?agent=<id>`), and the ask card's *Set up your first tool* button, which adds
 * `from=card` (`@graft/ask-card`'s `withFromCard`). Pure, so the route only carries it out.
 */

export type SetupSearch = { agent?: string; from?: "card" };

/** The route's search: the agent Setup should run as, and whether the card opened the page. */
export function readSetupSearch(search: Record<string, unknown>): SetupSearch {
  const agent = search[SETUP_AGENT_PARAM];
  return {
    ...(typeof agent === "string" && agent.length > 0 ? { agent } : {}),
    ...(openedFromCard(search) ? { from: "card" as const } : {}),
  };
}

/**
 * The agent the harness step starts as without asking: the one the URL names, when it is among the
 * person's active agents; otherwise the person's only one; otherwise none, and the step draws its
 * choice (several agents) or its harness list (none). A name for an agent that is not the person's,
 * or no longer active, is ignored rather than refused: the server judges the start again.
 */
export function agentToAdopt<T extends { id: string }>(
  activeAgents: readonly T[],
  named?: string,
): T | null {
  if (named) {
    const found = activeAgents.find((agent) => agent.id === named);
    if (found) return found;
  }
  return activeAgents.length === 1 ? (activeAgents[0] ?? null) : null;
}

/**
 * What the page does once `POST /api/setup/finish` succeeds. Opened from the card it tells its
 * opener and closes itself, as the handoff page does (`handoff-page.ts`; ADR 0006 as amended
 * 2026-09-21), since the person is in the chat and asks again there. It stays when the finish
 * issued a token, because the token is shown once and closing would lose it; and it stays for a
 * visit the card did not open, which ends on *Open the console* as before.
 */
export type AfterSetupFinish = { kind: "close" } | { kind: "stay" };

export function afterSetupFinish(
  search: SetupSearch,
  answer: { token: string | null },
): AfterSetupFinish {
  if (search.from !== "card" || answer.token !== null) return { kind: "stay" };
  return { kind: "close" };
}

/** How long the finished step stays before the page tries to close: the card popup's own delay. */
export const SETUP_CLOSE_MS = FROM_CARD_CLOSE_MS;
/** How long after asking to close before the page concludes the browser refused. */
export const SETUP_CLOSE_CHECK_MS = 200;

/** What the page says above the step while it was opened from the card, and once a close was refused. */
export const SETUP_FROM_CARD = {
  title: "Opened from the card in your chat",
  message:
    "Nothing typed here reaches the chat. Once you finish Setup, this window closes itself; then ask again in the chat.",
  doneTitle: "Setup is done",
  doneMessage: "You can close this window and ask again in the chat.",
} as const;
