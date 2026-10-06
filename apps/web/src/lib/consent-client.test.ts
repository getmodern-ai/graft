import { describe, expect, it } from "vitest";

import { consentCardTitle, judgeConsentClient, UNVOUCHED_CLIENT_NOTICE } from "./consent-client";

describe("judgeConsentClient", () => {
  it("leaves a vouched client's page as it was: no notice, every connection in scope", () => {
    expect(judgeConsentClient({ rendersCards: true, redirectTarget: "claude.ai" })).toEqual({
      vouched: true,
      showsNotice: false,
      callbackHost: "claude.ai",
      defaultScopeMode: "all",
    });
  });

  it("shows the notice and starts an unvouched client at no connections", () => {
    expect(judgeConsentClient({ rendersCards: false, redirectTarget: "evil.example" })).toEqual({
      vouched: false,
      showsNotice: true,
      callbackHost: "evil.example",
      defaultScopeMode: "listed",
    });
  });

  it("reads the deployment's verdict and never the name the client chose", () => {
    // The MCP Inspector on loopback is unvouched like any other unlisted callback, and a client
    // that registered itself as "Claude" off a card host does not become vouched by saying so.
    expect(
      judgeConsentClient({ rendersCards: false, redirectTarget: "localhost:6274" }),
    ).toMatchObject({ vouched: false, defaultScopeMode: "listed" });
    // A self-hoster's own product, added to GRAFT_CARD_HOSTS, is vouched for on the same rule.
    expect(
      judgeConsentClient({ rendersCards: true, redirectTarget: "chat.acme.example" }),
    ).toMatchObject({ vouched: true, defaultScopeMode: "all" });
  });

  it("carries the host through even when the request named no URL the server could parse", () => {
    // `redirectTargetOf` answers the URI itself when it is not a URL; the notice prints what it got.
    expect(judgeConsentClient({ rendersCards: false, redirectTarget: "" }).callbackHost).toBe("");
  });
});

describe("consentCardTitle", () => {
  it("says an unvouched client's name as the app's own claim, in one phrase", () => {
    expect(consentCardTitle("Claude", false)).toBe("Connect Claude, as it calls itself, to Graft");
  });

  it("says a vouched client's name plainly", () => {
    expect(consentCardTitle("Claude", true)).toBe("Connect Claude to Graft");
  });
});

describe("the notice's words", () => {
  it("is sentence case, names no vendor, and asks the one question the person can answer", () => {
    expect(UNVOUCHED_CLIENT_NOTICE.title).toBe("Graft has not seen this app before");
    expect(UNVOUCHED_CLIENT_NOTICE.registered).toContain("registered itself");
    expect(UNVOUCHED_CLIENT_NOTICE.started).toContain("only if you started this from that app");
    for (const sentence of Object.values(UNVOUCHED_CLIENT_NOTICE)) {
      expect(sentence).not.toContain("—");
    }
  });
});
