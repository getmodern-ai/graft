import { describe, expect, it } from "vitest";

import { compileInputSchema } from "./schema";

describe("compileInputSchema", () => {
  it("refuses anything but an object schema", () => {
    for (const bad of [null, "string", [], { type: "array" }, { properties: {} }]) {
      expect(compileInputSchema(bad)).toMatchObject({ error: expect.stringContaining("object") });
    }
  });

  it("validates an input against the schema and names the field that fails", () => {
    const validate = compileInputSchema({
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 }, q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    });
    if ("error" in validate) throw new Error(validate.error);

    expect(validate({ q: "x", limit: 2 })).toEqual({ ok: true, value: { q: "x", limit: 2 } });
    expect(validate({ q: "x", limit: 0 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("limit"),
    });
    expect(validate({ limit: 1 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("q"),
    });
    expect(validate({ q: "x", extra: true })).toMatchObject({ ok: false });
  });

  it("reads an absent input as an empty object, so a tool with no required field is callable with nothing", () => {
    const validate = compileInputSchema({ type: "object" });
    if ("error" in validate) throw new Error(validate.error);
    expect(validate(undefined)).toEqual({ ok: true, value: {} });
    expect(validate(null)).toEqual({ ok: true, value: {} });
  });

  it("tolerates a keyword it does not know, as a model-written schema may carry one", () => {
    const validate = compileInputSchema({
      type: "object",
      properties: { when: { type: "string", format: "date-time", examples: ["now"], "x-note": 1 } },
    });
    expect("error" in validate).toBe(false);
  });
});
