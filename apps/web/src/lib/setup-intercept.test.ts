import { describe, expect, it } from "vitest";

import { isSetupExempt, setupInterceptTarget } from "./setup-intercept";

describe("the Setup intercept", () => {
  it("sends a person the show rule admits to /setup from a screen of the console", () => {
    expect(setupInterceptTarget("/agents", { show: true })).toBe("/setup");
    expect(setupInterceptTarget("/connections", { show: true })).toBe("/setup");
    expect(setupInterceptTarget("/settings", { show: true })).toBe("/setup");
    expect(setupInterceptTarget("/agents/agent_1", { show: true })).toBe("/setup");
  });

  it("lets everyone through when the show rule says no, or the state could not be read", () => {
    expect(setupInterceptTarget("/agents", { show: false })).toBeNull();
    expect(setupInterceptTarget("/agents", null)).toBeNull();
  });

  it.each(["/consent", "/pending", "/pending/pa_1", "/oauth/callback", "/link/callback", "/setup"])(
    "never intercepts %s",
    (path) => {
      expect(isSetupExempt(path)).toBe(true);
      expect(setupInterceptTarget(path, { show: true })).toBeNull();
    },
  );

  it("does not exempt a path that merely begins with an exempt one's letters", () => {
    expect(isSetupExempt("/pendingx")).toBe(false);
    expect(isSetupExempt("/consenting")).toBe(false);
  });
});
