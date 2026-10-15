import { describe, expect, it } from "vitest";

import {
  choiceSummary,
  connectStepDescription,
  initialToolChoice,
  tasksBesideReadyMade,
  toolStepDescription,
} from "./setup-ready-made";

const SEARCH = {
  tool: "gmail__search-messages",
  goal: "Show me my latest inbox emails",
  replaces: ["Show me my five latest inbox conversations"],
};
const LABELS = { tool: "gmail__list-labels", goal: "List my Gmail labels" };
const READY = [SEARCH, LABELS];

describe("tasksBesideReadyMade", () => {
  it("drops a task a ready-made tool already does, in its words or those it names, and keeps the rest", () => {
    expect(
      tasksBesideReadyMade(
        ["Show me my five latest inbox conversations", "List my Gmail labels", "Starred"],
        READY,
      ),
    ).toEqual(["Starred"]);
    expect(tasksBesideReadyMade(["A"], [])).toEqual(["A"]);
  });
});

describe("initialToolChoice", () => {
  it("starts on the ready-made tool the record holds while it is offered", () => {
    expect(initialToolChoice({ stockTool: LABELS.tool, goal: LABELS.goal }, READY, "")).toEqual({
      kind: "ready",
      tool: LABELS.tool,
    });
  });

  it("falls back to the task when the held tool is no longer offered", () => {
    expect(initialToolChoice({ stockTool: "gmail__gone", goal: "Gone" }, READY, "Curated")).toEqual(
      { kind: "task", text: "Curated" },
    );
  });

  it("starts on the record's task, or the fallback, and on the ready-made tool that does it", () => {
    expect(initialToolChoice({ stockTool: null, goal: "Starred" }, READY, "")).toEqual({
      kind: "task",
      text: "Starred",
    });
    expect(initialToolChoice(null, READY, "")).toEqual({ kind: "task", text: "" });
    expect(initialToolChoice(null, READY, LABELS.goal)).toEqual({
      kind: "ready",
      tool: LABELS.tool,
    });
    expect(initialToolChoice(null, [], LABELS.goal)).toEqual({ kind: "task", text: LABELS.goal });
    // A task in other words than the card's, which the curation names as done by it.
    expect(initialToolChoice(null, READY, SEARCH.replaces[0] ?? "")).toEqual({
      kind: "ready",
      tool: SEARCH.tool,
    });
  });
});

describe("choiceSummary", () => {
  it("names a ready-made tool by its task, and a task by its trimmed words", () => {
    expect(choiceSummary({ kind: "ready", tool: SEARCH.tool }, READY)).toBe(SEARCH.goal);
    expect(choiceSummary({ kind: "ready", tool: "gmail__gone" }, READY)).toBe("");
    expect(choiceSummary({ kind: "task", text: "  Starred " }, READY)).toBe("Starred");
  });
});

describe("toolStepDescription", () => {
  it("names the ready-made tools first where there are any, with no em dash", () => {
    const lines = [true, false].flatMap((readyMade) =>
      [true, false].map((connected) => toolStepDescription({ readyMade, connected })),
    );
    expect(lines[0]).toMatch(/^Use a ready-made tool/);
    expect(lines[2]).toMatch(/^Pick one read-only tool to build\./);
    for (const line of lines) expect(line).not.toContain("—");
  });
});

describe("connectStepDescription", () => {
  const names = { vendorName: "Gmail", agentName: "Claude" };

  it("says the tool is ready, not built, on the ready-made path", () => {
    // Production e2e of 2026-10-14: the ready-made path said Graft starts building.
    const line = connectStepDescription({
      ...names,
      record: { stockTool: SEARCH.tool, goal: SEARCH.goal },
    });
    expect(line).toBe("Your tool is ready the moment Gmail is connected.");
    expect(line).not.toMatch(/build/i);
  });

  it("says Graft starts building on the build path", () => {
    expect(
      connectStepDescription({ ...names, record: { stockTool: null, goal: "List my labels" } }),
    ).toBe("Graft starts building your tool the moment Gmail is connected.");
  });

  it("asks for the connection as the agent's own with neither chosen", () => {
    const expected =
      "Claude asks for this connection as its own, the way it would from your chat. Answer it here.";
    expect(connectStepDescription({ ...names, record: { stockTool: null, goal: null } })).toBe(
      expected,
    );
    expect(connectStepDescription({ ...names, record: null })).toBe(expected);
  });

  it("writes no em dash on any path", () => {
    const records = [
      { stockTool: SEARCH.tool, goal: SEARCH.goal },
      { stockTool: null, goal: "List my labels" },
      null,
    ];
    for (const record of records) {
      expect(connectStepDescription({ ...names, record })).not.toContain("—");
    }
  });
});
