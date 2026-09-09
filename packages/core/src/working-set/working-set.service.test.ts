import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { WorkingSetRow } from "@graft/db/repo/working-set";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { WorkingSetDeps } from "./working-set.deps";
import { demoteTool, promoteTool, touchToolUsed } from "./working-set.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };

const tool = { id: "tool_1", personId: "person_1" } as AuthoredToolRow;
const entry: WorkingSetRow = {
  agentId: "agent_1",
  toolId: "tool_1",
  promotedAt: NOW,
  lastUsedAt: null,
  promotedBy: "agent",
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<WorkingSetDeps> = {}): WorkingSetDeps {
  return {
    listWorkingSet: vi.fn(async () => []),
    findWorkingSetEntry: vi.fn(async () => entry),
    countWorkingSet: vi.fn(async () => 1),
    insertWorkingSetEntry: vi.fn(async () => entry),
    deleteWorkingSetEntry: vi.fn(async () => entry),
    touchWorkingSetUsed: vi.fn(async () => entry),
    insertWorkingSetChange: vi.fn(async (_db, input) => input as never),
    listWorkingSetChanges: vi.fn(async () => []),
    findAuthoredToolById: vi.fn(async () => tool),
    newId: () => "change_1",
    now: () => NOW,
    ...overrides,
  };
}

describe("promoteTool", () => {
  /** ADR 0003: every promotion is recorded with its cause. */
  it("inserts the entry and records the promotion with who did it, in one transaction", async () => {
    const deps = fakeDeps();
    const result = await promoteTool(ctx, SCOPE, "tool_1", "publish", deps);

    expect(result).toEqual({ changed: true, entry });
    expect(deps.insertWorkingSetEntry).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      promotedBy: "publish",
      promotedAt: NOW,
    });
    expect(deps.insertWorkingSetChange).toHaveBeenCalledWith(fakeDb, {
      id: "change_1",
      agentId: "agent_1",
      toolId: "tool_1",
      change: "promote",
      cause: "publish",
      createdAt: NOW,
    });
  });

  it("changes nothing and records nothing for a tool already promoted", async () => {
    const deps = fakeDeps({ insertWorkingSetEntry: vi.fn(async () => null) });
    await expect(promoteTool(ctx, SCOPE, "tool_1", "agent", deps)).resolves.toEqual({
      changed: false,
      entry: null,
    });
    expect(deps.insertWorkingSetChange).not.toHaveBeenCalled();
  });

  /** ADR 0007: the toolbox is the person's; a tool that is not theirs does not exist for them. */
  it("refuses a tool outside the person's toolbox as NOT_FOUND, writing nothing", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(promoteTool(ctx, SCOPE, "tool_x", "agent", deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Tool not found",
    });
    expect(deps.findAuthoredToolById).toHaveBeenCalledWith(fakeDb, "person_1", "tool_x");
    expect(deps.insertWorkingSetEntry).not.toHaveBeenCalled();
  });
});

describe("demoteTool", () => {
  it("deletes the entry under the scope and records the cause", async () => {
    const deps = fakeDeps();
    const result = await demoteTool(ctx, SCOPE, "tool_1", "idle", deps);

    expect(result.changed).toBe(true);
    expect(deps.deleteWorkingSetEntry).toHaveBeenCalledWith(fakeDb, SCOPE, "tool_1");
    expect(deps.insertWorkingSetChange).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ change: "demote", cause: "idle" }),
    );
  });

  it("records nothing when the tool was not promoted", async () => {
    const deps = fakeDeps({ deleteWorkingSetEntry: vi.fn(async () => null) });
    await expect(demoteTool(ctx, SCOPE, "tool_1", "agent", deps)).resolves.toEqual({
      changed: false,
      entry: null,
    });
    expect(deps.insertWorkingSetChange).not.toHaveBeenCalled();
  });
});

describe("touchToolUsed", () => {
  it("stamps the clock's moment under the scope", async () => {
    const deps = fakeDeps();
    await touchToolUsed(ctx, SCOPE, "tool_1", deps);
    expect(deps.touchWorkingSetUsed).toHaveBeenCalledWith(fakeDb, SCOPE, "tool_1", NOW);
  });
});
