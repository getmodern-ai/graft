import { describe, expect, it } from "vitest";

import { SETUP_RAIL_STEPS, setupProgress, setupRail } from "./setup-steps";

describe("setupRail", () => {
  it("lists the seven steps in order, the build step named Build", () => {
    expect(setupRail("harness").map((entry) => entry.label)).toEqual([
      "Harness",
      "Vendor",
      "Connect",
      "Goal",
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

  it("marks every step done once Setup is complete", () => {
    expect(setupRail("completed").every((entry) => entry.state === "done")).toBe(true);
  });
});

describe("setupProgress", () => {
  it("says which step of seven, with a colon and no dash", () => {
    expect(setupProgress("harness")).toEqual({ text: "Step 1 of 7: Harness", fraction: 1 / 7 });
    expect(setupProgress("finish")).toEqual({ text: "Step 7 of 7: Finish", fraction: 1 });
    expect(setupProgress("completed")).toEqual({ text: "Setup complete", fraction: 1 });
  });
});
