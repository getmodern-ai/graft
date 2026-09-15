import { describe, expect, it } from "vitest";

import { wwwAuthenticateChallenge } from "./http";

/**
 * The 401's challenge (ADR 0018; RFC 9728 §5.1, RFC 6750 §3), as a pure function: the endpoint's
 * own suite in `apps/server/src/mcp.test.ts` asserts the header on the wire, this pins the shape
 * the header value must keep to be a header at all.
 */
const URL = "https://app.getgraft.ai/.well-known/oauth-protected-resource/mcp";

describe("wwwAuthenticateChallenge", () => {
  it("names the resource metadata alone when no token was presented", () => {
    expect(wwwAuthenticateChallenge(URL, "token_missing", "no token")).toBe(
      `Bearer resource_metadata="${URL}"`,
    );
  });

  it("adds invalid_token and the description for a refused token", () => {
    expect(wwwAuthenticateChallenge(URL, "token_unknown", "unknown or revoked")).toBe(
      `Bearer resource_metadata="${URL}", error="invalid_token", error_description="unknown or revoked"`,
    );
    expect(wwwAuthenticateChallenge(URL, "session_mismatch", "another agent's")).toContain(
      'error="invalid_token"',
    );
  });

  /** The body's sentence has an em dash; a header value cannot, and `Headers.set` throws on one. */
  it("keeps the description to RFC 6750's characters, so the value is settable as a header", () => {
    const value = wwwAuthenticateChallenge(
      URL,
      "token_expired",
      'This access token has expired — refresh it, "now" — ünïcödé too',
    );
    expect(value).toBe(
      `Bearer resource_metadata="${URL}", error="invalid_token", error_description="This access token has expired - refresh it, 'now' - ncd too"`,
    );
    expect(() => new Headers().set("www-authenticate", value)).not.toThrow();
  });
});
