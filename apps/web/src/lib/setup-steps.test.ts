import { describe, expect, it } from "vitest";

import { backTargetOf, SETUP_RAIL_STEPS, setupProgress, setupRail } from "./setup-steps";

describe("setupRail", () => {
  it("lists the seven steps in order in the person's words: Integration, Task, Build", () => {
    expect(setupRail("harness").map((entry) => entry.label)).toEqual([
      "Harness",
      "Integration",
      "Connect",
      "Task",
      "Build",
      "Result",
      "Finish",
    ]);
    expect(SETUP_RAIL_STEPS).not.toContain("completed");
  });

  it("marks the steps before the current one done and the rest upcoming", () => {
    expect(setupRail("vendor").map((entry) => entry.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(setupRail("building").find((entry) => entry.state === "current")?.position).toBe(5);
  });

  it("marks every step done once Setup is complete, and links none", () => {
    expect(setupRail("completed").every((entry) => entry.state === "done")).toBe(true);
    expect(setupRail("completed", { ...HELD, step: "completed" }).some((e) => e.link)).toBe(false);
  });
});

/** A record holding a connection, a job and its tool (GRA-215). */
const HELD = {
  pendingActionId: null,
  connectionId: "conn_1",
  acquireJobId: "job_1",
  toolId: "tool_1",
};
const linked = (entries: ReturnType<typeof setupRail>) =>
  entries.filter((entry) => entry.link).map((entry) => entry.step);

describe("the rail's links (GRA-215)", () => {
  it("links every completed step and the current one, and no step ahead", () => {
    expect(linked(setupRail("goal", { ...HELD, step: "goal" }))).toEqual([
      "harness",
      "vendor",
      "connect",
      "goal",
    ]);
    expect(linked(setupRail("finish", { ...HELD, step: "finish" }))).toEqual([
      "harness",
      "vendor",
      "connect",
      "goal",
      "building",
      "result",
      "finish",
    ]);
    expect(linked(setupRail("harness", { ...HELD, step: "harness" }))).toEqual(["harness"]);
  });

  it("neither links nor checks the result a record passed while its job ran", () => {
    const rail = setupRail("finish", { ...HELD, toolId: null, step: "finish" });
    expect(rail.find((entry) => entry.step === "result")).toMatchObject({
      state: "upcoming",
      link: false,
    });
    expect(rail.find((entry) => entry.step === "building")).toMatchObject({
      state: "done",
      link: true,
    });
  });

  it("links nothing when the step on screen is not the record's, or without the record", () => {
    expect(linked(setupRail("harness", { ...HELD, step: "goal" }))).toEqual([]);
    expect(linked(setupRail("goal"))).toEqual([]);
  });
});

describe("setupProgress", () => {
  it("says which step of seven, with a colon and no dash", () => {
    expect(setupProgress("harness")).toEqual({ text: "Step 1 of 7: Harness", fraction: 1 / 7 });
    expect(setupProgress("vendor").text).toBe("Step 2 of 7: Integration");
    expect(setupProgress("finish")).toEqual({ text: "Step 7 of 7: Finish", fraction: 1 });
    expect(setupProgress("completed")).toEqual({ text: "Setup complete", fraction: 1 });
  });
});

describe("backTargetOf (GRA-215)", () => {
  it("goes back to the step before, skipping one the record never held", () => {
    expect(backTargetOf({ step: "goal", setup: { ...HELD, step: "goal" } })).toBe("connect");
    expect(backTargetOf({ step: "finish", setup: { ...HELD, step: "finish" } })).toBe("result");
    expect(backTargetOf({ step: "finish", setup: { ...HELD, toolId: null, step: "finish" } })).toBe(
      "building",
    );
  });

  it("has nowhere to go on the first step, before a record, or off the record's step", () => {
    expect(backTargetOf({ step: "harness", setup: { ...HELD, step: "harness" } })).toBeNull();
    expect(backTargetOf({ step: "harness", setup: null })).toBeNull();
    expect(backTargetOf({ step: "harness", setup: { ...HELD, step: "goal" } })).toBeNull();
  });
});
