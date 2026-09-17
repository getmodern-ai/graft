import { describe, expect, it } from "vitest";

import { emailAuthMessage, WRONG_PASSWORD } from "./email-auth-outcome";

const wrongPassword = { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" };
const taken = { code: "USER_ALREADY_EXISTS", message: "User already exists" };
/** What Better Auth 1.7 actually answers (GRA-81) — the message is the one never to show here. */
const takenNow = {
  code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  message: "User already exists. Use another email.",
};
const tooShort = { code: "PASSWORD_TOO_SHORT", message: "Password must be at least 8 characters" };

describe("emailAuthMessage", () => {
  it("says nothing when registration succeeded — the sign-in failure was just a new account", () => {
    expect(emailAuthMessage(wrongPassword, null)).toBeNull();
  });

  /**
   * The address is taken, so the account exists, so the sign-in attempt failed on the password.
   * Reporting "user already exists" here would be true and useless: of course it exists, they
   * are trying to sign in to it.
   */
  it("reports the sign-in failure when the address is already registered", () => {
    expect(emailAuthMessage(wrongPassword, taken)).toBe(wrongPassword.message);
    expect(emailAuthMessage(wrongPassword, takenNow)).toBe(wrongPassword.message);
  });

  /**
   * The one that matters. A brand-new visitor picking a five-character password would otherwise
   * be told their password "did not match" an account that does not exist — sending them off to
   * hunt for a forgotten password instead of choosing a longer one.
   */
  it("reports the registration failure when the address is new", () => {
    expect(emailAuthMessage(wrongPassword, tooShort)).toBe(tooShort.message);
  });

  it("falls back to a usable sentence when a provider sends no message", () => {
    expect(emailAuthMessage({ code: "X" }, { code: "USER_ALREADY_EXISTS" })).toBe(WRONG_PASSWORD);
    expect(emailAuthMessage(null, { code: "SOMETHING_ELSE" })).toBe(WRONG_PASSWORD);
  });

  it("does not mistake a missing code for the address being taken", () => {
    expect(emailAuthMessage(wrongPassword, { message: "Network request failed" })).toBe(
      "Network request failed",
    );
  });
});
