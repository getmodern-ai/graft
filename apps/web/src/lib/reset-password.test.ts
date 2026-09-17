import { describe, expect, it } from "vitest";

import {
  deriveResetEntry,
  MIN_PASSWORD_LENGTH,
  passwordPairIssue,
  performReset,
} from "./reset-password";

describe("deriveResetEntry", () => {
  it("shows the form when a token arrived", () => {
    expect(deriveResetEntry({ token: "tok_123" })).toEqual({ kind: "form", token: "tok_123" });
  });

  it("is dead without a token — a truncated or hand-mangled link", () => {
    expect(deriveResetEntry({})).toEqual({ kind: "dead" });
  });

  it("is dead on an empty token", () => {
    expect(deriveResetEntry({ token: "" })).toEqual({ kind: "dead" });
  });

  it("is dead when Better Auth's callback flagged the token, even if one also arrived", () => {
    expect(deriveResetEntry({ token: "tok_123", error: "INVALID_TOKEN" })).toEqual({
      kind: "dead",
    });
  });
});

describe("passwordPairIssue", () => {
  it("passes a matching pair of sufficient length", () => {
    expect(passwordPairIssue("long-enough-1", "long-enough-1")).toBeNull();
  });

  it("reports a short password before anything else — even a matching short pair", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(passwordPairIssue(short, short)).toContain(`${MIN_PASSWORD_LENGTH}`);
  });

  it("reports a mismatch once the length clears", () => {
    expect(passwordPairIssue("long-enough-1", "long-enough-2")).toContain("match");
  });
});

describe("performReset", () => {
  it("is done when the server accepted the new password", async () => {
    expect(await performReset(() => Promise.resolve({ error: null }))).toEqual({ kind: "done" });
  });

  it("is refused on INVALID_TOKEN — the link died, not the password", async () => {
    expect(await performReset(() => Promise.resolve({ error: { code: "INVALID_TOKEN" } }))).toEqual(
      { kind: "refused" },
    );
  });

  it("fails with the server's sentence on any other refusal", async () => {
    expect(
      await performReset(() =>
        Promise.resolve({ error: { code: "PASSWORD_TOO_SHORT", message: "Password too short" } }),
      ),
    ).toEqual({ kind: "failed", message: "Password too short" });
  });

  it("fails with a fallback sentence when the refusal carries none", async () => {
    const outcome = await performReset(() => Promise.resolve({ error: {} }));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("folds a rejection into failed instead of escaping — the form must never freeze", async () => {
    const outcome = await performReset(() => Promise.reject(new Error("network down")));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toContain("connection");
    }
  });
});
