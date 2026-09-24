import { describe, expect, it } from "vitest";

import type { PendingAction } from "./pending-action-queries";
import {
  ANOTHER_VENDOR,
  choiceLeavesJob,
  connectAskView,
  jobRunning,
  SETUP_CONNECT_LABEL,
} from "./setup-vendors";

const action = (id: string) => ({ id }) as PendingAction;

describe("connectAskView", () => {
  it("draws the record's ask while it is open, and waits while the list loads", () => {
    const open = [action("pa_other"), action("pa_1")];
    expect(connectAskView("pa_1", open)).toEqual({ kind: "card", action: open[1] });
    expect(connectAskView("pa_1", undefined)).toEqual({ kind: "loading" });
  });

  it("settles once the ask has left the open list, or when the record names none", () => {
    expect(connectAskView("pa_1", [action("pa_other")])).toEqual({ kind: "settling" });
    expect(connectAskView(null, [action("pa_1")])).toEqual({ kind: "settling" });
  });
});

describe("SETUP_CONNECT_LABEL", () => {
  it("names every connect kind in sentence case", () => {
    for (const label of Object.values(SETUP_CONNECT_LABEL)) {
      expect(label).toMatch(/^[A-Z][a-z ]+$/);
    }
  });
});

describe("choiceLeavesJob (GRA-215)", () => {
  const running = { starterId: "open-meteo", jobStatus: "running" };

  it("asks before another integration replaces a connection whose job still runs", () => {
    expect(choiceLeavesJob("github", running)).toBe(true);
    expect(choiceLeavesJob(ANOTHER_VENDOR, running)).toBe(true);
    expect(choiceLeavesJob("github", { starterId: null, jobStatus: "queued" })).toBe(true);
  });

  it("never asks for the same integration, a finished job, or no job", () => {
    expect(choiceLeavesJob("open-meteo", running)).toBe(false);
    expect(choiceLeavesJob("github", { ...running, jobStatus: "failed" })).toBe(false);
    expect(choiceLeavesJob("github", { ...running, jobStatus: "succeeded" })).toBe(false);
    expect(choiceLeavesJob("github", null)).toBe(false);
    expect(jobRunning(null)).toBe(false);
  });
});
