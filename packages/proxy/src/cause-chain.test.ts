import { describe, expect, it } from "vitest";

import {
  causeChain,
  describeCauseChain,
  describeLink,
  hasCauseNamed,
  MAX_CAUSE_DEPTH,
} from "./cause-chain";

/**
 * The one walk down a `cause` chain the package has. `upstream.test.ts` holds the two
 * classifications the proxy makes with it; `failure.test.ts` the line it puts on the wide event.
 */

function deepChain(depth: number): Error {
  let deepest = new Error("link 0");
  for (let i = 1; i < depth; i++) deepest = new Error(`link ${i}`, { cause: deepest });
  return deepest;
}

describe("causeChain", () => {
  it("reads the error, then each cause in turn, and stops at a non-Error", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });

    expect(causeChain(outer)).toEqual({ links: [outer, inner], truncated: false });
    expect(causeChain(new Error("wrapper", { cause: 42 })).links.at(-1)).toBe(42);
    expect(causeChain(undefined)).toEqual({ links: [], truncated: false });
  });

  it("stops at a link already read, without calling that truncation", () => {
    const looped = new Error("round and round");
    looped.cause = looped;

    expect(causeChain(looped)).toEqual({ links: [looped], truncated: false });
  });

  it("stops at the cap and says a link went unread", () => {
    const chain = causeChain(deepChain(20));

    expect(chain.links).toHaveLength(MAX_CAUSE_DEPTH);
    expect(chain.truncated).toBe(true);
  });
});

describe("describeLink", () => {
  it("renders name [code]: message, the brackets only for a string code", () => {
    const system = Object.assign(new Error("getaddrinfo ENOTFOUND api.vendor.example"), {
      code: "ENOTFOUND",
    });
    const numbered = Object.assign(new Error("refused"), { code: 403 });

    expect(describeLink(system)).toBe(
      "Error [ENOTFOUND]: getaddrinfo ENOTFOUND api.vendor.example",
    );
    expect(describeLink(numbered)).toBe("Error: refused");
    expect(describeLink(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeLink("just a string")).toBe("just a string");
  });
});

describe("describeCauseChain", () => {
  it("renders name: message down the chain", () => {
    const failure = new Error("vendor GET /accounts failed", { cause: new Error("503") });

    expect(describeCauseChain(failure)).toBe("Error: vendor GET /accounts failed <- Error: 503");
  });

  it("names each cause's code where it has one — what fetch failed never says on its own", () => {
    // undici's shape, verbatim: the TypeError carries nothing; the host and the code are two down.
    const failure = new TypeError("fetch failed", {
      cause: new Error("connect", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.vendor.example"), {
          code: "ENOTFOUND",
        }),
      }),
    });

    expect(describeCauseChain(failure)).toBe(
      "TypeError: fetch failed <- Error: connect <- Error [ENOTFOUND]: getaddrinfo ENOTFOUND api.vendor.example",
    );
  });

  it("ends a chain the cap cut short in ..., and a chain that fits in nothing", () => {
    const links = describeCauseChain(deepChain(20)).split(" <- ");

    expect(links).toHaveLength(MAX_CAUSE_DEPTH + 1);
    expect(links.at(-1)).toBe("...");
    expect(describeCauseChain(deepChain(2))).toBe("Error: link 1 <- Error: link 0");
  });

  it("reads nothing but name, message and a string code", () => {
    const leaky = Object.assign(new Error("vendor said no"), {
      body: "a body with a key in it",
      code: 403,
    });

    expect(describeCauseChain(leaky)).toBe("Error: vendor said no");
  });

  it("has something to say about a non-Error, and nothing about nothing", () => {
    expect(describeCauseChain("just a string")).toBe("just a string");
    expect(describeCauseChain(null)).toBe("");
  });
});

describe("hasCauseNamed", () => {
  it("finds a named error wherever it sits in the chain, and nowhere else", () => {
    const refusal = new Error("private");
    refusal.name = "PrivateAddressError";
    const wrapped = new TypeError("fetch failed", {
      cause: new Error("connect", { cause: refusal }),
    });

    expect(hasCauseNamed(wrapped, ["PrivateAddressError"])).toBe(true);
    expect(hasCauseNamed(wrapped, ["TimeoutError", "AbortError"])).toBe(false);
    expect(hasCauseNamed("nope", ["PrivateAddressError"])).toBe(false);
  });
});
