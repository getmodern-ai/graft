import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex, sourceHashOf } from "./hash";

describe("hashes", () => {
  it("sha256Hex is the hex SHA-256 of the text", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });

  it("sourceHashOf ignores file order and changes with any path or content", () => {
    const a = [
      { path: "index.ts", content: "x" },
      { path: "lib/h.ts", content: "y" },
    ];
    const reordered = [a[1], a[0]] as typeof a;
    expect(sourceHashOf(reordered)).toBe(sourceHashOf(a));
    expect(
      sourceHashOf([
        { path: "index.ts", content: "x" },
        { path: "lib/h.ts", content: "z" },
      ]),
    ).not.toBe(sourceHashOf(a));
    expect(
      sourceHashOf([
        { path: "index.ts", content: "x" },
        { path: "lib/g.ts", content: "y" },
      ]),
    ).not.toBe(sourceHashOf(a));
    expect(sourceHashOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("frames each file so two files cannot be spliced into one reading", () => {
    expect(
      sourceHashOf([
        { path: "a", content: "xy" },
        { path: "b", content: "" },
      ]),
    ).not.toBe(
      sourceHashOf([
        { path: "a", content: "x" },
        { path: "b", content: "y" },
      ]),
    );
  });
});
