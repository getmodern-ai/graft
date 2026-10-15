import { describe, expect, it } from "vitest";

import { withoutTrailingSlashes } from "./url.rules";

describe("withoutTrailingSlashes", () => {
  it("trims a long run of trailing slashes in linear time, and nothing else", () => {
    expect(withoutTrailingSlashes("https://graft.example///")).toBe("https://graft.example");
    expect(withoutTrailingSlashes("https://graft.example")).toBe("https://graft.example");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
    expect(withoutTrailingSlashes("https://graft.example/a//b")).toBe("https://graft.example/a//b");
    const hostile = `${"/".repeat(1_000_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(hostile)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
