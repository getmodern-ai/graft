import { describe, expect, it } from "vitest";

import { passwordResetVariables, TEMPLATE_NAMES, templates } from "./registry";

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

  it("names the one template Graft sends — the invitation stayed in Cando (ADR 0007) — and nothing about how it is sent", () => {
    expect(Object.keys(templates)).toEqual(["passwordReset"]);
    expect(TEMPLATE_NAMES).toEqual(["passwordReset"]);
    expect(Object.keys(templates.passwordReset)).toEqual(["dataVariables", "subject"]);
  });
});
