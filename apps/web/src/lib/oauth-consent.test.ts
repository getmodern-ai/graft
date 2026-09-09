import { describe, expect, it } from "vitest";

import { readConsentMessage, serverOriginOf } from "./oauth-consent";

/**
 * The consent's message filter (ADR 0005): only the callback page's own message, from the server's
 * origin, about the connection in question, is read — anything else a window might post is null.
 */
describe("readConsentMessage", () => {
  const origin = "http://localhost:3000";
  const message = {
    type: "graft:oauth",
    status: "connected",
    connectionId: "conn_1",
    message: "Gmail is connected.",
  };

  it("reads the callback's message from the server's origin about this connection", () => {
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

  it("takes the server's origin from the redirect URI it handed out", () => {
    expect(serverOriginOf("http://localhost:3000/api/oauth/callback")).toBe(
      "http://localhost:3000",
    );
    expect(serverOriginOf("https://app.graft.example/api/oauth/callback")).toBe(
      "https://app.graft.example",
    );
  });
});
