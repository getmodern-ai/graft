import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { isGoogleHost, OAUTH_STATE_TTL_MS } from "./oauth.rules";

/**
 * The consent's two protections and the URL that starts it (ADR 0005): **PKCE** (RFC 7636) so a
 * code intercepted on its way back to the callback is useless without the verifier only this
 * server holds, and a **signed state** so the callback knows which connection, which person and
 * which pending action the code belongs to without trusting anything the browser says. The state
 * is an HMAC-SHA256 under `GRAFT_HANDOFF_SECRET` — the same secret that signs a handoff URL
 * (`@graft/mcp`'s `handoff.ts`), for the same reason: the browser carries it, so it proves the
 * link is one Graft issued — over a payload that travels with it, base64url'd, because the callback
 * has no session to look anything up under. Pure functions over strings and a clock; the service
 * (`connection.service.ts`) writes the verifier and the route (`apps/server/src/oauth.ts`) reads it.
 */

/** The consent's lifetime lives with the browser-safe rules; re-exported for the callers here. */
export { OAUTH_STATE_TTL_MS };

/** What the signed state carries — the callback's whole context. */
export type OAuthStatePayload = {
  connectionId: string;
  personId: string;
  /** The `connection` or `credential` ask the consent answers, or null for the person's own Connect. */
  pendingActionId: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Random, so two consents for one connection in one minute are two states. */
  nonce: string;
};

/**
 * A PKCE verifier and its S256 challenge (RFC 7636 §4.1–4.2): 32 random bytes as 43 base64url
 * characters — inside the 43–128 the RFC allows — and the challenge the vendor stores until the
 * code is exchanged. `random` is injectable for a test that wants a known verifier.
 */
export function generatePkce(random: (bytes: number) => Buffer = randomBytes): {
  verifier: string;
  challenge: string;
} {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function mark(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

/** `base64url(payload JSON) + "." + base64url(HMAC)` — one string for the vendor to echo back. */
export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${mark(encoded, secret).toString("base64url")}`;
}

export type OAuthStateVerdict =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "tampered" | "expired"; message: string };

/**
 * Verify a state the vendor echoed. The mark is checked first and in constant time, so a forged
 * state learns nothing about any connection; then the expiry. A payload whose shape is not the one
 * this server signs is `malformed` — it cannot have come from `signOAuthState`.
 */
export function verifyOAuthState(
  state: string | null | undefined,
  secret: string,
  now: Date,
): OAuthStateVerdict {
  const malformed: OAuthStateVerdict = {
    ok: false,
    reason: "malformed",
    message: "The state the vendor sent back is not one Graft issued",
  };
  if (!state) return malformed;
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) return malformed;
  const encoded = state.slice(0, dot);
  const presented = state.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(presented)) return malformed;

  const expected = mark(encoded, secret);
  const given = Buffer.from(presented, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return {
      ok: false,
      reason: "tampered",
      message: "The state the vendor sent back is not one Graft issued",
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return malformed;
  }
  if (!isPayload(payload)) return malformed;
  if (payload.expiresAt <= now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      message: "This consent took too long — start it again from the console",
    };
  }
  return { ok: true, payload };
}

function isPayload(value: unknown): value is OAuthStatePayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.connectionId === "string" &&
    p.connectionId.length > 0 &&
    typeof p.personId === "string" &&
    p.personId.length > 0 &&
    (typeof p.pendingActionId === "string" || p.pendingActionId === null) &&
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt) &&
    typeof p.nonce === "string"
  );
}

/**
 * The URL the popup opens (RFC 6749 §4.1.1 with RFC 7636 §4.3): the vendor's authorize endpoint
 * with `response_type=code`, the client id, the redirect URI Graft serves, the scopes
 * space-separated, the signed state and the S256 challenge. Query parameters the vendor's documented
 * authorize URL already carries are kept. For a Google host two more go on — `access_type=offline`,
 * without which Google issues no refresh token at all, and `prompt=consent`, without which a
 * re-consent after a refresh failure returns a code with no new refresh token (ADR 0005 names
 * Google as the worked example; no other vendor gets vendor-specific parameters here).
 */
export function buildAuthorizeUrl(args: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string | undefined;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(args.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  const scopes = args.scopes?.trim();
  if (scopes) url.searchParams.set("scope", scopes.split(/\s+/).join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (isGoogleHost(url.hostname)) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}
