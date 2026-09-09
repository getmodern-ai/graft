import { describe, expect, it } from "vitest";

import { DAY_MS, type SweepEntry, sweepDecision } from "./sweep.decision";

/**
 * ADR 0009, clause by clause, with no clock but the one handed in. Every case names its entries by
 * what the rule should see in them — idle, fresh, promoted-and-unused — so a failure reads as a
 * sentence about the rule rather than about a date.
 */

const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const entry = (
  toolId: string,
  promotedDaysAgo: number,
  usedDaysAgo: number | null,
): SweepEntry => ({
  toolId,
  promotedAt: daysAgo(promotedDaysAgo),
  lastUsedAt: usedDaysAgo === null ? null : daysAgo(usedDaysAgo),
});

const decide = (
  entries: SweepEntry[],
  overrides: Partial<{ cap: number; idleWindowDays: number; inFlight: boolean }> = {},
) =>
  sweepDecision({
    entries,
    cap: 20,
    idleWindowDays: 21,
    now: NOW,
    inFlight: false,
    ...overrides,
  });

describe("the idle window", () => {
  it("demotes a tool whose last use is older than the window, counting a never-used tool from its promotion", () => {
    const { demote } = decide([
      entry("used-long-ago", 60, 30),
      entry("promoted-and-forgotten", 30, null),
      entry("used-lately", 60, 5),
      entry("promoted-lately", 5, null),
    ]);
    expect(demote).toEqual([
      { toolId: "used-long-ago", cause: "idle" },
      { toolId: "promoted-and-forgotten", cause: "idle" },
    ]);
  });

  it("is strict: unused for exactly the window is not yet past it", () => {
    expect(decide([entry("on-the-line", 21, null)]).demote).toEqual([]);
    expect(decide([entry("just-past", 21.001, null)]).demote).toEqual([
      { toolId: "just-past", cause: "idle" },
    ]);
  });

  it("reads a use recorded before the promotion as no use of this promotion", () => {
    // Re-promoted yesterday; the ledger still carries a call from an earlier promotion.
    const { demote } = decide([entry("re-promoted", 1, 40)]);
    expect(demote).toEqual([]);
  });

  it("follows the agent's own window", () => {
    const entries = [entry("t", 10, null)];
    expect(decide(entries, { idleWindowDays: 7 }).demote).toEqual([{ toolId: "t", cause: "idle" }]);
    expect(decide(entries, { idleWindowDays: 14 }).demote).toEqual([]);
  });
});

describe("the cap", () => {
  it("demotes the least recently used beyond the cap, and the two recently used remain", () => {
    const { demote } = decide(
      [entry("never-used", 10, null), entry("used-yesterday", 10, 1), entry("used-today", 10, 0)],
      { cap: 2 },
    );
    expect(demote).toEqual([{ toolId: "never-used", cause: "cap" }]);
  });

  it("takes the oldest promotions first when several are unused", () => {
    const { demote } = decide(
      [
        entry("promoted-3-days-ago", 3, null),
        entry("promoted-10-days-ago", 10, null),
        entry("promoted-6-days-ago", 6, null),
        entry("fresh", 10, 1),
      ],
      { cap: 2 },
    );
    expect(demote).toEqual([
      { toolId: "promoted-10-days-ago", cause: "cap" },
      { toolId: "promoted-6-days-ago", cause: "cap" },
    ]);
  });

  /** ADR 0009: the cap is a backstop, not a hard limit. */
  it("never demotes a tool used inside the window, so a set of fresh tools may exceed the cap", () => {
    const fresh = [entry("a", 10, 1), entry("b", 10, 2), entry("c", 10, 3)];
    expect(decide(fresh, { cap: 1 }).demote).toEqual([]);

    const { demote } = decide([...fresh, entry("unused", 10, null)], { cap: 1 });
    expect(demote).toEqual([{ toolId: "unused", cause: "cap" }]);
  });

  it("counts against the cap only what the idle window left", () => {
    // Two idle, three kept, cap two: one cap demotion, not three.
    const { demote } = decide(
      [
        entry("idle-1", 40, null),
        entry("idle-2", 40, 30),
        entry("kept-unused", 5, null),
        entry("kept-used", 5, 1),
        entry("kept-used-too", 5, 2),
      ],
      { cap: 2 },
    );
    expect(demote).toEqual([
      { toolId: "idle-1", cause: "idle" },
      { toolId: "idle-2", cause: "idle" },
      { toolId: "kept-unused", cause: "cap" },
    ]);
  });
});

describe("a run in flight", () => {
  it("yields nothing, whatever the set looks like", () => {
    const { demote } = decide([entry("idle", 40, null), entry("over-cap", 5, null)], {
      cap: 1,
      inFlight: true,
    });
    expect(demote).toEqual([]);
  });
});

describe("determinism", () => {
  it("orders ties by promotion time and then tool id, whatever order the entries arrive in", () => {
    const entries = [
      entry("b", 30, null),
      entry("a", 30, null),
      entry("c", 31, null),
      entry("y", 5, null),
      entry("x", 5, null),
    ];
    const expected = [
      { toolId: "c", cause: "idle" },
      { toolId: "a", cause: "idle" },
      { toolId: "b", cause: "idle" },
      { toolId: "x", cause: "cap" },
    ];
    expect(decide(entries, { cap: 1 }).demote).toEqual(expected);
    expect(decide([...entries].reverse(), { cap: 1 }).demote).toEqual(expected);
  });

  it("does nothing with an empty set", () => {
    expect(decide([], { cap: 1 })).toEqual({ demote: [] });
  });
});
