import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  generatePkce,
  OAUTH_STATE_TTL_MS,
  type OAuthStatePayload,
  pkceChallenge,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-consent";

/**
 * The consent's two protections as pure functions (ADR 0005): PKCE against RFC 7636's own vector,
 * the signed state against tampering, expiry and malformed input, and the authorize URL against
 * RFC 6749 §4.1.1 — with Google's two extra parameters on a Google host and nowhere else.
 */

const SECRET = "oauth-consent-test-secret-that-is-long-enough";
const NOW = new Date("2026-09-09T10:00:00Z");
const PAYLOAD: OAuthStatePayload = {
  connectionId: "conn_1",
  personId: "person_1",
  pendingActionId: "pa_1",
  expiresAt: NOW.getTime() + OAUTH_STATE_TTL_MS,
  nonce: "nonce-1",
};

describe("PKCE", () => {
  it("derives the S256 challenge RFC 7636 appendix B gives for its example verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a 43-character base64url verifier and its challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(generatePkce().verifier).not.toBe(verifier);
  });
});

describe("the signed state", () => {
  it("round-trips its payload and verifies before expiry", () => {
    const state = signOAuthState(PAYLOAD, SECRET);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyOAuthState(state, SECRET, NOW)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it("refuses a state whose payload was edited, whose mark was made under another secret, or that is not the shape at all", () => {
    const state = signOAuthState(PAYLOAD, SECRET);
    const [encoded, mark] = state.split(".") as [string, string];
    const other = Buffer.from(
      JSON.stringify({ ...PAYLOAD, personId: "person_2" }),
      "utf8",
    ).toString("base64url");
    expect(verifyOAuthState(`${other}.${mark}`, SECRET, NOW)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
    expect(verifyOAuthState(state, "another-secret-that-is-also-long-enough", NOW)).toMatchObject({
      ok: false,
      reason: "tampered",
    });
    for (const bad of [null, undefined, "", "nodot", `${encoded}.`, ".mark", "not base64!.x"]) {
      expect(verifyOAuthState(bad, SECRET, NOW), String(bad)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses a well-signed payload that is not one this server issues", () => {
    const encoded = Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url");
    const forged = signOAuthState(PAYLOAD, SECRET).split(".")[1] as string;
    // A correct mark over a foreign payload cannot be made without the secret; simulate one by
    // signing the foreign payload's encoding directly.
    const mark = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    expect(mark).not.toBe(forged);
    expect(verifyOAuthState(`${encoded}.${mark}`, SECRET, NOW)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("expires exactly at its own expiry", () => {
    const state = signOAuthState(PAYLOAD, SECRET);
    expect(verifyOAuthState(state, SECRET, new Date(PAYLOAD.expiresAt - 1)).ok).toBe(true);
    expect(verifyOAuthState(state, SECRET, new Date(PAYLOAD.expiresAt))).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it("carries a null pending action for the person's own Connect", () => {
    const payload = { ...PAYLOAD, pendingActionId: null };
    const verdict = verifyOAuthState(signOAuthState(payload, SECRET), SECRET, NOW);
    expect(verdict).toEqual({ ok: true, payload });
  });
});

describe("the authorize URL", () => {
  const args = {
    clientId: "client-id-value",
    redirectUri: "https://graft.example/api/oauth/callback",
    scopes: "  https://www.googleapis.com/auth/gmail.readonly   openid ",
    state: "encoded.mark",
    codeChallenge: "challenge-value",
  };

  it("carries RFC 6749 §4.1.1's parameters and the S256 challenge, keeping what the vendor's URL already had", () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...args,
        authorizeUrl: "https://auth.vendor.example/authorize?tenant=t1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.vendor.example/authorize");
    expect(url.searchParams.get("tenant")).toBe("t1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id-value");
    expect(url.searchParams.get("redirect_uri")).toBe("https://graft.example/api/oauth/callback");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly openid",
    );
    expect(url.searchParams.get("state")).toBe("encoded.mark");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("asks Google for offline access and a fresh consent, and no other vendor", () => {
    const google = new URL(
      buildAuthorizeUrl({ ...args, authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
    );
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("prompt")).toBe("consent");
  });

  it("sends no scope parameter when there are no scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...args, scopes: undefined, authorizeUrl: "https://a.example/auth" }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
  });
});
