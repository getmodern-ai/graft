import { describe, expect, it } from "vitest";

import {
  choiceSummary,
  initialToolChoice,
  tasksBesideReadyMade,
  toolStepDescription,
} from "./setup-ready-made";

const SEARCH = { tool: "gmail__search-messages", goal: "Show me my latest inbox emails" };
const LABELS = { tool: "gmail__list-labels", goal: "List my Gmail labels" };
const READY = [SEARCH, LABELS];

describe("tasksBesideReadyMade", () => {
  it("drops a task a ready-made tool already does, and keeps the rest in order", () => {
    expect(
      tasksBesideReadyMade(
        ["Show me my five latest inbox conversations", "List my Gmail labels", "Starred"],
        READY,
      ),
    ).toEqual(["Show me my five latest inbox conversations", "Starred"]);
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
