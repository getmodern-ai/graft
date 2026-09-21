import { describe, expect, it } from "vitest";

import { afterAnswer, HANDOFF_ANSWERED, HANDOFF_CLOSE_MS, handoffTitle } from "./handoff-page";

describe("afterAnswer", () => {
  it("closes a link visit from a terminal harness, telling no opener", () => {
    expect(afterAnswer({ t: "h_token" })).toEqual({ kind: "close", announce: false });
  });

  it("closes a card popup and tells its opener first, as the card contract asks", () => {
    expect(afterAnswer({ t: "h_token", from: "card" })).toEqual({ kind: "close", announce: true });
  });

  it("goes back to the list on a console visit with no token", () => {
    expect(afterAnswer({})).toEqual({ kind: "back-to-list" });
    expect(afterAnswer({ t: "" })).toEqual({ kind: "back-to-list" });
  });

  it("does not let from=card alone turn a console visit into a popup", () => {
    expect(afterAnswer({ from: "card" })).toEqual({ kind: "back-to-list" });
  });
});

describe("the answered state and the title", () => {
  it("tells the person they can close the tab and where the record is", () => {
    expect(HANDOFF_ANSWERED.title).toBe("Done");
    expect(HANDOFF_ANSWERED.message).toContain("close this tab");
    expect(HANDOFF_ANSWERED.message).toContain("Pending actions");
    expect(HANDOFF_CLOSE_MS).toBeGreaterThan(0);
  });

  it("names the agent in the title when the ask names one", () => {
    expect(handoffTitle("laptop Hermes")).toBe("Graft — laptop Hermes asks");
    expect(handoffTitle(null)).toBe("Graft — Pending action");
  });
});
