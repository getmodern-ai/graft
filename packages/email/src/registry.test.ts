import { describe, expect, it } from "vitest";

import {
  accountExistsVariables,
  emailVerificationVariables,
  passwordResetVariables,
  TEMPLATE_NAMES,
  templates,
} from "./registry";

/**
 * The registry is the contract every transport is held to: a variable renamed in a hosted
 * template fails against this schema at the seam, not as a blank in an inbox.
 */
describe("password reset template", () => {
  const VALID = {
    resetUrl: "https://app.getgraft.ai/reset-password?token=tok_123",
  };

  it("accepts the full variable set", () => {
    expect(passwordResetVariables.parse(VALID)).toEqual(VALID);
  });

  it("rejects a missing reset URL — the renamed-in-the-dashboard case", () => {
    expect(passwordResetVariables.safeParse({}).success).toBe(false);
  });

  it("rejects a reset URL that is not a URL", () => {
    const result = passwordResetVariables.safeParse({ resetUrl: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("does not take the recipient as a variable — the address is the envelope", () => {
    expect(Object.keys(passwordResetVariables.shape)).not.toContain("to");
    expect(Object.keys(passwordResetVariables.shape)).not.toContain("email");
  });

  it("derives a fixed subject that carries no token", () => {
    const subject = templates.passwordReset.subject(VALID);
    expect(subject).toContain("password");
    expect(subject).not.toContain("tok_123");
  });

  it("names the three templates Graft sends — the invitation stayed in Cando (ADR 0007) — and nothing about how they are sent", () => {
    expect(Object.keys(templates)).toEqual(["passwordReset", "emailVerification", "accountExists"]);
    expect(TEMPLATE_NAMES).toEqual(["passwordReset", "emailVerification", "accountExists"]);
    expect(Object.keys(templates.passwordReset)).toEqual(["dataVariables", "subject"]);
  });
});

describe("email verification and account-exists templates (GRA-94)", () => {
  it("each takes one URL and nothing else, and neither names the recipient", () => {
    const verify =
      "https://api.graft.example/api/auth/verify-email?token=tok_1&callbackURL=%2Flogin";
    expect(emailVerificationVariables.parse({ verifyUrl: verify })).toEqual({ verifyUrl: verify });
    expect(emailVerificationVariables.safeParse({ verifyUrl: "not-a-url" }).success).toBe(false);
    expect(emailVerificationVariables.safeParse({}).success).toBe(false);
    expect(Object.keys(emailVerificationVariables.shape)).toEqual(["verifyUrl"]);
    const login = "https://app.graft.example/login?email=a%40b.c";
    expect(accountExistsVariables.parse({ loginUrl: login })).toEqual({ loginUrl: login });
    expect(Object.keys(accountExistsVariables.shape)).toEqual(["loginUrl"]);
  });

  it("carry fixed subjects with no token in them", () => {
    expect(
      templates.emailVerification.subject({ verifyUrl: "https://x.example/?token=tok_1" }),
    ).toBe("Verify your email for Graft");
    expect(templates.accountExists.subject({ loginUrl: "https://x.example/login" })).toBe(
      "You already have a Graft account",
    );
  });
});
