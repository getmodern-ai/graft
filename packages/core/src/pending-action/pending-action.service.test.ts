import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { PendingActionDeps } from "./pending-action.deps";
import {
  answerPendingAction,
  consumePendingAction,
  createPendingAction,
  DEFAULT_PENDING_ACTION_TTL_MS,
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
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};
const answered = { ...open, answeredAt: NOW, answer: { decision: "allow" } };
const expired = { ...open, expiresAt: new Date(NOW.getTime() - 1) };

const ctx = { db: {} } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<PendingActionDeps> = {}): PendingActionDeps {
  return {
    insertPendingAction: vi.fn(async (_db, input) => ({ ...open, ...input }) as PendingActionRow),
    findPendingAction: vi.fn(async () => open),
    findPendingActionForPerson: vi.fn(async () => open),
    listOpenPendingActions: vi.fn(async () => [open]),
    answerPendingAction: vi.fn(async () => answered),
    consumePendingAction: vi.fn(async () => ({ ...answered, consumedAt: NOW })),
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
    expect(deps.insertPendingAction).toHaveBeenCalledWith(ctx.db, {
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
