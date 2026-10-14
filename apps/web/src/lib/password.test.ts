import { describe, expect, it } from "vitest";

import { changePasswordFailure, passwordDraftProblem, passwordModeOf } from "./password";

describe("passwordModeOf", () => {
  it("offers a change to a person whose accounts include the credential account", () => {
    expect(passwordModeOf([{ providerId: "google" }, { providerId: "credential" }])).toBe("change");
  });

  it("offers a first password to a social-only person, and to one with no account listed", () => {
    expect(passwordModeOf([{ providerId: "google" }, { providerId: "github" }])).toBe("set");
    expect(passwordModeOf([])).toBe("set");
  });
});

describe("passwordDraftProblem", () => {
  const ok = { current: "", next: "long-enough", confirm: "long-enough" };

  it("passes a first password of eight to 128 characters typed twice", () => {
    expect(passwordDraftProblem("set", ok)).toBeNull();
    const longest = "x".repeat(128);
    expect(passwordDraftProblem("set", { ...ok, next: longest, confirm: longest })).toBeNull();
  });

  it("asks for the current password only when changing", () => {
    expect(passwordDraftProblem("change", ok)).toEqual({
      field: "current",
      message: "Enter your current password.",
    });
    expect(passwordDraftProblem("change", { ...ok, current: "old" })).toBeNull();
  });

  it("holds the new password to Better Auth's lengths", () => {
    expect(passwordDraftProblem("set", { ...ok, next: "short", confirm: "short" })).toEqual({
      field: "next",
      message: "Use at least 8 characters.",
    });
    const tooLong = "x".repeat(129);
    expect(passwordDraftProblem("set", { ...ok, next: tooLong, confirm: tooLong })?.field).toBe(
      "next",
    );
  });

  it("refuses a confirmation that differs", () => {
    expect(passwordDraftProblem("set", { ...ok, confirm: "long-enougH" })).toEqual({
      field: "confirm",
      message: "The two passwords do not match.",
    });
  });
});

describe("changePasswordFailure", () => {
  it("says a wrong current password plainly, and passes anything else through", () => {
    expect(changePasswordFailure({ code: "INVALID_PASSWORD", message: "Invalid password" })).toBe(
      "That is not your current password.",
    );
    expect(changePasswordFailure({ code: "X", message: "Something else" })).toBe("Something else");
    expect(changePasswordFailure({})).toBe("Could not change your password. Try again.");
  });
});
