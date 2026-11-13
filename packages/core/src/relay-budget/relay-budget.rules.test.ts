import type { RelayBudgetVerdict } from "@graft/proxy/types";
import { describe, expect, it } from "vitest";

import {
  HOUR_MS,
  hourStartOf,
  judgeRelayBudget,
  personWindowStart,
  type RelayBudgetLimits,
  type RelayCallBucket,
} from "./relay-budget.rules";

const AGENT = "agent_1";
const OTHER = "agent_2";
const NOW = new Date("2026-10-12T13:20:00Z");
const LIMITS: RelayBudgetLimits = { agentHourly: 250, personDaily: 1000 };

function hoursAgo(n: number): Date {
  return new Date(hourStartOf(NOW).getTime() - n * HOUR_MS);
}

function judge(buckets: RelayCallBucket[], limits = LIMITS): RelayBudgetVerdict {
  return judgeRelayBudget({ agentId: AGENT, buckets, limits, now: NOW });
}

describe("the hours the budget counts in", () => {
  it("is the clock hour for an agent, and that hour plus the 23 before it for a person", () => {
    expect(hourStartOf(NOW).toISOString()).toBe("2026-10-12T13:00:00.000Z");
    expect(personWindowStart(NOW).toISOString()).toBe("2026-10-11T14:00:00.000Z");
  });
});

describe("judging one relayed call", () => {
  it("allows a call under both ceilings", () => {
    expect(judge([{ agentId: AGENT, hourStart: hoursAgo(0), calls: 249 }])).toEqual({
      allowed: true,
    });
  });

  it("allows everything when neither ceiling is set", () => {
    expect(
      judge([{ agentId: AGENT, hourStart: hoursAgo(0), calls: 1_000_000 }], {
        agentHourly: null,
        personDaily: null,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses the agent's call that would pass its hourly ceiling, until the next hour", () => {
    expect(judge([{ agentId: AGENT, hourStart: hoursAgo(0), calls: 250 }])).toEqual({
      allowed: false,
      ceiling: "agent_hour",
      limit: 250,
      used: 250,
      resetsAt: new Date("2026-10-12T14:00:00Z"),
    });
  });

  it("counts only this agent's current hour against the hourly ceiling", () => {
    expect(
      judge([
        { agentId: AGENT, hourStart: hoursAgo(1), calls: 250 },
        { agentId: OTHER, hourStart: hoursAgo(0), calls: 250 },
      ]),
    ).toEqual({ allowed: true });
  });

  it("refuses past the person's daily ceiling across their agents, until enough of the oldest hour ages out", () => {
    const verdict = judge([
      { agentId: OTHER, hourStart: hoursAgo(23), calls: 400 },
      { agentId: AGENT, hourStart: hoursAgo(10), calls: 400 },
      { agentId: OTHER, hourStart: hoursAgo(0), calls: 200 },
    ]);
    // The 23-hours-ago bucket leaves the window when the current hour is 24 hours past it.
    expect(verdict).toEqual({
      allowed: false,
      ceiling: "person_day",
      limit: 1000,
      used: 1000,
      resetsAt: new Date(hoursAgo(23).getTime() + 24 * HOUR_MS),
    });
  });

  it("names the later reset when both ceilings are reached", () => {
    const verdict = judge([
      { agentId: OTHER, hourStart: hoursAgo(5), calls: 750 },
      { agentId: AGENT, hourStart: hoursAgo(0), calls: 250 },
    ]);
    expect(verdict).toMatchObject({ allowed: false, ceiling: "person_day" });
  });

  it("ignores a bucket older than the window, which the read should not have returned", () => {
    expect(judge([{ agentId: OTHER, hourStart: hoursAgo(24), calls: 5000 }])).toEqual({
      allowed: true,
    });
  });
});
