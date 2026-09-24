import { describe, expect, it } from "vitest";

import { resultToolOf, runsOnArrival } from "./setup-result";
import { canRun, initialValues, runInputView } from "./setup-run-input";

describe("runsOnArrival", () => {
  it("runs a tool that takes no input", () => {
    expect(runsOnArrival(runInputView({ type: "object", properties: {} }, null))).toBe(true);
  });

  it("waits for Run on a tool with inputs, even with the starter's city prefilled", () => {
    // Greptile on #172: the task says "a city I name", and Melbourne is only where the field starts.
    const weather = runInputView(
      { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      { field: "city", label: "City", defaultValue: "Melbourne" },
    );
    expect(weather).toMatchObject({
      kind: "form",
      fields: [{ name: "city", initial: "Melbourne" }],
    });
    expect(canRun(weather, initialValues(weather), "")).toBe(true);
    expect(runsOnArrival(weather)).toBe(false);
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
    expect(runsOnArrival(nested)).toBe(false);
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
