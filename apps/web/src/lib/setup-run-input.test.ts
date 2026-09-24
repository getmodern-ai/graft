import { describe, expect, it } from "vitest";

import {
  canRun,
  humaniseFieldName,
  initialValues,
  missingFields,
  missingJsonFields,
  needsSentence,
  type RunInputView,
  runInputOf,
  runInputView,
  runResultText,
} from "./setup-run-input";

const CITY = { field: "city", label: "City", defaultValue: "Melbourne" };
const WEATHER = { type: "object", properties: { city: { type: "string" } } };
/** The tool GRA-217's walk built for Google Sheets: two required fields, no defaults. */
const SHEETS = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string" },
    range: { type: "string", description: "The A1 range to read, such as Sheet1!A1:D10." },
  },
  required: ["spreadsheetId", "range"],
  additionalProperties: false,
};
const SPREADSHEET = {
  field: "spreadsheet",
  label: "Spreadsheet link",
  defaultValue: "https://docs.google.com/spreadsheets/d/x/edit",
};

function form(view: RunInputView) {
  if (view.kind !== "form") throw new Error(`expected a form, got ${view.kind}`);
  return view.fields;
}

describe("runInputView, from the tool's schema (GRA-217)", () => {
  it("prefills the starter's field with its default when the tool's schema has it", () => {
    const view = runInputView(WEATHER, CITY);
    expect(form(view)).toEqual([
      {
        name: "city",
        kind: "string",
        label: "City",
        description: null,
        required: false,
        initial: "Melbourne",
        options: [],
        needs: null,
      },
    ]);
    expect(canRun(view, initialValues(view), "")).toBe(true);
    expect(runInputOf(view, { city: " Sydney " })).toEqual({ ok: true, input: { city: "Sydney" } });
  });

  it("draws Sheets' two required fields with what each needs, and Run waits for both", () => {
    // The starter's field does not match either, so it prefills nothing.
    const view = runInputView(SHEETS, SPREADSHEET);
    const fields = form(view);
    expect(fields.map((field) => [field.name, field.label, field.required, field.initial])).toEqual(
      [
        ["spreadsheetId", "Spreadsheet ID", true, ""],
        ["range", "Range", true, ""],
      ],
    );
    expect(fields.map((field) => field.needs)).toEqual([
      "This tool needs a spreadsheet ID.",
      "This tool needs the A1 range to read, such as Sheet1!A1:D10.",
    ]);
    const values = initialValues(view);
    expect(canRun(view, values, "")).toBe(false);
    expect(missingFields(view, values).map((field) => field.name)).toEqual([
      "spreadsheetId",
      "range",
    ]);
    expect(runInputOf(view, values)).toEqual({
      ok: false,
      message: "This tool needs a spreadsheet ID.",
    });
    const filled = { spreadsheetId: "abc", range: "  " };
    expect(canRun(view, filled, "")).toBe(false);
    expect(canRun(view, { ...filled, range: "A1:B2" }, "")).toBe(true);
    expect(runInputOf(view, { ...filled, range: "A1:B2" })).toEqual({
      ok: true,
      input: { spreadsheetId: "abc", range: "A1:B2" },
    });
  });

  it("prefills from the schema's default, else its first example, and a title labels a field", () => {
    const view = runInputView(
      {
        type: "object",
        properties: {
          city: { type: "string", default: "Paris" },
          days: { type: "integer", examples: [3, 7], title: "How many days" },
          units: { type: "string", enum: ["metric", "imperial"], default: "metric" },
          hourly: { type: "boolean", default: true },
          fields: { type: "array", items: { type: "string" }, default: ["name", "date"] },
          note: { type: ["string", "null"] },
        },
        required: ["city", "days", "units"],
      },
      null,
    );
    const fields = form(view);
    expect(Object.fromEntries(fields.map((field) => [field.name, field.initial]))).toEqual({
      city: "Paris",
      days: "3",
      units: "metric",
      hourly: "true",
      fields: "name, date",
      note: "",
    });
    expect(fields.map((field) => field.kind)).toEqual([
      "string",
      "integer",
      "enum",
      "boolean",
      "list",
      "string",
    ]);
    expect(fields.find((field) => field.name === "days")?.label).toBe("How many days");
    expect(fields.every((field) => field.needs === null)).toBe(true);
    // Each value goes in its own type; an empty optional field is left out.
    expect(runInputOf(view, initialValues(view))).toEqual({
      ok: true,
      input: {
        city: "Paris",
        days: 3,
        units: "metric",
        hourly: true,
        fields: ["name", "date"],
      },
    });
  });

  it("says why a number or a list value cannot be sent, and sends a numeric enum as a number", () => {
    const view = runInputView(
      {
        type: "object",
        properties: {
          limit: { type: "integer" },
          ids: { type: "array", items: { type: "number" } },
          size: { enum: [10, 20] },
        },
      },
      null,
    );
    expect(runInputOf(view, { limit: "2.5" })).toEqual({
      ok: false,
      message: "Limit is a whole number.",
    });
    expect(runInputOf(view, { ids: "1, two" })).toEqual({
      ok: false,
      message: "IDs is a list of numbers, separated by commas.",
    });
    expect(runInputOf(view, { limit: "5", ids: "1, 2.5", size: "20" })).toEqual({
      ok: true,
      input: { limit: 5, ids: [1, 2.5], size: 20 },
    });
  });

  it("draws the required fields first, as a stored schema's key order is not the author's", () => {
    // Postgres's jsonb hands keys back shortest first: the walk's tool came back this way.
    const view = runInputView(
      {
        type: "object",
        properties: {
          units: { type: "string", default: "celsius" },
          hourly: { type: "boolean" },
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
        required: ["latitude", "longitude"],
      },
      null,
    );
    expect(form(view).map((field) => field.name)).toEqual([
      "latitude",
      "longitude",
      "units",
      "hourly",
    ]);
  });

  it("never waits on a boolean, which is false when unchecked", () => {
    const view = runInputView(
      { type: "object", properties: { unread: { type: "boolean" } }, required: ["unread"] },
      null,
    );
    expect(form(view)[0]).toMatchObject({ initial: "false", needs: null });
    expect(canRun(view, initialValues(view), "")).toBe(true);
    expect(runInputOf(view, initialValues(view))).toEqual({ ok: true, input: { unread: false } });
  });

  it("asks for nothing for a tool with no input", () => {
    expect(runInputView({ type: "object", properties: {} }, null)).toEqual({ kind: "none" });
    expect(runInputView({ type: "object" }, CITY)).toEqual({ kind: "none" });
    expect(runInputOf({ kind: "none" }, {})).toEqual({ ok: true, input: {} });
  });

  it("finds a composed schema's fields through a local $ref, and asks for JSON since it composes", () => {
    const viaRef = {
      type: "object",
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    };
    expect(runInputView(viaRef, CITY)).toEqual({
      kind: "json",
      initial: JSON.stringify({ city: "Melbourne" }, null, 2),
      required: ["city"],
    });
    const composed = {
      type: "object",
      allOf: [{ properties: { query: { type: "string" } }, required: ["query"] }],
      oneOf: [
        { properties: { limit: { type: "integer" } }, required: ["limit"] },
        { properties: { page: {} } },
      ],
      anyOf: [{ $ref: "#/definitions/Flag" }],
      definitions: { Flag: { properties: { unread: { type: "boolean" } } } },
    };
    // An allOf branch's required binds; a oneOf branch's does not.
    expect(runInputView(composed, null)).toEqual({
      kind: "json",
      initial: JSON.stringify({ query: "", unread: false, limit: 0 }, null, 2),
      required: ["query"],
    });
  });

  it("asks for JSON only for what it cannot draw: a nested object, a list of objects, a union", () => {
    const nested = {
      type: "object",
      properties: {
        name: { type: "string", default: "report" },
        filter: { type: "object", properties: { label: { type: "string" } } },
      },
      required: ["filter"],
    };
    expect(runInputView(nested, null)).toEqual({
      kind: "json",
      initial: JSON.stringify({ name: "report", filter: {} }, null, 2),
      required: ["filter"],
    });
    const listOfObjects = {
      type: "object",
      properties: { rows: { type: "array", items: { type: "object" } } },
    };
    expect(runInputView(listOfObjects, null)).toMatchObject({ kind: "json" });
    const union = { type: "object", properties: { id: { type: ["string", "integer"] } } };
    expect(runInputView(union, null)).toMatchObject({ kind: "json" });
  });

  it("asks for JSON, never runs with {}, where a schema takes input it does not list", () => {
    const json = { kind: "json", initial: "{}", required: [] };
    expect(runInputView({ type: "object", $ref: "https://example.com/input.json" }, null)).toEqual(
      json,
    );
    expect(runInputView({ type: "object", oneOf: [true] }, null)).toEqual(json);
    expect(
      runInputView({ type: "object", additionalProperties: { type: "string" } }, null),
    ).toEqual(json);
    // A zod-built schema's `additionalProperties: false` admits nothing more.
    expect(
      runInputView({ type: "object", properties: {}, additionalProperties: false }, null),
    ).toEqual({ kind: "none" });
    // A cycle through $defs is walked once.
    const cyclic = { $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/A" } } };
    expect(runInputView(cyclic, null)).toEqual(json);
  });

  it("asks for JSON rather than throwing on a $ref name that is not a valid percent-encoding", () => {
    const percent = {
      type: "object",
      $ref: "#/$defs/discount%",
      $defs: { "discount%": { properties: { city: { type: "string" } } } },
    };
    expect(() => runInputView(percent, CITY)).not.toThrow();
    expect(runInputView(percent, CITY)).toEqual({ kind: "json", initial: "{}", required: [] });
  });
});

describe("the JSON input", () => {
  const view: RunInputView = { kind: "json", initial: "{}", required: ["filter", "name"] };

  it("waits for its required keys, and not on text that does not parse", () => {
    expect(missingJsonFields(view, '{ "filter": {}, "name": " " }')).toEqual(["name"]);
    expect(canRun(view, {}, '{ "filter": {}, "name": "x" }')).toBe(true);
    expect(canRun(view, {}, "{ filter")).toBe(true);
  });

  it("sends a parsed object and says why anything else cannot be sent", () => {
    expect(runInputOf(view, {}, '{ "limit": 5 }')).toEqual({ ok: true, input: { limit: 5 } });
    expect(runInputOf(view, {}, "{ limit")).toEqual({
      ok: false,
      message: "The input is not valid JSON.",
    });
    expect(runInputOf(view, {}, "[1]")).toEqual({
      ok: false,
      message: "The input is a JSON object, one key per field.",
    });
  });
});

describe("the words for a field", () => {
  it("humanises a name, acronyms upper-cased", () => {
    expect(humaniseFieldName("spreadsheetId")).toBe("spreadsheet ID");
    expect(humaniseFieldName("page_size")).toBe("page size");
    expect(humaniseFieldName("webViewLink")).toBe("web view link");
    expect(humaniseFieldName("channel-url")).toBe("channel URL");
  });

  it("says what a tool needs from the description when it reads as a noun, else from the name", () => {
    expect(needsSentence("spreadsheetId", null)).toBe("This tool needs a spreadsheet ID.");
    expect(needsSentence("id", null)).toBe("This tool needs an ID.");
    expect(needsSentence("userId", "")).toBe("This tool needs a user ID.");
    expect(needsSentence("url", null)).toBe("This tool needs a URL.");
    expect(needsSentence("sheet", "The sheet's name. Defaults to none.")).toBe(
      "This tool needs the sheet's name.",
    );
    expect(needsSentence("sheet", "Name of the sheet to read")).toBe("This tool needs a sheet.");
  });
});

describe("runResultText", () => {
  it("indents JSON and shows text as it is", () => {
    expect(runResultText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(runResultText("plain")).toBe("plain");
  });
});
