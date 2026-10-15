import { describe, expect, it } from "vitest";

import { accountOfIdToken, parseTokenResponse } from "./oauth";

/** An unsigned JWT with these claims: the reader never checks a signature, so none is needed. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

const bytes = (body: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(body));

describe("the account a token response names (GRA-300)", () => {
  it("reads the id_token's email claim", () => {
    const token = parseTokenResponse(
      bytes({
        access_token: "a",
        token_type: "Bearer",
        id_token: idToken({ sub: "1", email: "seb@example.com" }),
      }),
    );
    expect(token?.account).toBe("seb@example.com");
  });

  it("falls back to preferred_username, and answers null with neither", () => {
    expect(accountOfIdToken(idToken({ preferred_username: "seb" }))).toBe("seb");
    expect(accountOfIdToken(idToken({ sub: "1" }))).toBeNull();
  });

  it("answers null for a response with no id_token, or one that does not parse, and keeps the token", () => {
    expect(parseTokenResponse(bytes({ access_token: "a" }))?.account).toBeNull();
    const broken = parseTokenResponse(bytes({ access_token: "a", id_token: "not.a-jwt!.x" }));
    expect(broken).toMatchObject({ accessToken: "a", account: null });
    expect(accountOfIdToken(42)).toBeNull();
    expect(accountOfIdToken("onlyonepart")).toBeNull();
  });
});
