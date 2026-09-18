import { describe, expect, it } from "vitest";

import { errorMessage } from "./sandbox";

describe("errorMessage", () => {
  it("is an Error's message, then each cause as name [code]: message", () => {
    expect(errorMessage(new Error("the mount failed"))).toBe("the mount failed");
    expect(errorMessage(new Error("the mount failed", { cause: new Error("ECONNRESET") }))).toBe(
      "the mount failed (caused by Error: ECONNRESET)",
    );
  });

  it("walks a chain three deep and names every code — what fetch failed loses on its own", () => {
    // undici's shape, verbatim: the TypeError says nothing, the host and ENOTFOUND are two down.
    const thrown = new Error("the toolbox could not be mounted", {
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND drives.blaxel.example"), {
          code: "ENOTFOUND",
        }),
      }),
    });

    expect(errorMessage(thrown)).toBe(
      "the toolbox could not be mounted (caused by TypeError: fetch failed <- Error [ENOTFOUND]: getaddrinfo ENOTFOUND drives.blaxel.example)",
    );
  });

  it("names the thrown Error's own code, and a cause's only when it is a string", () => {
    const own = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:2375"), {
      code: "ECONNREFUSED",
    });
    expect(errorMessage(own)).toBe("connect ECONNREFUSED 127.0.0.1:2375 [ECONNREFUSED]");

    const numbered = new Error("outer", {
      cause: Object.assign(new Error("inner"), { code: 500 }),
    });
    expect(errorMessage(numbered)).toBe("outer (caused by Error: inner)");
  });

  it("reads a plain-object cause the way it reads a thrown plain object", () => {
    const thrown = new Error("the drive call was refused", {
      cause: { code: 403, error: "Drives feature is not enabled for this workspace" },
    });

    expect(errorMessage(thrown)).toBe(
      "the drive call was refused (caused by Drives feature is not enabled for this workspace (403))",
    );
  });

  it("stops at the proxy's cap and says so", () => {
    let deepest = new Error("link 0");
    for (let i = 1; i < 20; i++) deepest = new Error(`link ${i}`, { cause: deepest });

    expect(errorMessage(deepest)).toBe(
      "link 19 (caused by Error: link 18 <- Error: link 17 <- Error: link 16 <- Error: link 15 <- ...)",
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
