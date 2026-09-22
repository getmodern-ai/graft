import { describe, expect, it } from "vitest";

import { WAIT_SLACK_SECONDS } from "./bounds";
import {
  createInFlightRegistry,
  detachedHoldMs,
  isSettledProcess,
  trackDetachedStart,
} from "./in-flight";

/**
 * The registry's contract, on its own: a call holds until released, a detached process until settled
 * or until its time is up, and an agent is in flight while it has either. The sweep's use of it is
 * `sweep.test.ts`, through the MCP client.
 */

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a call", () => {
  it("holds the agent from begin until release, counting concurrent calls, and releasing twice is a no-op", () => {
    const registry = createInFlightRegistry();
    expect(registry.has("a")).toBe(false);

    const first = registry.begin("a");
    const second = registry.begin("a");
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(false);

    first();
    first();
    expect(registry.has("a")).toBe(true);
    second();
    expect(registry.has("a")).toBe(false);
  });
});

/**
 * The blob budget a run is handed (GRA-187, after Greptile on #148): outstanding from the grant
 * until its release, or, moved onto a detached process, until that process settles or times out.
 */
describe("a budget grant", () => {
  it("is outstanding until released, summed across calls, and releasing twice is a no-op", () => {
    const registry = createInFlightRegistry();
    expect(registry.outstandingBudget("a")).toBe(0);
    const first = registry.grant("a", 1000);
    const second = registry.grant("a", 500);
    expect(registry.outstandingBudget("a")).toBe(1500);
    expect(registry.outstandingBudget("b")).toBe(0);
    first();
    first();
    expect(registry.outstandingBudget("a")).toBe(500);
    second();
    expect(registry.outstandingBudget("a")).toBe(0);
    // A grant alone is not a hold: the sweep's question is unchanged by it.
    registry.grant("a", 7);
    expect(registry.has("a")).toBe(false);
    registry.close();
  });

  it("rides on a detached process until it is settled or its time is up", async () => {
    const registry = createInFlightRegistry();
    registry.track("a", "tool-1", 60_000, 2048);
    registry.track("a", "tool-2", 20, 1024);
    expect(registry.outstandingBudget("a")).toBe(3072);
    registry.settle("a", "tool-1");
    expect(registry.outstandingBudget("a")).toBe(1024);
    await tick(40);
    expect(registry.outstandingBudget("a")).toBe(0);
    expect(registry.has("a")).toBe(false);
    registry.close();
  });
});

describe("a detached process", () => {
  it("holds by name until settled", () => {
    const registry = createInFlightRegistry();
    registry.track("a", "cmd-1", 60_000);
    registry.track("a", "cmd-2", 60_000);
    expect(registry.has("a")).toBe(true);

    registry.settle("a", "cmd-1");
    expect(registry.has("a")).toBe(true);
    registry.settle("a", "unknown");
    registry.settle("b", "cmd-2");
    expect(registry.has("a")).toBe(true);
    registry.settle("a", "cmd-2");
    expect(registry.has("a")).toBe(false);
    registry.close();
  });

  it("releases on its own once its time is up", async () => {
    const registry = createInFlightRegistry();
    registry.track("a", "cmd-1", 20);
    expect(registry.has("a")).toBe(true);
    await tick(40);
    expect(registry.has("a")).toBe(false);
    registry.close();
  });

  it("is held for the kill bound plus the poll's slack", () => {
    expect(detachedHoldMs(600)).toBe((600 + WAIT_SLACK_SECONDS) * 1_000);
  });

  it("is read off a detached start's answer and off nothing else", () => {
    const registry = createInFlightRegistry();
    trackDetachedStart(registry, "a", { exitCode: 0, output: "" });
    trackDetachedStart(registry, "a", { status: "running", exitCode: null, output: "" });
    trackDetachedStart(registry, "a", { error: "refused", reason: "x", message: "y" });
    expect(registry.has("a")).toBe(false);

    trackDetachedStart(registry, "a", {
      status: "running",
      processName: "cmd-abc",
      timeoutSeconds: 600,
      startedAt: "",
      resultPath: "",
    });
    expect(registry.has("a")).toBe(true);
    registry.close();
    expect(registry.has("a")).toBe(false);
  });

  it("is settled by a completed, failed or killed poll and by nothing else", () => {
    expect(isSettledProcess({ status: "completed" })).toBe(true);
    expect(isSettledProcess({ status: "failed" })).toBe(true);
    expect(isSettledProcess({ status: "killed" })).toBe(true);
    expect(isSettledProcess({ status: "running" })).toBe(false);
    expect(isSettledProcess({ error: "The sandbox is unavailable right now" })).toBe(false);
    expect(isSettledProcess(null)).toBe(false);
  });
});
