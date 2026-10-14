import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import {
  afterAnswer,
  HANDOFF_ANSWERED,
  HANDOFF_CLOSE_MS,
  handoffReadIsQuiet,
  handoffRefusal,
  handoffRefusalReason,
  handoffTitle,
  handoffView,
} from "./handoff-page";

const consumed = new ApiError(
  409,
  "CONFLICT",
  "This handoff link was already used; the agent has taken the answer",
  { reason: "consumed" },
);
const expired = new ApiError(
  410,
  "GONE",
  "This handoff link has expired; the agent will ask again if it still needs to",
  { reason: "expired" },
);
const tampered = new ApiError(
  403,
  "FORBIDDEN",
  "This handoff link is not one Graft issued for this action",
  { reason: "tampered" },
);
const open = { id: "pa_1", answeredAt: null };
const settled = { id: "pa_1", answeredAt: "2026-10-14T01:32:54.760Z" };

describe("handoffView (GRA-334)", () => {
  it("shows the settled card once this page answered, though the next read is refused consumed", () => {
    expect(
      handoffView({ pending: false, error: consumed, action: settled, answeredHere: true }),
    ).toEqual({ kind: "ask", action: settled });
  });

  it("shows the answered state when this page answered and the cache does not hold the answer", () => {
    expect(
      handoffView({ pending: false, error: consumed, action: open, answeredHere: true }),
    ).toEqual({ kind: "answered" });
    expect(
      handoffView({ pending: false, error: expired, action: open, answeredHere: true }),
    ).toEqual({ kind: "answered" });
  });

  it("keeps the open card while the read after an answer from here is still on its way", () => {
    expect(handoffView({ pending: false, error: null, action: open, answeredHere: true })).toEqual({
      kind: "ask",
      action: open,
    });
  });

  it("shows the ask on a good read and waits while the read is pending", () => {
    expect(
      handoffView({ pending: true, error: null, action: undefined, answeredHere: false }),
    ).toEqual({ kind: "loading" });
    expect(handoffView({ pending: false, error: null, action: open, answeredHere: false })).toEqual(
      {
        kind: "ask",
        action: open,
      },
    );
  });

  it("keeps a settled card on screen when a later read is refused", () => {
    expect(
      handoffView({ pending: false, error: consumed, action: settled, answeredHere: false }),
    ).toEqual({ kind: "ask", action: settled });
  });

  it("refuses a link that was already used on arrival, saying the ask was answered", () => {
    const view = handoffView({
      pending: false,
      error: consumed,
      action: undefined,
      answeredHere: false,
    });
    expect(view).toMatchObject({ kind: "refused", title: "This link was already used" });
    if (view.kind !== "refused") throw new Error("expected a refusal");
    expect(view.message).toContain("has been answered");
    expect(view.message).not.toContain("Nothing has been approved or declined");
  });

  it("refuses an expired or tampered link, saying nothing was answered", () => {
    expect(
      handoffView({ pending: false, error: expired, action: undefined, answeredHere: false }),
    ).toEqual({
      kind: "refused",
      title: "This link has expired",
      message:
        "This handoff link has expired; the agent will ask again if it still needs to. Nothing has been approved or declined.",
    });
    expect(handoffRefusal(tampered).title).toBe("This link is not one Graft issued");
  });
});

describe("the refusal's words", () => {
  it("reads the server's reason, and nothing else", () => {
    expect(handoffRefusalReason(consumed)).toBe("consumed");
    expect(handoffRefusalReason(new ApiError(404, "NOT_FOUND", "Pending action not found"))).toBe(
      null,
    );
    expect(handoffRefusalReason(new TypeError("Failed to fetch"))).toBe(null);
  });

  it("names a missing action and an unreachable server", () => {
    expect(handoffRefusal(new ApiError(404, "NOT_FOUND", "Pending action not found."))).toEqual({
      title: "There is no such pending action",
      message: "Pending action not found. Nothing has been approved or declined.",
    });
    expect(handoffRefusal(new TypeError("Failed to fetch")).message).toContain(
      "Could not reach the server",
    );
  });

  it("writes no em dash", () => {
    for (const error of [consumed, expired, tampered, new TypeError("Failed to fetch")]) {
      expect(handoffRefusal(error).message).not.toContain("—");
    }
    expect(HANDOFF_ANSWERED.message).not.toContain("—");
  });

  it("keeps a refusal out of the toast, where Retry cannot help, and not a transport failure", () => {
    expect(handoffReadIsQuiet(consumed)).toBe(true);
    expect(handoffReadIsQuiet(new TypeError("Failed to fetch"))).toBe(false);
  });
});

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
