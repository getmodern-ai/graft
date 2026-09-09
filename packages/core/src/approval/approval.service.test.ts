import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { ApprovalDeps } from "./approval.deps";
import {
  decideToolCall,
  grantBuildApproval,
  relaxDestructiveApproval,
  setApproval,
} from "./approval.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };

const writeTool = {
  id: "tool_1",
  personId: "person_1",
  readOnly: false,
  destructive: false,
} as AuthoredToolRow;
const destructiveTool = { ...writeTool, destructive: true } as AuthoredToolRow;
const approval: ApprovalRow = {
  agentId: "agent_1",
  toolId: "tool_1",
  decision: "allow",
  decidedAt: NOW,
  perCallRelaxed: false,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};
const build: BuildApprovalRow = {
  agentId: "agent_1",
  connectionId: "conn_1",
  grantedAt: NOW,
  owner: "person",
  createdAt: NOW,
};

const ctx = { db: {} } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<ApprovalDeps> = {}): ApprovalDeps {
  return {
    findApproval: vi.fn(async () => null),
    listApprovals: vi.fn(async () => []),
    upsertApproval: vi.fn(async (_db, input) => ({ ...approval, ...input }) as ApprovalRow),
    relaxApproval: vi.fn(async () => ({ ...approval, perCallRelaxed: true })),
    deleteApproval: vi.fn(async () => approval),
    findBuildApproval: vi.fn(async () => null),
    insertBuildApproval: vi.fn(async () => build),
    findAuthoredToolById: vi.fn(async () => writeTool),
    findConnection: vi.fn(async () => ({ id: "conn_1" }) as never),
    now: () => NOW,
    ...overrides,
  };
}

describe("setApproval", () => {
  it("records the person's answer for the agent's tool at the clock's moment", async () => {
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps);
    expect(deps.upsertApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
    });
  });

  it("refuses a tool that is not the person's", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(setApproval(ctx, SCOPE, "tool_x", "allow", deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.upsertApproval).not.toHaveBeenCalled();
  });
});

describe("relaxDestructiveApproval", () => {
  it("relaxes a destructive tool's standing approval", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => destructiveTool) });
    const result = await relaxDestructiveApproval(ctx, SCOPE, "tool_1", deps);
    expect(result.perCallRelaxed).toBe(true);
    expect(deps.relaxApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1");
  });

  it("refuses a tool that is not destructive — there is nothing to relax", async () => {
    const deps = fakeDeps();
    await expect(relaxDestructiveApproval(ctx, SCOPE, "tool_1", deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(deps.relaxApproval).not.toHaveBeenCalled();
  });

  it("refuses when no approval stands yet", async () => {
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(async () => destructiveTool),
      relaxApproval: vi.fn(async () => null),
    });
    await expect(relaxDestructiveApproval(ctx, SCOPE, "tool_1", deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("decideToolCall", () => {
  it("applies ADR 0008 to the tool's annotations and the agent's approval", async () => {
    await expect(decideToolCall(ctx, SCOPE, "tool_1", fakeDeps())).resolves.toBe("ask");
    await expect(
      decideToolCall(ctx, SCOPE, "tool_1", fakeDeps({ findApproval: vi.fn(async () => approval) })),
    ).resolves.toBe("pass");
    await expect(
      decideToolCall(
        ctx,
        SCOPE,
        "tool_1",
        fakeDeps({
          findAuthoredToolById: vi.fn(async () => destructiveTool),
          findApproval: vi.fn(async () => approval),
        }),
      ),
    ).resolves.toBe("ask");
  });

  it("reads the approval under the agent's scope", async () => {
    const deps = fakeDeps();
    await decideToolCall(ctx, SCOPE, "tool_1", deps);
    expect(deps.findApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1");
  });
});

describe("grantBuildApproval", () => {
  it("grants once and answers the standing row on a repeat", async () => {
    const first = fakeDeps();
    await expect(grantBuildApproval(ctx, SCOPE, "conn_1", first)).resolves.toEqual(build);
    expect(first.insertBuildApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      connectionId: "conn_1",
      grantedAt: NOW,
    });

    const repeat = fakeDeps({
      insertBuildApproval: vi.fn(async () => null),
      findBuildApproval: vi.fn(async () => build),
    });
    await expect(grantBuildApproval(ctx, SCOPE, "conn_1", repeat)).resolves.toEqual(build);
  });

  it("refuses a connection that is not the person's", async () => {
    const deps = fakeDeps({ findConnection: vi.fn(async () => null) });
    await expect(grantBuildApproval(ctx, SCOPE, "conn_x", deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.insertBuildApproval).not.toHaveBeenCalled();
  });
});
