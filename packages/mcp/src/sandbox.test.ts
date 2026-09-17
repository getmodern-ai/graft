import { describe, expect, it } from "vitest";

import { errorMessage } from "./sandbox";

describe("errorMessage", () => {
  it("is an Error's message, with its cause's beside it", () => {
    expect(errorMessage(new Error("the mount failed"))).toBe("the mount failed");
    expect(errorMessage(new Error("the mount failed", { cause: new Error("ECONNRESET") }))).toBe(
      "the mount failed (ECONNRESET)",
    );
  });

  it("reads the sentence out of a provider SDK's error body rather than printing [object Object]", () => {
    // The body @blaxel/core throws for a refused drive call, verbatim — what one hosted job could
    // only report as "The sandbox is unavailable: [object Object]".
    expect(
      errorMessage({ code: 403, error: "Drives feature is not enabled for this workspace" }),
    ).toBe("Drives feature is not enabled for this workspace (403)");
    expect(errorMessage({ code: 401, error: "Unauthorized" })).toBe("Unauthorized (401)");
    expect(errorMessage({ message: "not found", status: "404" })).toBe("not found (404)");
    expect(errorMessage({ message: "plain" })).toBe("plain");
  });

  it("falls back to the JSON of a body with no sentence in it, and to String for the rest", () => {
    expect(errorMessage({ code: 500 })).toBe('{"code":500}');
    expect(errorMessage("a string")).toBe("a string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
