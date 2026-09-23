import { describe, expect, it } from "vitest";

import { runInputOf, runInputView, runResultText } from "./setup-run-input";

const CITY = { field: "city", label: "City", defaultValue: "Melbourne" };
const WEATHER = { type: "object", properties: { city: { type: "string" } } };

describe("runInputView", () => {
  it("asks for the starter's field with its default when the tool's schema has it", () => {
    expect(runInputView(WEATHER, CITY)).toEqual({
      kind: "field",
      field: "city",
      label: "City",
      defaultValue: "Melbourne",
    });
  });

  it("asks for nothing for a tool with no input", () => {
    expect(runInputView({ type: "object", properties: {} }, null)).toEqual({ kind: "none" });
    expect(runInputView({ type: "object" }, CITY)).toEqual({ kind: "none" });
  });

  it("lays out the schema's fields as JSON when no starter field fits", () => {
    const view = runInputView(
      {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          unread: { type: "boolean" },
        },
      },
      CITY,
    );
    expect(view).toEqual({
      kind: "json",
      initial: JSON.stringify({ query: "", limit: 0, unread: false }, null, 2),
    });
  });
});

describe("runInputOf", () => {
  it("sends the field trimmed, an empty object for none, and a parsed JSON object", () => {
    expect(runInputOf(runInputView(WEATHER, CITY), " Sydney ")).toEqual({
      ok: true,
      input: { city: "Sydney" },
    });
    expect(runInputOf({ kind: "none" }, "")).toEqual({ ok: true, input: {} });
    expect(runInputOf({ kind: "json", initial: "{}" }, '{ "limit": 5 }')).toEqual({
      ok: true,
      input: { limit: 5 },
    });
  });

  it("says why JSON that is not an object cannot be sent", () => {
    expect(runInputOf({ kind: "json", initial: "{}" }, "{ limit")).toMatchObject({ ok: false });
    expect(runInputOf({ kind: "json", initial: "{}" }, "[1]")).toEqual({
      ok: false,
      message: "The input is a JSON object, one key per field.",
    });
  });
});

describe("runResultText", () => {
  it("indents JSON and shows text as it is", () => {
    expect(runResultText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(runResultText("plain")).toBe("plain");
  });
});
