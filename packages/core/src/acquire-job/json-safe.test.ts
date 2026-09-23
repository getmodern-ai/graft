import { describe, expect, it } from "vitest";

import { withoutNul } from "./json-safe";

/** The one rule: no U+0000 reaches a jsonb column (GRA-201). Everything else is left as it was. */
describe("withoutNul", () => {
  it("removes U+0000 from a string, and from every string nested in arrays and objects", () => {
    expect(withoutNul("PK\u0003\u0004\u0000\u0000xl/")).toBe("PK\u0003\u0004xl/");
    expect(
      withoutNul({
        path: "/files/1?alt=media",
        status: 200,
        body: "PK\u0000\u0000",
        nested: { list: ["a\u0000b", 1, null, { deep: "\u0000" }] },
      }),
    ).toEqual({
      path: "/files/1?alt=media",
      status: 200,
      body: "PK",
      nested: { list: ["ab", 1, null, { deep: "" }] },
    });
  });

  it("cleans a key as it cleans a value, since a JSON object name is a string too", () => {
    expect(withoutNul({ "PK\u0000": { "a\u0000b": "\u0000" } })).toEqual({ PK: { ab: "" } });
  });

  it("leaves a value with no NUL identical, other control characters included", () => {
    const value = { text: "tab\tnewline\n\u0001\uFFFD", n: 2, ok: true, none: null };
    expect(withoutNul(value)).toEqual(value);
    expect(withoutNul(null)).toBeNull();
    expect(withoutNul(7)).toBe(7);
  });
});
