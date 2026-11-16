import type { DbOrTx } from "@graft/db";
import type { RelayCallBucketRow } from "@graft/db/repo/relay-call";
import { describe, expect, it } from "vitest";

import type { RelayBudgetDeps } from "./relay-budget.deps";
import { HOUR_MS } from "./relay-budget.rules";
import { chargeRelayCall, peekRelayBudget, pruneRelayCallCounts } from "./relay-budget.service";

/**
 * The relay budget's service over an in-memory count (GRA-349): what a charge reads, when it
 * writes, and the incident it exists for. The repo's SQL is pinned in `packages/db`'s
 * `repo/scope.test.ts`; here the rows live in a map keyed as the table is.
 */

const db = {} as DbOrTx;
const SCOPE = { personId: "person_1", agentId: "agent_1" };
const LIMITS = { agentHourly: 250, personDaily: 1000 };

function memoryDeps(start: Date) {
  const rows = new Map<string, RelayCallBucketRow & { personId: string }>();
  let clock = start.getTime();
  const reads: number[] = [];
  const deps: RelayBudgetDeps = {
    listRelayCallBuckets: async (_db, personId, since) => {
      reads.push(1);
      return [...rows.values()]
        .filter((row) => row.personId === personId && row.hourStart >= since)
        .map(({ agentId, hourStart, calls }) => ({ agentId, hourStart, calls }));
    },
    recordRelayCall: async (_db, scope, hourStart) => {
      const key = `${scope.agentId}|${hourStart.getTime()}`;
      const row = rows.get(key);
      if (row) row.calls += 1;
      else rows.set(key, { ...scope, hourStart, calls: 1 });
    },
    deleteRelayCallCountsBefore: async (_db, before) => {
      let deleted = 0;
      for (const [key, row] of rows) {
        if (row.hourStart < before) {
          rows.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    },
    now: () => new Date(clock),
  };
  return {
    deps,
    rows,
    reads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("charging a relayed call", () => {
  it("reads and writes nothing when the deployment set no ceiling", async () => {
    const m = memoryDeps(new Date("2026-10-12T13:00:00Z"));
    const verdict = await chargeRelayCall(
      { db },
      SCOPE,
      { agentHourly: null, personDaily: null },
      m.deps,
    );
    expect(verdict).toEqual({ allowed: true });
    expect(m.reads).toHaveLength(0);
    expect(m.rows.size).toBe(0);
  });

  it("counts an allowed call in the agent's hour, and never counts a refused one", async () => {
    const m = memoryDeps(new Date("2026-10-12T13:00:00Z"));
    for (let i = 0; i < 3; i += 1) {
      expect(
        await chargeRelayCall({ db }, SCOPE, { agentHourly: 2, personDaily: null }, m.deps),
      ).toMatchObject({
        allowed: i < 2,
      });
    }
    expect([...m.rows.values()].map((row) => row.calls)).toEqual([2]);
  });
});

describe("peeking at the budget (GRA-350)", () => {
  it("judges as a charge does and never counts, under a ceiling or past it", async () => {
    const m = memoryDeps(new Date("2026-10-12T13:00:00Z"));
    const limits = { agentHourly: 2, personDaily: null };
    expect(await peekRelayBudget({ db }, SCOPE, limits, m.deps)).toEqual({ allowed: true });
    expect(m.rows.size).toBe(0);
    await chargeRelayCall({ db }, SCOPE, limits, m.deps);
    await chargeRelayCall({ db }, SCOPE, limits, m.deps);
    const peeked = await peekRelayBudget({ db }, SCOPE, limits, m.deps);
    expect(peeked).toEqual({
      allowed: false,
      ceiling: "agent_hour",
      limit: 2,
      used: 2,
      resetsAt: new Date("2026-10-12T14:00:00Z"),
    });
    // The charge the peek foresaw is refused alike, and neither moved the count.
    expect(await chargeRelayCall({ db }, SCOPE, limits, m.deps)).toEqual(peeked);
    expect([...m.rows.values()].map((row) => row.calls)).toEqual([2]);
  });

  it("reads nothing when the deployment set no ceiling", async () => {
    const m = memoryDeps(new Date("2026-10-12T13:00:00Z"));
    expect(
      await peekRelayBudget({ db }, SCOPE, { agentHourly: null, personDaily: null }, m.deps),
    ).toEqual({ allowed: true });
    expect(m.reads).toHaveLength(0);
  });
});

/**
 * The incident (GRA-348): one agent, one relayed call every 7.5 s, around the clock, for four days
 * from 12 to 16 Oct. 46,080 attempts; the incident's logs show 34,570 reached Pipedream. Under 250 an
 * agent-hour and 1,000 a person-day, no hour passes 250, no 24 hours pass 1,000, and the four days
 * come to 4,000 at most.
 */
describe("the incident's loop, replayed", () => {
  it("is held to 250 an hour and 1,000 a day", async () => {
    const start = new Date("2026-10-12T00:00:00Z");
    const m = memoryDeps(start);
    const allowedAt: number[] = [];
    const STEP_MS = 7_500;
    const attempts = (4 * 24 * HOUR_MS) / STEP_MS;
    for (let i = 0; i < attempts; i += 1) {
      const verdict = await chargeRelayCall({ db }, SCOPE, LIMITS, m.deps);
      if (verdict.allowed) allowedAt.push(start.getTime() + i * STEP_MS);
      m.advance(STEP_MS);
    }

    expect(attempts).toBe(46_080);
    const perHour = new Map<number, number>();
    for (const at of allowedAt) {
      const hour = Math.floor(at / HOUR_MS);
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    expect(Math.max(...perHour.values())).toBeLessThanOrEqual(250);
    const hours = [...perHour.keys()].sort((a, b) => a - b);
    for (const hour of hours) {
      let day = 0;
      for (let h = hour - 23; h <= hour; h += 1) day += perHour.get(h) ?? 0;
      expect(day).toBeLessThanOrEqual(1000);
    }
    expect(allowedAt.length).toBeLessThanOrEqual(4000);
    // Stopped within the first hour: the 251st call of the first hour is refused, 31 minutes in.
    expect(perHour.get(Math.floor(start.getTime() / HOUR_MS))).toBe(250);
  });
});

describe("pruning old hours", () => {
  it("deletes every hour older than two days and keeps the rest", async () => {
    const now = new Date("2026-10-14T13:20:00Z");
    const m = memoryDeps(now);
    await m.deps.recordRelayCall(db, SCOPE, new Date("2026-10-12T12:00:00Z"));
    await m.deps.recordRelayCall(db, SCOPE, new Date("2026-10-12T14:00:00Z"));
    expect(await pruneRelayCallCounts({ db }, m.deps)).toBe(1);
    expect(m.rows.size).toBe(1);
  });
});
