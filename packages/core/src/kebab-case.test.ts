import { describe, expect, it } from "vitest";

import { isKebabCase } from "./kebab-case";

describe("isKebabCase", () => {
  it("accepts lowercase words and digits joined by single hyphens", () => {
    expect(isKebabCase("acquire")).toBe(true);
    expect(isKebabCase("list-messages")).toBe(true);
    expect(isKebabCase("send-v2-reply")).toBe(true);
    expect(isKebabCase("0")).toBe(true);
  });

  it("refuses upper case, underscores, spaces and characters outside ASCII", () => {
    expect(isKebabCase("listMessages")).toBe(false);
    expect(isKebabCase("list_messages")).toBe(false);
    expect(isKebabCase("list messages")).toBe(false);
    expect(isKebabCase("liste-nachrichten-ä")).toBe(false);
  });

  it("refuses a leading, trailing or doubled hyphen, and the empty string", () => {
    expect(isKebabCase("-list")).toBe(false);
    expect(isKebabCase("list-")).toBe(false);
    expect(isKebabCase("list--messages")).toBe(false);
    expect(isKebabCase("")).toBe(false);
  });
});
