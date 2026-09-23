import { describe, expect, it } from "vitest";

import { finishVariant, promptToolOf, snippetShapeOf, toolArrival } from "./setup-finish";

const GOAL = "Read the current weather for a city. Read only.";

describe("finishVariant", () => {
  it("shows the token for a static-token harness, the consent for an OAuth one, and the chat for an adopted agent", () => {
    expect(finishVariant("hermes")).toBe("token");
    expect(finishVariant("openclaw")).toBe("token");
    expect(finishVariant("other")).toBe("token");
    expect(finishVariant("claude")).toBe("oauth");
    expect(finishVariant("chatgpt")).toBe("oauth");
    expect(finishVariant("claude-code")).toBe("oauth");
    expect(finishVariant("codex")).toBe("oauth");
    expect(finishVariant(null)).toBe("adopted");
  });

  it("draws each static-token harness's configuration in its own shape", () => {
    expect(snippetShapeOf("hermes")).toBe("hermes");
    expect(snippetShapeOf("openclaw")).toBe("openclaw");
    expect(snippetShapeOf("other")).toBe("generic");
  });
});

describe("toolArrival and promptToolOf", () => {
  it("names the tool once it landed", () => {
    const context = {
      goal: GOAL,
      job: { status: "succeeded", failure: null },
      tool: { wireName: "open-meteo__current-weather" },
    };
    expect(toolArrival(context)).toEqual({
      kind: "landed",
      wireName: "open-meteo__current-weather",
    });
    expect(promptToolOf(context)).toEqual({ goal: GOAL, wireName: "open-meteo__current-weather" });
  });

  it("says the tool is arriving while the job the person continued past still runs", () => {
    for (const status of ["queued", "running", "succeeded"]) {
      const context = { goal: GOAL, job: { status, failure: null }, tool: null };
      expect(toolArrival(context)).toEqual({ kind: "arriving" });
      expect(promptToolOf(context)).toEqual({ goal: GOAL });
    }
  });

  it("carries the failure's sentence, and names no tool in the prompt, once the job failed", () => {
    const context = {
      goal: GOAL,
      job: { status: "failed", failure: "The model gave up." },
      tool: null,
    };
    expect(toolArrival(context)).toEqual({ kind: "failed", message: "The model gave up." });
    expect(promptToolOf(context)).toBeUndefined();
    expect(toolArrival({ goal: null, job: null, tool: null })).toEqual({ kind: "none" });
  });
});
