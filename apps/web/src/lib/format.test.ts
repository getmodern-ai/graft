import { describe, expect, it } from "vitest";

import { count, formatDateTime, formatRelative } from "./format";

const NOW = new Date("2026-09-18T08:00:00.000Z");

describe("the moment formatters are total (GRA-96)", () => {
  it("print a moment near now relatively and a distant one as a date", () => {
    expect(formatRelative("2026-09-18T07:57:00.000Z", NOW)).toMatch(/3 minutes ago/);
    expect(formatRelative("2026-01-01T00:00:00.000Z", NOW)).toBe(
      formatDateTime("2026-01-01T00:00:00.000Z"),
    );
    expect(formatDateTime("2026-01-01T00:00:00.000Z")).not.toBe("");
  });

  it("print nothing for an empty string, so a coalesced null column cannot throw", () => {
    expect(formatRelative("", NOW)).toBe("");
    expect(formatDateTime("")).toBe("");
  });

  it("print nothing for a value that is not a date", () => {
    expect(formatRelative("never", NOW)).toBe("");
    expect(formatDateTime("not a date")).toBe("");
  });
});

describe("count", () => {
  it("pluralises past one", () => {
    expect(count(1, "day")).toBe("1 day");
    expect(count(21, "day")).toBe("21 days");
  });
});
