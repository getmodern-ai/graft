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
 * What the page does once `POST /api/setup/finish` succeeds (GRA-215, *Finish Setup behaves*): one
 * press completes the record and leaves. Opened from the card it tells its opener and closes
 * itself, as the handoff page does (`handoff-page.ts`; ADR 0006 as amended 2026-09-21), since the
 * person is in the chat and asks again there. Opened in the console it goes to the agent's page,
 * or the agents table when the agent is gone, with a toast saying the tool is ready. It stays only
 * when the finish itself issued a token, which is shown once and would be lost by leaving: the
 * finish step issues a token harness's before the press, so that is a token issued for a record
 * another tab left unissued.
 *
 * GRA-208 stayed on every visit the card did not open, ending on *Open the console*: the finish
 * looked like it had done nothing, *Skip for now* vanished, and it took a second press to leave
 * (Aleks's walkthrough, 2026-09-24).
 */
export type AfterSetupFinish =
  | { kind: "close" }
  | { kind: "stay" }
  | { kind: "leave"; to: "/agents" }
  | { kind: "leave"; to: "/agents/$agentId"; agentId: string };

export function afterSetupFinish(
  search: SetupSearch,
  answer: { token: string | null; agent: { id: string } | null },
): AfterSetupFinish {
  if (answer.token !== null) return { kind: "stay" };
  if (search.from === "card") return { kind: "close" };
  return answer.agent
    ? { kind: "leave", to: "/agents/$agentId", agentId: answer.agent.id }
    : { kind: "leave", to: "/agents" };
}

/**
 * The toast the console shows on arriving at the agent's page from the finish: that Setup is done,
 * and where the tool stands, landed (its wire name), still arriving, or not there at all.
 */
export function setupFinishedToast(
  agentName: string,
  tool: { kind: "landed"; wireName: string } | { kind: "arriving" } | { kind: "none" },
): { title: string; description: string } {
  const description =
    tool.kind === "landed"
      ? `${tool.wireName} is ready in ${agentName}'s tools.`
      : tool.kind === "arriving"
        ? `The tool joins ${agentName}'s tools when its job passes.`
        : `${agentName} is ready. Ask it for what you wanted and Graft acquires it.`;
  return { title: "Setup is complete", description };
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
