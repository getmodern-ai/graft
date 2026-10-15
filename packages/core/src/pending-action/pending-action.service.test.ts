import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { PendingActionDeps } from "./pending-action.deps";
import {
  answerPendingAction,
  consumePendingAction,
  createPendingAction,
  DEFAULT_PENDING_ACTION_TTL_MS,
  decodeDoneCursor,
  encodeDoneCursor,
  listDonePendingActions,
} from "./pending-action.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };
const PRINCIPAL = { personId: "person_1" };

const open: PendingActionRow = {
  id: "pa_1",
  agentId: "agent_1",
  kind: "approval",
  payload: { toolId: "tool_1" },
  connectionId: null,
  expiresAt: new Date(NOW.getTime() + 60_000),
  answeredAt: null,
  answer: null,
  consumedAt: null,
  closedReason: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};
const answered = { ...open, answeredAt: NOW, answer: { decision: "allow" } };
const expired = { ...open, expiresAt: new Date(NOW.getTime() - 1) };

const ctx = { db: {} } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<PendingActionDeps> = {}): PendingActionDeps {
  return {
    insertPendingAction: vi.fn(
      async (_db, _scope, input) => ({ ...open, ...input }) as PendingActionRow,
    ),
    findPendingAction: vi.fn(async () => open),
    findPendingActionForPerson: vi.fn(async () => open),
    listOpenPendingActions: vi.fn(async () => [open]),
    listDonePendingActions: vi.fn(async () => []),
    answerPendingAction: vi.fn(async () => answered),
    consumePendingAction: vi.fn(async () => ({ ...answered, consumedAt: NOW })),
    updatePendingActionPayload: vi.fn(async () => null),
    newId: () => "pa_new",
    now: () => NOW,
    ...overrides,
  };
}

describe("createPendingAction", () => {
  it("writes the agent's action with an expiry from the clock and the default window", async () => {
    const deps = fakeDeps();
    await createPendingAction(
      ctx,
      SCOPE,
      { kind: "approval", payload: { toolId: "tool_1" } },
      deps,
    );
    expect(deps.insertPendingAction).toHaveBeenCalledWith(ctx.db, SCOPE, {
      id: "pa_new",
      agentId: "agent_1",
      kind: "approval",
      payload: { toolId: "tool_1" },
      expiresAt: new Date(NOW.getTime() + DEFAULT_PENDING_ACTION_TTL_MS),
      createdAt: NOW,
    });
  });

  it("stamps the connection the ask is about on the column, when it is about one", async () => {
    const deps = fakeDeps();
    await createPendingAction(
      ctx,
      SCOPE,
      { kind: "credential", payload: { connectionId: "conn_1" }, connectionId: "conn_1" },
      deps,
    );
    expect(deps.insertPendingAction).toHaveBeenCalledWith(
      ctx.db,
      SCOPE,
      expect.objectContaining({ kind: "credential", connectionId: "conn_1" }),
    );
  });

  it("refuses a non-positive, absurd or non-finite window, and an empty kind", async () => {
    const deps = fakeDeps();
    for (const input of [
      { kind: "approval", payload: {}, ttlMs: 0 },
      { kind: "approval", payload: {}, ttlMs: -5 },
      { kind: "approval", payload: {}, ttlMs: Number.POSITIVE_INFINITY },
      { kind: "approval", payload: {}, ttlMs: 365 * 24 * 60 * 60 * 1000 },
      { kind: " ", payload: {} },
    ]) {
      await expect(createPendingAction(ctx, SCOPE, input, deps)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(deps.insertPendingAction).not.toHaveBeenCalled();
  });
});

/** Greptile on #225: a call that passed the door before a revoke opens no ask after it. */
describe("createPendingAction for a revoked agent", () => {
  it("refuses when the repo finds no active agent to hold the ask", async () => {
    const deps = fakeDeps({ insertPendingAction: vi.fn(async () => null) });
    await expect(
      createPendingAction(ctx, SCOPE, { kind: "tool", payload: {} }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("answerPendingAction", () => {
  it("records the person's answer through the guarded statement", async () => {
    const deps = fakeDeps();
    const result = await answerPendingAction(ctx, PRINCIPAL, "pa_1", { decision: "allow" }, deps);
    expect(result.answer).toEqual({ decision: "allow" });
    expect(deps.answerPendingAction).toHaveBeenCalledWith(ctx.db, "person_1", "pa_1", {
      answer: { decision: "allow" },
      answeredAt: NOW,
    });
  });

  /** The statement refused; these say why, because the console's next sentence turns on it. */
  it("says GONE for an expired action, CONFLICT for an answered one, NOT_FOUND otherwise", async () => {
    const refused = { answerPendingAction: vi.fn(async () => null) };
    await expect(
      answerPendingAction(
        ctx,
        PRINCIPAL,
        "pa_1",
        {},
        fakeDeps({ ...refused, findPendingActionForPerson: vi.fn(async () => expired) }),
      ),
    ).rejects.toMatchObject({ code: "GONE" });
    await expect(
      answerPendingAction(
        ctx,
        PRINCIPAL,
        "pa_1",
        {},
        fakeDeps({ ...refused, findPendingActionForPerson: vi.fn(async () => answered) }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      answerPendingAction(
        ctx,
        PRINCIPAL,
        "pa_1",
        {},
        fakeDeps({ ...refused, findPendingActionForPerson: vi.fn(async () => null) }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("consumePendingAction", () => {
  it("takes the answer once, under the agent's scope", async () => {
    const deps = fakeDeps();
    const result = await consumePendingAction(ctx, SCOPE, "pa_1", deps);
    expect(result?.consumedAt).toEqual(NOW);
    expect(deps.consumePendingAction).toHaveBeenCalledWith(ctx.db, SCOPE, "pa_1", NOW);
  });

  it("answers null while the action is open and in time", async () => {
    const deps = fakeDeps({ consumePendingAction: vi.fn(async () => null) });
    await expect(consumePendingAction(ctx, SCOPE, "pa_1", deps)).resolves.toBeNull();
  });

  it("says GONE once an open action has expired, CONFLICT once its answer was taken", async () => {
    const refused = { consumePendingAction: vi.fn(async () => null) };
    await expect(
      consumePendingAction(
        ctx,
        SCOPE,
        "pa_1",
        fakeDeps({ ...refused, findPendingAction: vi.fn(async () => expired) }),
      ),
    ).rejects.toMatchObject({ code: "GONE" });
    await expect(
      consumePendingAction(
        ctx,
        SCOPE,
        "pa_1",
        fakeDeps({
          ...refused,
          findPendingAction: vi.fn(async () => ({ ...answered, consumedAt: NOW })),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      consumePendingAction(
        ctx,
        SCOPE,
        "pa_1",
        fakeDeps({ ...refused, findPendingAction: vi.fn(async () => null) }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

/** GRA-292: the Done list's paging. The statement itself is pinned in `@graft/db`'s `scope.test.ts`. */
describe("listDonePendingActions", () => {
  const finished = (id: string, minutesAgo: number): PendingActionRow => ({
    ...open,
    id,
    answeredAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    answer: { allow: true },
  });

  it("reads one row past the page, and answers a cursor naming the page's last row", async () => {
    const rows = [finished("pa_3", 1), finished("pa_2", 2), finished("pa_1", 3)];
    const deps = fakeDeps({ listDonePendingActions: vi.fn(async () => rows) });
    const page = await listDonePendingActions(ctx, PRINCIPAL, { limit: 2 }, deps);
    expect(deps.listDonePendingActions).toHaveBeenCalledWith(ctx.db, "person_1", {
      now: NOW,
      limit: 3,
      after: null,
    });
    expect(page.rows.map((row) => row.id)).toEqual(["pa_3", "pa_2"]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeDoneCursor(page.nextCursor ?? "", NOW)).toEqual({
      finishedAt: new Date(NOW.getTime() - 2 * 60_000),
      id: "pa_2",
    });
  });

  it("hands the cursor back to the statement as the row it names, so the next page starts after it", async () => {
    const deps = fakeDeps();
    const cursor = encodeDoneCursor({ finishedAt: NOW, id: "pa_2" });
    await listDonePendingActions(ctx, PRINCIPAL, { cursor }, deps);
    expect(deps.listDonePendingActions).toHaveBeenCalledWith(ctx.db, "person_1", {
      now: NOW,
      limit: 51,
      after: { finishedAt: NOW, id: "pa_2" },
    });
  });

  it("keys an unanswered ask's cursor on its expiry, the moment a revoke's close stamps", async () => {
    const closed = { ...open, id: "pa_c", expiresAt: new Date(NOW.getTime() - 5_000) };
    const deps = fakeDeps({
      listDonePendingActions: vi.fn(async () => [closed, finished("pa_0", 9)]),
    });
    const page = await listDonePendingActions(ctx, PRINCIPAL, { limit: 1 }, deps);
    expect(decodeDoneCursor(page.nextCursor ?? "", NOW)).toEqual({
      finishedAt: closed.expiresAt,
      id: "pa_c",
    });
  });

  it("answers no cursor on the last page", async () => {
    const deps = fakeDeps({ listDonePendingActions: vi.fn(async () => [finished("pa_1", 1)]) });
    const page = await listDonePendingActions(ctx, PRINCIPAL, { limit: 1 }, deps);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not write and a page size out of bounds", async () => {
    const deps = fakeDeps();
    await expect(
      listDonePendingActions(ctx, PRINCIPAL, { cursor: "not-a-cursor" }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      listDonePendingActions(ctx, PRINCIPAL, { cursor: "" }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const future = encodeDoneCursor({ finishedAt: new Date(NOW.getTime() + 1), id: "pa_1" });
    await expect(
      listDonePendingActions(ctx, PRINCIPAL, { cursor: future }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(listDonePendingActions(ctx, PRINCIPAL, { limit: 0 }, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      listDonePendingActions(ctx, PRINCIPAL, { limit: 101 }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.listDonePendingActions).not.toHaveBeenCalled();
  });
});
