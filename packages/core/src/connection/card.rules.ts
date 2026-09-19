/**
 * What the console and the ask card say to each other about a page the card opened (GRA-117,
 * GRA-118; ADR 0006 as amended). Pure and **browser-safe**, like `link.rules.ts`: the console's
 * routes read the query this file describes, so it imports nothing.
 *
 * The card — the MCP App a chat product renders (`packages/ask-card`) — cannot enter a secret, and
 * cannot start a provider's sign-in itself, so for those asks it opens a console page in the
 * person's browser: the handoff URL for a credential-taking ask, the provider's link for a
 * link-provider ask, whose return lands on the console's `/link/callback`. Both URLs carry
 * `from=card`, and a console page that finds it does two things once its work is done: tells the
 * window that opened it, at its own origin, and closes itself, since the card is where the person
 * is and settles on its own by polling `ask_status`. Without the flag the pages behave as they
 * always did — the handoff page goes back to the list, the callback page stays up for a person who
 * came from the console.
 *
 * The two words are written once more in `@graft/ask-card`'s `shape.ts`, which is import-free by
 * design; `packages/mcp/src/ask-card.test.ts` pins the two copies to each other.
 */

export const FROM_CARD_PARAM = "from";
export const FROM_CARD = "card";

/** Whether a route's search says the card opened this page. */
export function openedFromCard(search: Record<string, unknown>): boolean {
  return search[FROM_CARD_PARAM] === FROM_CARD;
}

/**
 * The message the handoff page posts to its opener once an ask is answered under `from=card`
 * (GRA-118) — a status word and the ask, nothing entered. The card cannot receive it across the
 * host's origin and polls instead; a console tab that opened the page can.
 */
export type AskAnsweredMessage = { type: "graft:ask"; pendingActionId: string };

export const ASK_ANSWERED_MESSAGE_TYPE = "graft:ask" satisfies AskAnsweredMessage["type"];

export function askAnsweredMessage(pendingActionId: string): AskAnsweredMessage {
  return { type: ASK_ANSWERED_MESSAGE_TYPE, pendingActionId };
}

/** How long a page the card opened stays up after its work is done before closing itself. */
export const FROM_CARD_CLOSE_MS = 1500;
