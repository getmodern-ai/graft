import { describe, expect, it } from "vitest";

import { setupEyebrow, setupStageOf, setupStages, stageHistoryMove } from "./setup-stages";

describe("setupStageOf", () => {
  it("reads the vendor step as Integration before a starter and Tool after", () => {
    expect(setupStageOf("harness", null)).toBe(1);
    expect(setupStageOf("vendor", null)).toBe(2);
    expect(setupStageOf("vendor", "gmail")).toBe(3);
    expect(setupStageOf("goal", null)).toBe(3);
    for (const step of ["connect", "building", "result", "finish", "completed"] as const) {
      expect(setupStageOf(step, "gmail")).toBe(4);
    }
  });
});

describe("setupStages", () => {
  it("marks the stages before the current one done and the rest upcoming", () => {
    expect(setupStages("vendor", "gmail").map((entry) => entry.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
    ]);
  });

  it("marks every stage done on the done screen", () => {
    expect(setupStages("result", "gmail").every((entry) => entry.state === "done")).toBe(true);
  });
});

describe("setupEyebrow", () => {
  it("names the stage and its place, or the completion", () => {
    expect(setupEyebrow("connect", "gmail")).toBe("Step 4 of 4 · Connect & build");
    expect(setupEyebrow("vendor", null)).toBe("Step 2 of 4 · Integration");
    expect(setupEyebrow("finish", "gmail")).toBe("Setup complete");
  });
});

describe("stageHistoryMove", () => {
  it("guards a URL with no stage, then pushes each stage the record reaches", () => {
    expect(stageHistoryMove({ stage: 1, urlStage: undefined, previousUrlStage: undefined })).toBe(
      "guard",
    );
    expect(stageHistoryMove({ stage: 3, urlStage: 2, previousUrlStage: 2 })).toBe("push");
    expect(stageHistoryMove({ stage: 3, urlStage: 3, previousUrlStage: 2 })).toBe("none");
  });

  it("reads a browser Back as the step's Back, and Back onto the guard as staying", () => {
    expect(stageHistoryMove({ stage: 3, urlStage: 2, previousUrlStage: 3 })).toBe("back");
    expect(stageHistoryMove({ stage: 1, urlStage: 0, previousUrlStage: 1 })).toBe("stay");
  });

  it("follows the footer's Back without a new entry", () => {
    expect(stageHistoryMove({ stage: 2, urlStage: 3, previousUrlStage: 3 })).toBe("replace");
  });
});
