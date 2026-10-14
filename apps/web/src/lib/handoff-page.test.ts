import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import {
  afterAnswer,
  HANDOFF_ANSWERED,
  HANDOFF_CLOSE_MS,
  handoffAnswered,
  handoffFootnote,
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
const NOW = new Date("2026-10-14T12:00:00.000Z");
const expiredForOwner = new ApiError(
  410,
  "GONE",
  "This handoff link has expired; the agent will ask again if it still needs to",
  {
    reason: "expired",
    kind: "connection",
    agentName: "Hermes",
    integrationName: "Unleashed",
    askedAt: "2026-10-13T12:00:00.000Z",
  },
);
const closedByRevoke = (closedReason: "agent_revoked" | "connection_revoked") =>
  new ApiError(410, "GONE", "This ask was closed", {
    reason: "closed",
    closedReason,
    kind: "tool",
    agentName: "Codex",
    integrationName: "Gmail",
    askedAt: "2026-10-14T11:00:00.000Z",
  });
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
    expect(view).toMatchObject({ kind: "refused", title: "This request was already answered" });
    if (view.kind !== "refused") throw new Error("expected a refusal");
    expect(view.message).toContain("has taken the answer");
    expect(view.message).not.toContain("Nothing has been approved or declined");
  });

  it("refuses an expired request with the hourglass, and a tampered one saying nothing was answered", () => {
    expect(
      handoffView({ pending: false, error: expired, action: undefined, answeredHere: false }),
    ).toEqual({
      kind: "refused",
      refusal: "expired",
      title: "This request has expired",
      message: "If your agent still needs it, it'll ask again.",
    });
    expect(handoffRefusal(tampered)).toMatchObject({
      kind: "refused",
      title: "Graft did not issue this request",
    });
    expect(handoffRefusal(tampered).message).toContain("Nothing has been approved or declined");
  });

  it("names the agent, when it asked and the integration on an expired request (GRA-314)", () => {
    expect(handoffRefusal(expiredForOwner, NOW)).toEqual({
      kind: "expired",
      title: "This request has expired",
      message: "Hermes asked yesterday. If it still needs Unleashed, it'll ask again.",
    });
  });

  it("tells a request a revoke closed apart from one that expired", () => {
    expect(handoffRefusal(closedByRevoke("agent_revoked"), NOW)).toEqual({
      kind: "expired",
      title: "This request was closed",
      message: "Codex was revoked, so its request closed without an answer.",
    });
    expect(handoffRefusal(closedByRevoke("connection_revoked"), NOW).message).toBe(
      "Gmail was revoked, so Codex's request closed without an answer. If Codex still needs it, it'll ask again once you reconnect.",
    );
    expect(handoffRefusalReason(closedByRevoke("agent_revoked"))).toBe("closed");
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
      kind: "refused",
      title: "There is no such request",
      message: "It may belong to another account. Nothing has been approved or declined.",
    });
    expect(handoffRefusal(new TypeError("Failed to fetch")).message).toContain(
      "Could not reach Graft",
    );
  });

  it("never says link, which Handoff keeps off the page", () => {
    const errors = [
      consumed,
      expired,
      tampered,
      expiredForOwner,
      closedByRevoke("agent_revoked"),
      closedByRevoke("connection_revoked"),
      new ApiError(404, "NOT_FOUND", "Pending action not found."),
      new TypeError("Failed to fetch"),
    ];
    for (const error of errors) {
      const { title, message } = handoffRefusal(error, NOW);
      expect(`${title} ${message}`).not.toMatch(/\blink\b/i);
    }
  });

  it("writes no em dash", () => {
    for (const error of [
      consumed,
      expired,
      tampered,
      expiredForOwner,
      closedByRevoke("connection_revoked"),
      new TypeError("Failed to fetch"),
    ]) {
      expect(handoffRefusal(error).message).not.toContain("—");
    }
    expect(HANDOFF_ANSWERED.message).not.toContain("—");
  });

  it("keeps a refusal out of the toast, where Retry cannot help, and not a transport failure", () => {
    expect(handoffReadIsQuiet(consumed)).toBe(true);
    expect(handoffReadIsQuiet(expired)).toBe(true);
    expect(handoffReadIsQuiet(tampered)).toBe(true);
    expect(handoffReadIsQuiet(new ApiError(404, "NOT_FOUND", "Pending action not found"))).toBe(
      true,
    );
    expect(handoffReadIsQuiet(new TypeError("Failed to fetch"))).toBe(false);
    expect(handoffReadIsQuiet(new ApiError(503, "INTERNAL", "Unavailable"))).toBe(false);
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
    expect(HANDOFF_ANSWERED.message).toContain("Requests");
    expect(HANDOFF_CLOSE_MS).toBeGreaterThan(0);
  });

  it("names the agent in the title when the ask names one", () => {
    expect(handoffTitle("laptop Hermes")).toBe("Graft — laptop Hermes asks");
    expect(handoffTitle(null)).toBe("Graft — Pending action");
  });
});

describe("handoffAnswered: the page when the tab will not close (frame 10c, GRA-314)", () => {
  it("says the integration is connected and where to go back to", () => {
    expect(
      handoffAnswered({
        kind: "connection",
        agentName: "Hermes",
        integrationName: "Acme Unleashed",
        answer: { connectionId: "conn_1" },
      }),
    ).toEqual({
      title: "Acme Unleashed is connected",
      message: "Go back to Hermes. It picks up where it left off.",
      access: null,
    });
  });

  it("names the access a scope answer recorded, which the page offers to change", () => {
    expect(
      handoffAnswered({
        kind: "scope",
        agentName: "Hermes",
        integrationName: "Gmail",
        answer: { allow: true, approveBuild: true, allowVendor: true },
      }),
    ).toMatchObject({
      title: "Hermes can use Gmail",
      access: "Hermes has full access. Tools that can delete still ask.",
    });
    expect(
      handoffAnswered({
        kind: "scope",
        agentName: "Hermes",
        integrationName: "Gmail",
        answer: { allow: true, approveBuild: false, allowVendor: false },
      }).access,
    ).toBe("Hermes asks you first.");
  });

  it("says allowed for a tool, declined for a no, and falls back when the answer is not known", () => {
    expect(
      handoffAnswered({
        kind: "tool",
        agentName: "Codex",
        integrationName: "Gmail",
        answer: { allow: true },
      }).title,
    ).toBe("Allowed");
    expect(
      handoffAnswered({
        kind: "connection",
        agentName: "Codex",
        integrationName: "Gmail",
        answer: { allow: false },
      }).title,
    ).toBe("Declined");
    expect(handoffAnswered(null)).toEqual({ ...HANDOFF_ANSWERED, access: null });
  });
});

describe("handoffFootnote", () => {
  it("says how long the request stays open, then the key's keeping or where to go back to", () => {
    expect(
      handoffFootnote(
        { expiresAt: "2026-10-15T11:00:00.000Z", agentName: "Codex", secret: false },
        NOW,
      ),
    ).toBe("Expires in 23 hours · After you answer, go back to Codex");
    expect(
      handoffFootnote(
        { expiresAt: "2026-10-15T12:00:00.000Z", agentName: "Hermes", secret: true },
        NOW,
      ),
    ).toBe("Expires tomorrow · Your key is stored by Graft, encrypted");
  });

  it("sends nobody back from the console's own dialog (GRA-311)", () => {
    const at = { expiresAt: "2026-10-15T11:00:00.000Z", agentName: "Codex", inConsole: true };
    expect(handoffFootnote({ ...at, secret: false }, NOW)).toBe("Expires in 23 hours");
    expect(handoffFootnote({ ...at, secret: true }, NOW)).toBe(
      "Expires in 23 hours · Your key is stored by Graft, encrypted",
    );
  });
});
