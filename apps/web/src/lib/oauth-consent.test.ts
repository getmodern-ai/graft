import {
  type OAuthCallbackOutcome,
  oauthCallbackMessage,
  oauthCallbackRedirect,
  readOAuthCallbackSearch,
} from "@graft/core/connection/oauth.rules";
import { describe, expect, it, vi } from "vitest";

import { announceConsent, readConsentMessage } from "./oauth-consent";

/**
 * The consent's two ends in the console (ADR 0005): the filter that reads only the callback route's
 * own message — from the console's origin, about the connection in question; anything else a window
 * might post is null — and the route's announcement, which is what that filter reads.
 */
const origin = "http://localhost:3001";
const message = {
  type: "graft:oauth" as const,
  status: "connected",
  connectionId: "conn_1",
  message: "Gmail is connected.",
};

describe("readConsentMessage", () => {
  it("reads the callback route's message from the console's own origin about this connection", () => {
    expect(readConsentMessage({ origin, data: message }, origin, "conn_1")).toEqual(message);
    expect(
      readConsentMessage(
        { origin, data: { ...message, status: "declined", message: 7 } },
        origin,
        "conn_1",
      ),
    ).toEqual({ type: "graft:oauth", status: "declined", connectionId: "conn_1", message: "" });
  });

  it("ignores another origin, another shape, another connection and an unknown status", () => {
    expect(
      readConsentMessage({ origin: "https://evil.example", data: message }, origin, "conn_1"),
    ).toBeNull();
    expect(readConsentMessage({ origin, data: "connected" }, origin, "conn_1")).toBeNull();
    expect(
      readConsentMessage({ origin, data: { ...message, type: "other" } }, origin, "conn_1"),
    ).toBeNull();
    expect(readConsentMessage({ origin, data: message }, origin, "conn_2")).toBeNull();
    expect(
      readConsentMessage({ origin, data: { ...message, status: "granted" } }, origin, "conn_1"),
    ).toBeNull();
  });

  /**
   * GRA-48: the message is what the console's `/oauth/callback` route posts after reading the
   * query the server's redirect wrote — so this drives the route's own reader over the server's own
   * writer, and asserts the filter takes the result.
   */
  it("reads the message the callback route posts, as the server's redirect wrote it", () => {
    const posted = (outcome: OAuthCallbackOutcome) =>
      oauthCallbackMessage(
        readOAuthCallbackSearch(
          Object.fromEntries(new URL(oauthCallbackRedirect(origin, outcome)).searchParams),
        ),
      );
    const connected: OAuthCallbackOutcome = {
      status: "connected",
      connectionId: "conn_1",
      message: "Mail is connected — the console updates on its own.",
    };
    expect(readConsentMessage({ origin, data: posted(connected) }, origin, "conn_1")).toEqual({
      type: "graft:oauth",
      ...connected,
    });
    expect(
      readConsentMessage(
        { origin, data: posted({ ...connected, status: "declined" }) },
        origin,
        "conn_1",
      ),
    ).toMatchObject({ status: "declined" });

    // An unverifiable state named no connection, so the refusal settles no waiting console.
    const refused = posted({
      status: "failed",
      connectionId: null,
      message: "This link is not one Graft issued.",
    });
    expect(refused.connectionId).toBeNull();
    expect(readConsentMessage({ origin, data: refused }, origin, "conn_1")).toBeNull();

    // The route is a console page: the server's origin, where the old page lived, is not its own.
    expect(
      readConsentMessage(
        { origin: "http://localhost:3000", data: posted(connected) },
        origin,
        "conn_1",
      ),
    ).toBeNull();
  });
});

describe("announceConsent", () => {
  const posted = { ...message, status: "connected" as const };

  it("tells an open opener at the console's origin alone, and the channel, which it then closes", () => {
    const opener = { closed: false, postMessage: vi.fn() };
    const channel = { postMessage: vi.fn(), close: vi.fn() };
    announceConsent(posted, { opener, origin, channel });
    expect(opener.postMessage).toHaveBeenCalledExactlyOnceWith(posted, origin);
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith(posted);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("leaves a closed, absent or severed opener alone and still reaches the channel", () => {
    const closed = { closed: true, postMessage: vi.fn() };
    const channel = { postMessage: vi.fn(), close: vi.fn() };
    announceConsent(posted, { opener: closed, origin, channel });
    expect(closed.postMessage).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledExactlyOnceWith(posted);

    const severed = {
      closed: false,
      postMessage: vi.fn(() => {
        throw new Error("the opener was swapped");
      }),
    };
    const second = { postMessage: vi.fn(), close: vi.fn() };
    announceConsent(posted, { opener: severed, origin, channel: second });
    expect(second.postMessage).toHaveBeenCalledExactlyOnceWith(posted);
    expect(second.close).toHaveBeenCalledOnce();

    expect(() => announceConsent(posted, { opener: null, origin, channel: null })).not.toThrow();
  });
});
