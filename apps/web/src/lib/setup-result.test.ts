import { describe, expect, it } from "vitest";

import { resultToolOf, runsOnArrival } from "./setup-result";
import { canRun, initialValues, runInputView } from "./setup-run-input";

describe("runsOnArrival", () => {
  const readOnly = { readOnly: true };

  it("runs a read-only tool that takes no input", () => {
    expect(runsOnArrival(runInputView({ type: "object", properties: {} }, null), readOnly)).toBe(
      true,
    );
  });

  it("runs the ready-made Gmail search, both fields optional and at their defaults", () => {
    // Production walk of 2026-10-14: it waited behind "Not run yet" with nothing to supply.
    const search = runInputView(
      {
        type: "object",
        properties: {
          query: { type: "string", default: "in:inbox" },
          maxResults: { type: "integer", default: 10 },
        },
        additionalProperties: false,
      },
      null,
    );
    expect(search).toMatchObject({
      kind: "form",
      fields: [
        { name: "query", initial: "in:inbox" },
        { name: "maxResults", initial: "10" },
      ],
    });
    expect(runsOnArrival(search, readOnly)).toBe(true);
  });

  it("runs a tool with only optional fields, even where they start empty", () => {
    const optional = runInputView(
      { type: "object", properties: { label: { type: "string" } } },
      null,
    );
    expect(runsOnArrival(optional, readOnly)).toBe(true);
  });

  it("runs Open-Meteo with the starter's city prefilled", () => {
    const weather = runInputView(
      { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      { field: "city", label: "City", defaultValue: "Melbourne" },
    );
    expect(weather).toMatchObject({
      kind: "form",
      fields: [{ name: "city", initial: "Melbourne" }],
    });
    expect(canRun(weather, initialValues(weather), "")).toBe(true);
    expect(runsOnArrival(weather, readOnly)).toBe(true);
  });

  it("runs a required field that starts at the schema's first example", () => {
    const example = runInputView(
      {
        type: "object",
        properties: { q: { type: "string", examples: ["is:unread"] } },
        required: ["q"],
      },
      null,
    );
    expect(runsOnArrival(example, readOnly)).toBe(true);
  });

  it("waits for Run while a required field has no value", () => {
    const repo = runInputView(
      {
        type: "object",
        properties: { owner: { type: "string" }, limit: { type: "integer", default: 5 } },
        required: ["owner"],
      },
      null,
    );
    expect(canRun(repo, initialValues(repo), "")).toBe(false);
    expect(runsOnArrival(repo, readOnly)).toBe(false);
  });

  it("waits for Run when a starting value is not in its field's type", () => {
    const count = runInputView(
      { type: "object", properties: { count: { type: "integer", default: "many" } } },
      null,
    );
    expect(runsOnArrival(count, readOnly)).toBe(false);
  });

  it("never runs a tool that is not read-only, with or without inputs", () => {
    expect(
      runsOnArrival(runInputView({ type: "object", properties: {} }, null), { readOnly: false }),
    ).toBe(false);
  });

  it("waits for Run on a tool whose input is JSON", () => {
    const nested = runInputView(
      {
        type: "object",
        properties: { filter: { type: "object", properties: { label: { type: "string" } } } },
        required: ["filter"],
      },
      null,
    );
    expect(nested.kind).toBe("json");
    expect(runsOnArrival(nested, readOnly)).toBe(false);
  });
});

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
