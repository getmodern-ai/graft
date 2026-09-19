import { describe, expect, it } from "vitest";

import { askAnsweredMessage, FROM_CARD, FROM_CARD_PARAM, openedFromCard } from "./card.rules";
import { linkCallbackRedirect, readLinkCallbackSearch } from "./link.rules";

/**
 * The `from=card` flag the ask card puts on every page it opens (GRA-117, GRA-118), on both
 * sides: the console's reader, and the link's redirect that carries it through from the server's
 * return route. The card's own writer is `@graft/ask-card`'s `withFromCard`, pinned to these two
 * words in `packages/mcp/src/ask-card.test.ts`.
 */
describe("from=card", () => {
  it("is read off a route's search, and off nothing else", () => {
    expect(openedFromCard({ [FROM_CARD_PARAM]: FROM_CARD })).toBe(true);
    expect(openedFromCard({ t: "abc", from: "card" })).toBe(true);
    expect(openedFromCard({ from: "console" })).toBe(false);
    expect(openedFromCard({})).toBe(false);
    expect(openedFromCard({ from: ["card"] })).toBe(false);
  });

  it("rides the link's console redirect only when the return route says so", () => {
    const outcome = {
      status: "connected" as const,
      pendingActionId: "pa_1",
      connectionId: "conn_1",
      message: "Gmail is connected.",
    };
    const plain = new URL(linkCallbackRedirect("http://console.graft.test", outcome));
    expect(plain.searchParams.has(FROM_CARD_PARAM)).toBe(false);
    const fromCard = new URL(
      linkCallbackRedirect("http://console.graft.test", outcome, { fromCard: true }),
    );
    const search = Object.fromEntries(fromCard.searchParams);
    expect(openedFromCard(search)).toBe(true);
    // The outcome reads back whole beside it.
    expect(readLinkCallbackSearch(search)).toEqual(outcome);
  });

  it("names the ask in the message the handoff page posts its opener", () => {
    expect(askAnsweredMessage("pa_1")).toEqual({ type: "graft:ask", pendingActionId: "pa_1" });
  });
});
