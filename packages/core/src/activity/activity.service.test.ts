import type { ActivityPosition, ActivityRow, ActivityRunRow } from "@graft/db/repo/activity";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { ActivityDeps } from "./activity.deps";
import {
  decodeActivityCursor,
  encodeActivityCursor,
  getAgentActivityStats,
  listActivity,
} from "./activity.service";

const NOW = new Date("2026-10-14T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const ctx = { db: {} } as unknown as ServiceContext;

function run(at: string, id: string): ActivityRunRow {
  return {
    kind: "run",
    position: { at, key: `run:${id}` },
    at: new Date(`${at.replace(" ", "T")}Z`),
    agentId: "agent_1",
    agentName: "Codex",
    vendor: "gmail",
    connectionId: "conn_1",
    id,
    toolName: "gmail__find-invoices",
    tool: null,
    outcome: "ok",
    reason: null,
    asked: false,
    latencyMs: 12,
    dryRun: false,
  };
}

/**
 * The repo's keyset in memory: newest first on (moment, key), bytewise, rows strictly before the
 * cursor. What the statement does, so the service's paging can be driven through inserts.
 */
function keysetStore(rows: ActivityRow[]) {
  const before = (a: ActivityPosition, b: ActivityPosition) =>
    a.at < b.at || (a.at === b.at && a.key < b.key);
  return vi.fn<ActivityDeps["listActivity"]>(async (_db, _personId, args) =>
    [...rows]
      .sort((x, y) => (before(x.position, y.position) ? 1 : -1))
      .filter((row) => !args.after || before(row.position, args.after))
      .slice(0, args.limit),
  );
}

function fakeDeps(overrides: Partial<ActivityDeps> = {}): ActivityDeps {
  return {
    listActivity: vi.fn(async () => []),
    countAgentActivity: vi.fn(async () => ({ runs: 0, ranWithoutAsking: 0, approved: 0 })),
    findAgentLastRun: vi.fn(async () => null),
    now: () => NOW,
    ...overrides,
  };
}

describe("listActivity", () => {
  it("keeps its place across inserts: a row written between pages lands above, and the next page neither repeats nor skips", async () => {
    const rows: ActivityRow[] = [
      run("2026-10-14 09:00:00.000001", "u_a"),
      run("2026-10-14 09:00:00.000001", "u_b"),
      run("2026-10-14 08:00:00", "u_c"),
      run("2026-10-14 07:00:00", "u_d"),
    ];
    const deps = fakeDeps({ listActivity: keysetStore(rows) });

    const first = await listActivity(ctx, PRINCIPAL, { limit: 2 }, deps);
    expect(first.rows.map((row) => row.position.key)).toEqual(["run:u_b", "run:u_a"]);
    expect(first.nextCursor).not.toBeNull();

    rows.push(run("2026-10-14 09:30:00", "u_new"), run("2026-10-14 09:00:00.000001", "u_0"));
    const second = await listActivity(ctx, PRINCIPAL, { limit: 2, cursor: first.nextCursor }, deps);
    // `u_0` sorts below `u_a` at the same microsecond, so it belongs after the cursor, once.
    expect(second.rows.map((row) => row.position.key)).toEqual(["run:u_0", "run:u_c"]);

    const third = await listActivity(ctx, PRINCIPAL, { limit: 2, cursor: second.nextCursor }, deps);
    expect(third.rows.map((row) => row.position.key)).toEqual(["run:u_d"]);
    expect(third.nextCursor).toBeNull();
  });

  it("reads one row past the page under the person, and hands every filter to the statement", async () => {
    const deps = fakeDeps();
    await listActivity(
      ctx,
      PRINCIPAL,
      {
        agentId: "agent_1",
        vendor: "gmail",
        connectionId: "conn_1",
        outcome: "refused",
        kind: "run",
        includeDryRuns: true,
        limit: 10,
      },
      deps,
    );
    expect(deps.listActivity).toHaveBeenCalledWith(ctx.db, "person_1", {
      filter: {
        agentId: "agent_1",
        vendor: "gmail",
        connectionId: "conn_1",
        outcome: "refused",
        kind: "run",
        includeMetaTools: false,
        includeDryRuns: true,
      },
      limit: 11,
      after: null,
    });
  });

  it("defaults to a page of 50 with meta-tools and dry runs left out", async () => {
    const deps = fakeDeps();
    await listActivity(ctx, PRINCIPAL, {}, deps);
    expect(deps.listActivity).toHaveBeenCalledWith(ctx.db, "person_1", {
      filter: {
        agentId: null,
        vendor: null,
        connectionId: null,
        outcome: null,
        kind: null,
        includeMetaTools: false,
        includeDryRuns: false,
      },
      limit: 51,
      after: null,
    });
  });

  it.each([
    [{ limit: 0 }, "between 1 and 100"],
    [{ limit: 101 }, "between 1 and 100"],
    [{ outcome: "approved" }, "outcome is one of ok, error, refused"],
    [{ kind: "everything" }, "kind is one of run, approval"],
    [{ cursor: "" }, "not one this list wrote"],
    [{ cursor: "not-a-cursor" }, "not one this list wrote"],
  ])("refuses %j", async (input, message) => {
    const deps = fakeDeps();
    await expect(listActivity(ctx, PRINCIPAL, input, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(message),
    });
    expect(deps.listActivity).not.toHaveBeenCalled();
  });
});

describe("the activity cursor", () => {
  it("round-trips a position to the microsecond", () => {
    const position = { at: "2026-10-14 09:00:00.123456", key: "tool_approval:agent_1:tool_1" };
    expect(decodeActivityCursor(encodeActivityCursor(position))).toEqual(position);
  });

  it("refuses a moment that is not Postgres's print of a timestamp", () => {
    const cursor = Buffer.from(JSON.stringify({ t: "2026-10-14T09:00:00Z", k: "run:u" })).toString(
      "base64url",
    );
    expect(() => decodeActivityCursor(cursor)).toThrow("not one this list wrote");
  });
});

describe("getAgentActivityStats", () => {
  it("counts the last seven days under the agent's scope and answers the last run beside them", async () => {
    const lastRun = {
      at: new Date("2026-10-14T08:00:00Z"),
      toolName: "gmail__summarise-unread",
      tool: null,
      outcome: "ok" as const,
    };
    const deps = fakeDeps({
      countAgentActivity: vi.fn(async () => ({ runs: 86, ranWithoutAsking: 84, approved: 2 })),
      findAgentLastRun: vi.fn(async () => lastRun),
    });
    const scope = { personId: "person_1", agentId: "agent_1" };
    const stats = await getAgentActivityStats(ctx, scope, deps);
    const since = new Date("2026-10-07T10:00:00Z");
    expect(stats).toEqual({ runs: 86, ranWithoutAsking: 84, approved: 2, since, lastRun });
    expect(deps.countAgentActivity).toHaveBeenCalledWith(ctx.db, scope, { since });
    expect(deps.findAgentLastRun).toHaveBeenCalledWith(ctx.db, scope);
  });
});
