import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath", () => {
  it("keeps a same-origin path, query and all — the handoff URL's shape", () => {
    expect(safeRedirectPath("/pending/pa_1?t=abc")).toBe("/pending/pa_1?t=abc");
    expect(safeRedirectPath("/agents")).toBe("/agents");
    expect(safeRedirectPath("/")).toBe("/");
  });

  it("never returns to a door — the guard and the door would otherwise bounce", () => {
    for (const door of [
      "/login",
      "/login?redirect=%2Fagents",
      "/signup",
      "/signup/",
      "/forgot-password?email=a%40b.c",
      "/reset-password?token=tok_1",
    ]) {
      expect(safeRedirectPath(door), door).toBeNull();
    }
    expect(safeRedirectPath("/loginish")).toBe("/loginish");
  });

  it("drops anything that could leave the origin", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/pending",
      "/\\evil.example",
      "javascript:alert(1)",
      "pending/pa_1",
      "",
      undefined,
      42,
    ]) {
      expect(safeRedirectPath(bad), String(bad)).toBeNull();
    }
  });
});
