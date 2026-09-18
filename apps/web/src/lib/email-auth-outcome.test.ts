import { describe, expect, it } from "vitest";

import { ALREADY_REGISTERED_MESSAGE, signUpFailureMessage } from "./email-auth-outcome";

describe("signUpFailureMessage", () => {
  it("points a taken address at the sign-in door, under either spelling Better Auth has used", () => {
    for (const code of ["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]) {
      expect(
        signUpFailureMessage({ code, message: "User already exists. Use another email." }),
      ).toBe(ALREADY_REGISTERED_MESSAGE);
    }
  });

  it("passes a fixable refusal's own reason through", () => {
    expect(
      signUpFailureMessage({
        code: "PASSWORD_TOO_SHORT",
        message: "Password must be at least 8 characters",
      }),
    ).toBe("Password must be at least 8 characters");
  });

  it("falls back to a sentence that claims nothing about the address", () => {
    expect(signUpFailureMessage({ code: "X" })).toBe("We couldn't create your account. Try again.");
  });
});
