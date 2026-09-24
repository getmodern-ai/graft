import { describe, expect, it } from "vitest";

import { resultToolOf } from "./setup-result";

describe("resultToolOf", () => {
  const first = { id: "tool_first", name: "current-weather" };
  const second = { id: "tool_second", name: "list-repos" };

  it("answers the context's tool when it is the one the record names", () => {
    expect(resultToolOf("tool_second", second)).toBe(second);
  });

  it("answers nothing for a cached context still naming an earlier job's tool", () => {
    // Built for one integration, back to choose another, built again: the record names the new
    // tool while the cache still holds the first, which must not run on arrival.
    expect(resultToolOf("tool_second", first)).toBeNull();
  });

  it("answers nothing while either side has no tool", () => {
    expect(resultToolOf(null, first)).toBeNull();
    expect(resultToolOf(undefined, first)).toBeNull();
    expect(resultToolOf("tool_first", null)).toBeNull();
    expect(resultToolOf("tool_first", undefined)).toBeNull();
  });
});
