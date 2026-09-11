import { describe, expect, it } from "vitest";

import {
  hasGoogleHost,
  isGoogleHost,
  isOAuthAuthorizationCode,
  OAUTH_CALLBACK_PATH,
  OAUTH_CONSOLE_CALLBACK_PATH,
  type OAuthCallbackOutcome,
  oauthCallbackMessage,
  oauthCallbackRedirect,
  oauthPublicState,
  oauthRedirectUri,
  readOAuthCallbackSearch,
  readOAuthState,
} from "./oauth.rules";

/**
 * The browser-safe half of the consent (ADR 0005): the redirect URI the form shows and the callback
 * serves, where the callback sends the browser on and what it carries there, which hosts earn the
 * Google notice, and what the console is told about a consent — never the verifier.
 */

describe("the redirect URI", () => {
  it("is the callback path on the server's own origin, in both deployment forms", () => {
    expect(oauthRedirectUri("http://localhost:3000")).toBe(
      `http://localhost:3000${OAUTH_CALLBACK_PATH}`,
    );
    expect(oauthRedirectUri("https://app.graft.example/")).toBe(
      "https://app.graft.example/api/oauth/callback",
    );
  });
});

describe("the callback's redirect to the console", () => {
  const connected: OAuthCallbackOutcome = {
    status: "connected",
    connectionId: "c1d2e3f4-0000-4000-8000-000000000001",
    message: "Mail & co is connected — the console updates on its own.",
  };

  it("lands on the console's callback route with the outcome in the query and nothing else, whatever the console URL's shape", () => {
    const url = new URL(oauthCallbackRedirect("http://localhost:3001", connected));
    expect(`${url.origin}${url.pathname}`).toBe(
      `http://localhost:3001${OAUTH_CONSOLE_CALLBACK_PATH}`,
    );
    expect([...url.searchParams.keys()].sort()).toEqual(["connectionId", "message", "status"]);
    expect(url.searchParams.get("status")).toBe("connected");
    expect(url.searchParams.get("connectionId")).toBe(connected.connectionId);
    expect(url.searchParams.get("message")).toBe(connected.message);

    expect(oauthCallbackRedirect("https://graft.example/console/", connected)).toMatch(
      /^https:\/\/graft\.example\/console\/oauth\/callback\?status=connected&/,
    );
  });

  it("reads its own query back as the outcome, leaving a null connection out on the way", () => {
    const search = (outcome: OAuthCallbackOutcome) =>
      Object.fromEntries(
        new URL(oauthCallbackRedirect("http://localhost:3001", outcome)).searchParams,
      );
    expect(readOAuthCallbackSearch(search(connected))).toEqual(connected);

    const unverified: OAuthCallbackOutcome = {
      status: "failed",
      connectionId: null,
      message: "This link is not one Graft issued.",
    };
    expect(search(unverified)).not.toHaveProperty("connectionId");
    expect(readOAuthCallbackSearch(search(unverified))).toEqual(unverified);
  });

  it("reads anything else as a failure about no connection, which settles no waiting console", () => {
    expect(readOAuthCallbackSearch({})).toEqual({
      status: "failed",
      connectionId: null,
      message: "",
    });
    expect(
      readOAuthCallbackSearch({ status: "granted", connectionId: 12, message: ["x"] }),
    ).toEqual({ status: "failed", connectionId: null, message: "" });
    expect(readOAuthCallbackSearch({ status: "declined", message: "No." })).toEqual({
      status: "declined",
      connectionId: null,
      message: "No.",
    });
  });

  it("is posted with the type a listener tells it by", () => {
    expect(oauthCallbackMessage(connected)).toEqual({ type: "graft:oauth", ...connected });
  });
});

describe("Google hosts", () => {
  it("recognises the API hosts, the account host and google.com itself, and nothing else", () => {
    for (const host of [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "accounts.google.com",
      "GOOGLE.COM",
      "oauth2.googleapis.com:443",
    ]) {
      expect(isGoogleHost(host), host).toBe(true);
    }
    for (const host of ["api.unleashedsoftware.com", "notgoogle.com", "google.com.evil.example"]) {
      expect(isGoogleHost(host), host).toBe(false);
    }
  });

  it("reads the host set and the authorize endpoint", () => {
    expect(hasGoogleHost(["gmail.googleapis.com"])).toBe(true);
    expect(
      hasGoogleHost(["api.vendor.example"], "https://accounts.google.com/o/oauth2/v2/auth"),
    ).toBe(true);
    expect(hasGoogleHost(["api.vendor.example"], "https://auth.vendor.example/authorize")).toBe(
      false,
    );
    expect(hasGoogleHost(["api.vendor.example"], "not a url")).toBe(false);
  });
});

describe("the consent state", () => {
  it("reads only the fields with the shapes it promises", () => {
    expect(readOAuthState(null)).toEqual({});
    expect(
      readOAuthState({
        consentedAt: "2026-09-09T10:00:00.000Z",
        expiresAt: null,
        refreshedAt: 12,
        consentRequired: { at: "2026-09-09T11:00:00.000Z" },
        pkce: { verifier: "v", issuedAt: "2026-09-09T09:59:00.000Z", pendingActionId: 5 },
      }),
    ).toEqual({
      consentedAt: "2026-09-09T10:00:00.000Z",
      expiresAt: null,
      pkce: { verifier: "v", issuedAt: "2026-09-09T09:59:00.000Z", pendingActionId: null },
    });
  });

  it("stands as awaiting consent, connected, or consent required — and never carries the verifier", () => {
    expect(oauthPublicState({})).toEqual({
      status: "awaiting_consent",
      consentedAt: null,
      expiresAt: null,
      refreshedAt: null,
      consentRequired: null,
    });
    const connected = oauthPublicState({
      consentedAt: "2026-09-09T10:00:00.000Z",
      expiresAt: "2026-09-09T11:00:00.000Z",
      pkce: { verifier: "secret", issuedAt: "x", pendingActionId: null },
    });
    expect(connected.status).toBe("connected");
    expect(JSON.stringify(connected)).not.toContain("secret");
    expect(
      oauthPublicState({
        consentedAt: "2026-09-09T10:00:00.000Z",
        consentRequired: { at: "2026-09-16T10:00:00.000Z", reason: "refused" },
      }),
    ).toMatchObject({ status: "consent_required", consentRequired: { reason: "refused" } });
  });

  it("names the one scheme that has a consent", () => {
    expect(isOAuthAuthorizationCode("oauth_authorization_code")).toBe(true);
    expect(isOAuthAuthorizationCode("oauth2_client_credentials")).toBe(false);
  });
});
