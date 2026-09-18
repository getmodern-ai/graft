import { describe, expect, it } from "vitest";

import { socialSignInMessage, socialSignInUrls, verificationReturnURL } from "./sign-in";

describe("socialSignInUrls", () => {
  it("lands a plain sign-in on the default path and brings a failure back to the door", () => {
    expect(socialSignInUrls("https://app.graft.example", undefined)).toEqual({
      callbackURL: "https://app.graft.example/agents",
      errorCallbackURL: "https://app.graft.example/login",
    });
  });

  /** A handoff URL (ADR 0006) survives both legs: honoured on success, carried back on failure. */
  it("returns to the redirect on success and carries it back to the door on failure", () => {
    const urls = socialSignInUrls("http://localhost:3001", "/pending/pa_1?t=abc");
    expect(urls.callbackURL).toBe("http://localhost:3001/pending/pa_1?t=abc");
    expect(urls.errorCallbackURL).toBe(
      "http://localhost:3001/login?redirect=%2Fpending%2Fpa_1%3Ft%3Dabc",
    );
  });
});

describe("socialSignInMessage", () => {
  it("says nothing when the door was not returned to with an error", () => {
    expect(socialSignInMessage(undefined)).toBeNull();
  });

  it("names the linking rule for an address that already has an account (ADR 0020)", () => {
    expect(socialSignInMessage("unable_to_link_account")).toMatch(/already has a Graft account/);
  });

  it("has a sentence for the codes a person can act on, and one fallback for the rest", () => {
    expect(socialSignInMessage("access_denied")).toMatch(/cancelled/);
    expect(socialSignInMessage("email_not_found")).toMatch(/no email address/);
    expect(socialSignInMessage("email_does_not_match")).toMatch(/different Graft account/);
    expect(socialSignInMessage("invalid_code")).toMatch(/Could not sign in with the provider/);
    expect(socialSignInMessage("unable_to_link_account")).not.toContain("unable_to_link_account");
  });
});

describe("verificationReturnURL", () => {
  it("returns to the sign-in door with the redirect and the address, so the click lands where the handoff pointed", () => {
    expect(
      verificationReturnURL("http://localhost:3001", {
        returnTo: "/pending/pa_1?t=abc",
        email: "ada@example.com",
      }),
    ).toBe(
      "http://localhost:3001/login?redirect=%2Fpending%2Fpa_1%3Ft%3Dabc&email=ada%40example.com",
    );
    expect(
      verificationReturnURL("https://app.getgraft.ai", { returnTo: undefined, email: "a@b.c" }),
    ).toBe("https://app.getgraft.ai/login?email=a%40b.c");
  });
});

describe("socialSignInMessage — the verification link's codes (GRA-94)", () => {
  it("reads a dead verification link as one, in either of Better Auth's spellings", () => {
    for (const code of ["TOKEN_EXPIRED", "INVALID_TOKEN", "token_expired", "invalid_token"]) {
      expect(socialSignInMessage(code)).toMatch(/verification link has expired/);
    }
  });
});
