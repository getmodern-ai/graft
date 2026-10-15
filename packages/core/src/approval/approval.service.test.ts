import type { AgentRow } from "@graft/db/repo/agent";
import type { ApprovalRow, BuildApprovalRow, VendorApprovalRow } from "@graft/db/repo/approval";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { ApprovalDeps } from "./approval.deps";
import {
  allowVendor,
  allowVendorWhenConnecting,
  decideToolCall,
  grantBuildApproval,
  listBuildApprovals,
  revokeApproval,
  setApproval,
  setApprovalFromConsole,
  setAskEveryCall,
  setVendorApprovalDestructive,
  withdrawBuildApproval,
  withdrawVendorApproval,
} from "./approval.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };

const writeTool = {
  id: "tool_1",
  personId: "person_1",
  readOnly: false,
  destructive: false,
  currentVersionId: "ver_1",
} as AuthoredToolRow;
const destructiveTool = { ...writeTool, destructive: true } as AuthoredToolRow;
const readTool = { ...writeTool, readOnly: true } as AuthoredToolRow;
const approval: ApprovalRow = {
  agentId: "agent_1",
  toolId: "tool_1",
  decision: "allow",
  decidedAt: NOW,
  askEveryCall: false,
  toolVersionId: "ver_1",
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

const agentRow = {
  id: "agent_1",
  personId: "person_1",
  name: "Hermes",
  revokedAt: null,
} as AgentRow;

const liveConnection = { id: "conn_1", revokedAt: null } as ConnectionRow;

/** An open tool ask as `listOpenToolActions` answers it, naming a version and a connection. */
function openAsk(id: string, toolVersionId: string, connectionId = "conn_1"): PendingActionRow {
  return { id, kind: "tool", connectionId, payload: { toolId: "tool_1", toolVersionId } } as never;
}

const hubspotWrite = { ...writeTool, vendor: "hubspot" } as AuthoredToolRow;
const hubspotDestructive = { ...hubspotWrite, destructive: true } as AuthoredToolRow;
const vendorApproval: VendorApprovalRow = {
  agentId: "agent_1",
  vendor: "hubspot",
  includesDestructive: false,
  grantedAt: NOW,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

/** A transaction hands its body the same handle, so a call made inside it is asserted on `ctx.db`. */
const db = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db) };
const ctx = { db } as unknown as ServiceContext;

/** An answer given on a chat's ask card, for its approval event (GRA-341). */
const CARD = { via: "card", pendingActionId: "pa_1" } as const;

/** The asked-about version as the ask showed it: `ver_1`, a write. */
const ASKED_V1 = { versionId: "ver_1", annotations: { readOnly: false, destructive: false } };

/** A version as `listToolVersionOrigins` answers it; `stock` marks a stock origin. */
function origin(versionId: string, versionNumber: number, stock: boolean) {
  return {
    toolId: "tool_1",
    versionId,
    versionNumber,
    createdAt: NOW,
    stockToolId: stock ? "stock_1" : null,
    stockVersionId: stock ? `stock_${versionId}` : null,
    stockVersionNumber: stock ? versionNumber : null,
  };
}

function fakeDeps(overrides: Partial<ApprovalDeps> = {}): ApprovalDeps {
  return {
    findApproval: vi.fn(async () => null),
    listApprovals: vi.fn(async () => []),
    upsertApproval: vi.fn(async (_db, input) => ({ ...approval, ...input }) as ApprovalRow),
    updateAskEveryCall: vi.fn(async (_db, _scope, _toolId, on) => ({
      ...approval,
      askEveryCall: on,
    })),
    deleteApproval: vi.fn(async () => approval),
    findBuildApproval: vi.fn(async () => null),
    insertBuildApproval: vi.fn(async () => build),
    listBuildApprovals: vi.fn(async () => []),
    deleteBuildApproval: vi.fn(async () => null),
    findVendorApproval: vi.fn(async () => null),
    listVendorApprovals: vi.fn(async () => []),
    upsertVendorApproval: vi.fn(async (_db, _scope, input) => ({ ...vendorApproval, ...input })),
    deleteVendorApproval: vi.fn(async () => null),
    updateVendorApprovalDestructive: vi.fn(async () => null),
    settleAnsweredToolActions: vi.fn(async () => []),
    answerOpenToolActions: vi.fn(async (_db, _scope, args) =>
      args.ids.map((id: string) => ({ id }) as never),
    ),
    listOpenToolActions: vi.fn(async () => []),
    findVendorConnectionsForUpdate: vi.fn(async () => [liveConnection]),
    findAgent: vi.fn(async () => agentRow),
    findAuthoredToolById: vi.fn(async () => writeTool),
    findAuthoredToolForUpdate: vi.fn(async () => writeTool),
    listToolVersionOrigins: vi.fn(async () => []),
    findConnection: vi.fn(async () => ({ id: "conn_1", vendor: "hubspot" }) as never),
    findConnectionForNoKeyUpdate: vi.fn(async () => ({ id: "conn_1", vendor: "hubspot" }) as never),
    insertApprovalEvent: vi.fn(async (_db, input) => ({ id: "event_1", ...input }) as never),
    now: () => NOW,
    ...overrides,
  };
}

describe("setApproval", () => {
  it("records the person's answer for the agent's tool at the clock's moment, leaving the setting as it stands", async () => {
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
      toolVersionId: "ver_1",
    });
    // The answer path never spends a waiting answer — that is the console's act.
    expect(deps.settleAnsweredToolActions).not.toHaveBeenCalled();
  });

  it("writes the setting with the answer when the answer carried one", async () => {
    const deps = fakeDeps();
    const row = await setApproval(ctx, SCOPE, "tool_1", "allow", deps, {
      event: CARD,
      asked: ASKED_V1,
      askEveryCall: true,
    });
    expect(deps.upsertApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
      toolVersionId: "ver_1",
      askEveryCall: true,
    });
    expect(row.askEveryCall).toBe(true);
  });

  it("refuses a tool that is not the person's", async () => {
    const deps = fakeDeps({ findAuthoredToolForUpdate: vi.fn(async () => null) });
    await expect(
      setApproval(ctx, SCOPE, "tool_x", "allow", deps, { asked: ASKED_V1, event: CARD }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.upsertApproval).not.toHaveBeenCalled();
  });

  it("reads the tool under its row lock, the one a stock advance takes (Greptile on #190)", async () => {
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.findAuthoredToolForUpdate).toHaveBeenCalledWith(ctx.db, "person_1", "tool_1");
    expect(deps.findAuthoredToolById).not.toHaveBeenCalled();
  });
});

/** GRA-245, Greptile on #190: an answer is for the version the person was shown. */
describe("setApproval for the version asked about", () => {
  const movedOn = { ...writeTool, currentVersionId: "ver_2" } as AuthoredToolRow;

  it("records an old ask's yes for the old version, so the version made current since still asks", async () => {
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      listToolVersionOrigins: vi.fn(async () => [
        origin("ver_2", 2, false),
        origin("ver_1", 1, false),
      ]),
    });
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: "ver_1" }),
    );
  });

  it("records a no for the version asked about", async () => {
    const deps = fakeDeps({ findAuthoredToolForUpdate: vi.fn(async () => movedOn) });
    await setApproval(ctx, SCOPE, "tool_1", "deny", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ decision: "deny", toolVersionId: "ver_1" }),
    );
  });

  it("leaves a yes already standing for the current version where it is", async () => {
    const current = { ...approval, toolVersionId: "ver_2" };
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      findApproval: vi.fn(async () => current),
    });
    await expect(
      setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD }),
    ).resolves.toEqual(current);
    expect(deps.upsertApproval).not.toHaveBeenCalled();
  });

  it("still writes an ask-every-call setting the old ask's yes carried onto that standing row", async () => {
    const current = { ...approval, toolVersionId: "ver_2" };
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      findApproval: vi.fn(async () => current),
    });
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, {
      event: CARD,
      asked: ASKED_V1,
      askEveryCall: true,
    });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ decision: "allow", toolVersionId: "ver_2", askEveryCall: true }),
    );
  });

  it("carries a late yes onto a stock copy's current version when the advances do not widen what was shown", async () => {
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      listToolVersionOrigins: vi.fn(async () => [
        origin("ver_2", 2, true),
        origin("ver_1", 1, true),
      ]),
    });
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: "ver_2" }),
    );
  });

  it("carries nothing onto a stock version that widens what was shown", async () => {
    const widened = { ...movedOn, destructive: true } as AuthoredToolRow;
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => widened),
      listToolVersionOrigins: vi.fn(async () => [
        origin("ver_2", 2, true),
        origin("ver_1", 1, true),
      ]),
    });
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: "ver_1" }),
    );
  });

  it("carries nothing onto a remix's version: a remix is a republish", async () => {
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      listToolVersionOrigins: vi.fn(async () => [
        origin("ver_2", 2, false),
        origin("ver_1", 1, true),
      ]),
    });
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: "ver_1" }),
    );
  });

  it("records an ask that named no version for none, so the tool asks once more", async () => {
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, {
      event: CARD,
      asked: { ...ASKED_V1, versionId: null },
    });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: null }),
    );
  });
});

describe("setAskEveryCall", () => {
  it("turns the setting on for a destructive tool, and off again, spending any answer left waiting each time", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => destructiveTool) });
    const on = await setAskEveryCall(ctx, SCOPE, "tool_1", true, deps);
    expect(on.askEveryCall).toBe(true);
    expect(deps.updateAskEveryCall).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1", true);
    expect(deps.settleAnsweredToolActions).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1", NOW);

    const off = await setAskEveryCall(ctx, SCOPE, "tool_1", false, deps);
    expect(off.askEveryCall).toBe(false);
    expect(deps.updateAskEveryCall).toHaveBeenLastCalledWith(ctx.db, SCOPE, "tool_1", false);
    expect(deps.settleAnsweredToolActions).toHaveBeenCalledTimes(2);
  });

  it("takes a write tool too — the setting is per tool, not per annotation", async () => {
    const deps = fakeDeps();
    const on = await setAskEveryCall(ctx, SCOPE, "tool_1", true, deps);
    expect(on.askEveryCall).toBe(true);
  });

  it("refuses a read-only tool — it never asks, so there is nothing to set", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => readTool) });
    await expect(setAskEveryCall(ctx, SCOPE, "tool_1", true, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(deps.updateAskEveryCall).not.toHaveBeenCalled();
    expect(deps.settleAnsweredToolActions).not.toHaveBeenCalled();
  });

  it("refuses when no approval stands yet, and spends nothing", async () => {
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(async () => destructiveTool),
      updateAskEveryCall: vi.fn(async () => null),
    });
    await expect(setAskEveryCall(ctx, SCOPE, "tool_1", true, deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.settleAnsweredToolActions).not.toHaveBeenCalled();
  });

  it("refuses a tool that is not the person's", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(setAskEveryCall(ctx, SCOPE, "tool_x", true, deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.updateAskEveryCall).not.toHaveBeenCalled();
  });
});

describe("revokeApproval", () => {
  it("removes the row and spends any answer left waiting for the agent, so nothing re-creates it", async () => {
    const deps = fakeDeps();
    await expect(revokeApproval(ctx, SCOPE, "tool_1", deps)).resolves.toEqual(approval);
    expect(deps.deleteApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1");
    expect(deps.settleAnsweredToolActions).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1", NOW);
  });

  it("answers null when nothing stood, and still spends what was waiting", async () => {
    const deps = fakeDeps({ deleteApproval: vi.fn(async () => null) });
    await expect(revokeApproval(ctx, SCOPE, "tool_1", deps)).resolves.toBeNull();
    expect(deps.settleAnsweredToolActions).toHaveBeenCalledTimes(1);
  });

  it("refuses a tool that is not the person's", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(revokeApproval(ctx, SCOPE, "tool_x", deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.deleteApproval).not.toHaveBeenCalled();
  });
});

/** ADR 0008 as amended 2026-10-14 (GRA-302): the console sets an answer outright. */
describe("setApprovalFromConsole", () => {
  it("records the answer for the tool's current version under the tool row's lock, the setting left as it stands", async () => {
    const deps = fakeDeps();
    const result = await setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps);
    expect(deps.findAgent).toHaveBeenCalledWith(ctx.db, "person_1", "agent_1");
    expect(deps.findAuthoredToolForUpdate).toHaveBeenCalledWith(ctx.db, "person_1", "tool_1");
    expect(deps.upsertApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
      toolVersionId: "ver_1",
    });
    expect(result.approval).toMatchObject({ decision: "allow", toolVersionId: "ver_1" });
  });

  it("creates an answer where none stood, and replaces an allow with a deny", async () => {
    const deps = fakeDeps({ findApproval: vi.fn(async () => approval) });
    const result = await setApprovalFromConsole(ctx, SCOPE, "tool_1", "deny", deps);
    expect(result.approval).toMatchObject({ decision: "deny", toolVersionId: "ver_1" });
    const fresh = fakeDeps();
    await setApprovalFromConsole(ctx, SCOPE, "tool_1", "deny", fresh);
    expect(fresh.upsertApproval).toHaveBeenCalledTimes(1);
  });

  it("is for the version the tool runs now, never one an older answer named", async () => {
    const movedOn = { ...writeTool, currentVersionId: "ver_2" } as AuthoredToolRow;
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => movedOn),
      findApproval: vi.fn(async () => ({ ...approval, toolVersionId: "ver_1" })),
    });
    await setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps);
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ toolVersionId: "ver_2" }),
    );
  });

  it("answers the open asks for the current version on an allow, taken at once, and spends a waiting yes", async () => {
    const deps = fakeDeps({
      listOpenToolActions: vi.fn(async () => [
        openAsk("pa_1", "ver_1"),
        openAsk("pa_2", "ver_1"),
        openAsk("pa_old", "ver_0"),
      ]),
    });
    const result = await setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps);
    // An allow holds for the version it was set for, so an ask about an older one stays open.
    expect(deps.answerOpenToolActions).toHaveBeenCalledWith(ctx.db, SCOPE, {
      ids: ["pa_1", "pa_2"],
      answer: { allow: true, via: "setting" },
      at: NOW,
    });
    expect(deps.settleAnsweredToolActions).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1", NOW);
    expect(result.answeredPendingActionIds).toEqual(["pa_1", "pa_2"]);
  });

  it("answers every version's open asks on a deny, since a deny holds across versions", async () => {
    const deps = fakeDeps({
      listOpenToolActions: vi.fn(async () => [
        openAsk("pa_1", "ver_1"),
        openAsk("pa_old", "ver_0"),
      ]),
    });
    await setApprovalFromConsole(ctx, SCOPE, "tool_1", "deny", deps);
    expect(deps.answerOpenToolActions).toHaveBeenCalledWith(ctx.db, SCOPE, {
      ids: ["pa_1", "pa_old"],
      answer: { allow: false, via: "setting" },
      at: NOW,
    });
  });

  /**
   * A revoke locks its connection and then sweeps every answer of the vendor's tools; answering an
   * ask locks the ask's connection, then the action, then the tool row (`recordApprovalAnswer`).
   * This path takes the same rows in the same order, so it serialises with both and deadlocks with
   * neither: an allow written here never outlives a revoke's sweep.
   */
  it("locks the vendor's connections and those the open asks name, then the asks, then the tool row", async () => {
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(
        async () =>
          ({ ...writeTool, vendor: "hubspot", defaultConnectionId: "conn_1" }) as AuthoredToolRow,
      ),
      listOpenToolActions: vi.fn(async () => [openAsk("pa_1", "ver_1", "conn_other")]),
    });
    await setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps);
    expect(deps.findVendorConnectionsForUpdate).toHaveBeenCalledWith(
      ctx.db,
      "person_1",
      "hubspot",
      ["conn_1", "conn_other"],
    );
    expect(deps.listOpenToolActions).toHaveBeenNthCalledWith(1, ctx.db, SCOPE, "tool_1", NOW);
    expect(deps.listOpenToolActions).toHaveBeenNthCalledWith(2, ctx.db, SCOPE, "tool_1", NOW, {
      forUpdate: true,
    });
    const order = (fn: { mock: { invocationCallOrder: number[] } }, at = 0) =>
      fn.mock.invocationCallOrder[at] ?? Number.NaN;
    const connections = order(vi.mocked(deps.findVendorConnectionsForUpdate));
    const asks = order(vi.mocked(deps.listOpenToolActions), 1);
    const tool = order(vi.mocked(deps.findAuthoredToolForUpdate));
    expect(order(vi.mocked(deps.listOpenToolActions), 0)).toBeLessThan(connections);
    expect(connections).toBeLessThan(asks);
    expect(asks).toBeLessThan(tool);
    expect(tool).toBeLessThan(order(vi.mocked(deps.upsertApproval)));
    expect(order(vi.mocked(deps.upsertApproval))).toBeLessThan(
      order(vi.mocked(deps.answerOpenToolActions)),
    );
  });

  it("refuses when every connection a revoke would have swept is revoked, and writes nothing", async () => {
    const deps = fakeDeps({
      findVendorConnectionsForUpdate: vi.fn(async () => [{ ...liveConnection, revokedAt: NOW }]),
    });
    await expect(setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps)).rejects.toMatchObject(
      { code: "CONFLICT", details: { reason: "connection_revoked" } },
    );
    expect(deps.findAuthoredToolForUpdate).not.toHaveBeenCalled();
    expect(deps.upsertApproval).not.toHaveBeenCalled();
    expect(deps.answerOpenToolActions).not.toHaveBeenCalled();
  });

  it("leaves the open asks open on an allow while the tool asks every call", async () => {
    const deps = fakeDeps({
      upsertApproval: vi.fn(
        async (_db, input) => ({ ...approval, ...input, askEveryCall: true }) as ApprovalRow,
      ),
    });
    const result = await setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps);
    expect(deps.answerOpenToolActions).not.toHaveBeenCalled();
    expect(result.answeredPendingActionIds).toEqual([]);
  });

  it("refuses a read-only tool, which never asks, and writes nothing", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => readTool) });
    await expect(setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", deps)).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
    expect(deps.upsertApproval).not.toHaveBeenCalled();
    expect(deps.answerOpenToolActions).not.toHaveBeenCalled();
  });

  it("refuses another person's agent or tool, a revoked agent, and a tool with no version", async () => {
    const noAgent = fakeDeps({ findAgent: vi.fn(async () => null) });
    await expect(
      setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", noAgent),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const noTool = fakeDeps({ findAuthoredToolById: vi.fn(async () => null) });
    await expect(
      setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", noTool),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const revoked = fakeDeps({
      findAgent: vi.fn(async () => ({ ...agentRow, revokedAt: NOW })),
    });
    await expect(
      setApprovalFromConsole(ctx, SCOPE, "tool_1", "deny", revoked),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "agent_revoked" } });
    const unversioned = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(
        async () => ({ ...writeTool, currentVersionId: null }) as AuthoredToolRow,
      ),
    });
    await expect(
      setApprovalFromConsole(ctx, SCOPE, "tool_1", "allow", unversioned),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "tool_has_no_version" } });
    for (const deps of [noAgent, noTool, revoked, unversioned]) {
      expect(deps.upsertApproval).not.toHaveBeenCalled();
    }
  });
});

/** A call that runs `ver_1` of a write tool. */
const RUN_V1 = {
  toolId: "tool_1",
  versionId: "ver_1",
  annotations: { readOnly: false, destructive: false },
};

describe("decideToolCall", () => {
  it("applies ADR 0008 to the tool's annotations and the agent's approval", async () => {
    await expect(decideToolCall(ctx, SCOPE, RUN_V1, fakeDeps())).resolves.toBe("ask");
    await expect(
      decideToolCall(ctx, SCOPE, RUN_V1, fakeDeps({ findApproval: vi.fn(async () => approval) })),
    ).resolves.toBe("pass");
    // A destructive tool's allow holds like a write's (the amendment of 2026-09-15).
    await expect(
      decideToolCall(
        ctx,
        SCOPE,
        { ...RUN_V1, annotations: { readOnly: false, destructive: true } },
        fakeDeps({
          findApproval: vi.fn(async () => approval),
        }),
      ),
    ).resolves.toBe("pass");
    // Until the person sets it to ask every call.
    await expect(
      decideToolCall(
        ctx,
        SCOPE,
        { ...RUN_V1, annotations: { readOnly: false, destructive: true } },
        fakeDeps({
          findApproval: vi.fn(async () => ({ ...approval, askEveryCall: true })),
        }),
      ),
    ).resolves.toBe("ask");
  });

  it("asks again for a version the allow was not given for (GRA-245)", async () => {
    const deps = fakeDeps({ findApproval: vi.fn(async () => approval) });
    await expect(decideToolCall(ctx, SCOPE, { ...RUN_V1, versionId: "ver_2" }, deps)).resolves.toBe(
      "ask",
    );
    await expect(decideToolCall(ctx, SCOPE, RUN_V1, deps)).resolves.toBe("pass");
  });

  it("judges the version the call runs, not the tool's pointer (Greptile on #190)", async () => {
    // v2 is current and approved; a call that pinned v1 before it became current still asks.
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(
        async () => ({ ...writeTool, currentVersionId: "ver_2" }) as AuthoredToolRow,
      ),
      findApproval: vi.fn(async () => ({ ...approval, toolVersionId: "ver_2" })),
    });
    await expect(decideToolCall(ctx, SCOPE, RUN_V1, deps)).resolves.toBe("ask");
    await expect(decideToolCall(ctx, SCOPE, { ...RUN_V1, versionId: "ver_2" }, deps)).resolves.toBe(
      "pass",
    );
  });

  it("reads the approval under the agent's scope", async () => {
    const deps = fakeDeps();
    await decideToolCall(ctx, SCOPE, RUN_V1, deps);
    expect(deps.findApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1");
  });
});

describe("grantBuildApproval", () => {
  it("grants once and answers the standing row on a repeat", async () => {
    const first = fakeDeps();
    await expect(grantBuildApproval(ctx, SCOPE, "conn_1", first, CARD)).resolves.toEqual(build);
    expect(first.insertBuildApproval).toHaveBeenCalledWith(ctx.db, {
      agentId: "agent_1",
      connectionId: "conn_1",
      grantedAt: NOW,
    });

    const repeat = fakeDeps({
      insertBuildApproval: vi.fn(async () => null),
      findBuildApproval: vi.fn(async () => build),
    });
    await expect(grantBuildApproval(ctx, SCOPE, "conn_1", repeat, CARD)).resolves.toEqual(build);
  });

  it("refuses a connection that is not the person's", async () => {
    const deps = fakeDeps({ findConnection: vi.fn(async () => null) });
    await expect(grantBuildApproval(ctx, SCOPE, "conn_x", deps, CARD)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.insertBuildApproval).not.toHaveBeenCalled();
  });
});

/** ADR 0008 as amended 2026-10-09 (GRA-237): every tool of an integration, allowed at once. */
describe("decideToolCall under an integration's standing approval", () => {
  const WRITE = { readOnly: false, destructive: false };
  const target = (annotations = WRITE) => ({ toolId: "tool_1", versionId: "ver_1", annotations });

  it("passes a write of the vendor the agent holds an approval for, and reads it under the scope", async () => {
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(async () => hubspotWrite),
      findVendorApproval: vi.fn(async () => vendorApproval),
    });
    await expect(decideToolCall(ctx, SCOPE, target(), deps)).resolves.toBe("pass");
    expect(deps.findVendorApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "hubspot");
  });

  it("asks for a destructive tool of that vendor unless destructive tools were included", async () => {
    const destructive = target({ readOnly: false, destructive: true });
    await expect(
      decideToolCall(
        ctx,
        SCOPE,
        destructive,
        fakeDeps({
          findAuthoredToolById: vi.fn(async () => hubspotDestructive),
          findVendorApproval: vi.fn(async () => vendorApproval),
        }),
      ),
    ).resolves.toBe("ask");
    await expect(
      decideToolCall(
        ctx,
        SCOPE,
        destructive,
        fakeDeps({
          findAuthoredToolById: vi.fn(async () => hubspotDestructive),
          findVendorApproval: vi.fn(async () => ({ ...vendorApproval, includesDestructive: true })),
        }),
      ),
    ).resolves.toBe("pass");
  });

  it("passes under it a tool whose own allow stands for another version (GRA-245)", async () => {
    const deps = fakeDeps({
      findAuthoredToolById: vi.fn(async () => hubspotWrite),
      findApproval: vi.fn(async () => ({ ...approval, toolVersionId: "ver_0" })),
      findVendorApproval: vi.fn(async () => vendorApproval),
    });
    await expect(decideToolCall(ctx, SCOPE, target(), deps)).resolves.toBe("pass");
  });

  it("never reads it for a read, which passes anyway", async () => {
    const deps = fakeDeps({ findAuthoredToolById: vi.fn(async () => readTool) });
    await expect(
      decideToolCall(ctx, SCOPE, target({ readOnly: true, destructive: false }), deps),
    ).resolves.toBe("pass");
    expect(deps.findVendorApproval).not.toHaveBeenCalled();
  });
});

describe("allowVendorWhenConnecting", () => {
  it("never writes over an approval a tool's ask recorded between its read and its insert (Greptile on #182)", async () => {
    const answeredMeanwhile = { ...vendorApproval, includesDestructive: true };
    const deps = fakeDeps({
      // Nothing stands when the confirmation looks; the tool's ask lands before it inserts.
      findVendorApproval: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(answeredMeanwhile),
      upsertVendorApproval: vi.fn(async () => null),
    });
    await expect(allowVendorWhenConnecting(ctx, SCOPE, "hubspot", deps, CARD)).resolves.toEqual(
      answeredMeanwhile,
    );
    expect(deps.upsertVendorApproval).toHaveBeenCalledWith(
      ctx.db,
      SCOPE,
      { vendor: "hubspot", includesDestructive: false, grantedAt: NOW },
      { keep: true },
    );
  });
});

describe("allowVendor", () => {
  it("records the agent's standing approval for the vendor at the clock's moment", async () => {
    const deps = fakeDeps();
    await expect(
      allowVendor(ctx, SCOPE, "hubspot", { includesDestructive: false, event: CARD }, deps),
    ).resolves.toEqual(vendorApproval);
    expect(deps.upsertVendorApproval).toHaveBeenCalledWith(ctx.db, SCOPE, {
      vendor: "hubspot",
      includesDestructive: false,
      grantedAt: NOW,
    });
  });

  it("refuses an agent that is not the person's, which the write's own predicate found", async () => {
    const deps = fakeDeps({ upsertVendorApproval: vi.fn(async () => null) });
    await expect(
      allowVendor(ctx, SCOPE, "hubspot", { includesDestructive: true, event: CARD }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("withdrawVendorApproval", () => {
  it("deletes the agent's row for the vendor", async () => {
    const deps = fakeDeps({ deleteVendorApproval: vi.fn(async () => vendorApproval) });
    await expect(withdrawVendorApproval(ctx, SCOPE, "hubspot", deps)).resolves.toEqual(
      vendorApproval,
    );
    expect(deps.deleteVendorApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "hubspot");
  });
});

describe("build approvals on the agent's page", () => {
  it("lists the agent's rows through the scoped read", async () => {
    const listing = { ...build, vendor: "hubspot", displayName: "HubSpot" };
    const deps = fakeDeps({ listBuildApprovals: vi.fn(async () => [listing]) });
    await expect(listBuildApprovals(ctx, SCOPE, deps)).resolves.toEqual([listing]);
    expect(deps.listBuildApprovals).toHaveBeenCalledWith(ctx.db, SCOPE);
  });

  it("withdraws the agent's row for the connection, and answers null when none stood", async () => {
    const deps = fakeDeps({ deleteBuildApproval: vi.fn(async () => build) });
    await expect(withdrawBuildApproval(ctx, SCOPE, "conn_1", deps)).resolves.toEqual(build);
    expect(deps.deleteBuildApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "conn_1");
    await expect(withdrawBuildApproval(ctx, SCOPE, "conn_1", fakeDeps())).resolves.toBeNull();
  });
});

describe("setVendorApprovalDestructive", () => {
  it("widens or narrows the row that stands, read under its lock, at the clock's moment, and answers null when none does", async () => {
    const deps = fakeDeps({
      findVendorApproval: vi.fn(async () => vendorApproval),
      updateVendorApprovalDestructive: vi.fn(async (_db, _scope, _vendor, input) => ({
        ...vendorApproval,
        ...input,
      })),
    });
    await expect(
      setVendorApprovalDestructive(ctx, SCOPE, "hubspot", true, deps),
    ).resolves.toMatchObject({ vendor: "hubspot", includesDestructive: true });
    expect(deps.findVendorApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "hubspot", {
      forUpdate: true,
    });
    expect(deps.updateVendorApprovalDestructive).toHaveBeenCalledWith(ctx.db, SCOPE, "hubspot", {
      includesDestructive: true,
      grantedAt: NOW,
    });
    await expect(
      setVendorApprovalDestructive(ctx, SCOPE, "hubspot", false, fakeDeps()),
    ).resolves.toBeNull();
  });

  /** Greptile on #276: a repeat that moved the moment showed the approval as a second answer. */
  it("leaves a row already as asked untouched, its moment kept and nothing recorded", async () => {
    const deps = fakeDeps({ findVendorApproval: vi.fn(async () => vendorApproval) });
    await expect(setVendorApprovalDestructive(ctx, SCOPE, "hubspot", false, deps)).resolves.toBe(
      vendorApproval,
    );
    expect(deps.updateVendorApprovalDestructive).not.toHaveBeenCalled();
    expect(deps.insertApprovalEvent).not.toHaveBeenCalled();
  });
});

/**
 * GRA-341: every answer, withdraw and change appends an approval event in its own transaction, so
 * the console's Activity keeps a withdrawn answer and shows the withdraw beside it.
 */
describe("approval events", () => {
  const events = (deps: ApprovalDeps) =>
    vi.mocked(deps.insertApprovalEvent).mock.calls.map(([, input]) => input);

  it("records an answer with its door and its ask, then a withdraw beside it", async () => {
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, { asked: ASKED_V1, event: CARD });
    await revokeApproval(ctx, SCOPE, "tool_1", deps);
    expect(events(deps)).toEqual([
      {
        personId: "person_1",
        agentId: "agent_1",
        kind: "tool",
        action: "allowed",
        via: "card",
        toolId: "tool_1",
        vendor: writeTool.vendor,
        pendingActionId: "pa_1",
        at: NOW,
      },
      {
        personId: "person_1",
        agentId: "agent_1",
        kind: "tool",
        action: "withdrew",
        via: "console",
        toolId: "tool_1",
        vendor: writeTool.vendor,
        at: NOW,
      },
    ]);
  });

  it("records nothing for an answer the agent took off an ask, or a withdraw of nothing", async () => {
    const deps = fakeDeps({ deleteApproval: vi.fn(async () => null) });
    await setApproval(ctx, SCOPE, "tool_1", "deny", deps, { asked: ASKED_V1, event: null });
    await revokeApproval(ctx, SCOPE, "tool_1", deps);
    expect(deps.insertApprovalEvent).not.toHaveBeenCalled();
  });

  it("records the ask-every-call switch only when it moves, judged on the row read under its lock", async () => {
    const deps = fakeDeps({ findApproval: vi.fn(async () => approval) });
    await setAskEveryCall(ctx, SCOPE, "tool_1", true, deps);
    await setAskEveryCall(ctx, SCOPE, "tool_1", false, deps);
    expect(events(deps).map((event) => event.action)).toEqual(["ask_every_call_on"]);
    expect(deps.findApproval).toHaveBeenCalledWith(ctx.db, SCOPE, "tool_1", { forUpdate: true });
  });

  /** Greptile on #276: the tool row's lock first, the order an answer takes, so neither deadlocks. */
  it("takes the tool row's lock before the approval's for the switch and the withdraw", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      findAuthoredToolForUpdate: vi.fn(async () => {
        order.push("tool");
        return writeTool;
      }),
      findApproval: vi.fn(async () => {
        order.push("approval");
        return approval;
      }),
      deleteApproval: vi.fn(async () => {
        order.push("delete");
        return approval;
      }),
    });
    await setAskEveryCall(ctx, SCOPE, "tool_1", true, deps);
    await revokeApproval(ctx, SCOPE, "tool_1", deps);
    expect(order).toEqual(["tool", "approval", "tool", "delete"]);
  });

  it("locks the connection before a build approval's withdraw, as a revoke does", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      findConnectionForNoKeyUpdate: vi.fn(async () => {
        order.push("connection");
        return { id: "conn_1", vendor: "hubspot" } as never;
      }),
      deleteBuildApproval: vi.fn(async () => {
        order.push("delete");
        return build;
      }),
    });
    await withdrawBuildApproval(ctx, SCOPE, "conn_1", deps);
    expect(order).toEqual(["connection", "delete"]);
    expect(events(deps)).toMatchObject([{ kind: "build", action: "withdrew", vendor: "hubspot" }]);
  });

  it("keeps the moment the person answered when an answer is written again with no event", async () => {
    const answered = new Date("2026-09-09T09:59:00Z");
    const deps = fakeDeps();
    await setApproval(ctx, SCOPE, "tool_1", "allow", deps, {
      asked: ASKED_V1,
      event: null,
      decidedAt: answered,
    });
    expect(deps.upsertApproval).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ decidedAt: answered }),
    );
    expect(deps.insertApprovalEvent).not.toHaveBeenCalled();
  });

  it("records an answer set from the console as the console's", async () => {
    const deps = fakeDeps();
    await setApprovalFromConsole(ctx, SCOPE, "tool_1", "deny", deps);
    expect(events(deps)).toMatchObject([{ kind: "tool", action: "denied", via: "console" }]);
  });

  it("records an integration's allow, its widening and its withdraw, with the destructive choice", async () => {
    const deps = fakeDeps({
      findVendorApproval: vi.fn(async () => vendorApproval),
      updateVendorApprovalDestructive: vi.fn(async (_db, _scope, _vendor, input) => ({
        ...vendorApproval,
        ...input,
      })),
      deleteVendorApproval: vi.fn(async () => ({ ...vendorApproval, includesDestructive: true })),
    });
    await allowVendor(ctx, SCOPE, "hubspot", { includesDestructive: false, event: CARD }, deps);
    await setVendorApprovalDestructive(ctx, SCOPE, "hubspot", true, deps);
    await setVendorApprovalDestructive(ctx, SCOPE, "hubspot", false, deps);
    await withdrawVendorApproval(ctx, SCOPE, "hubspot", deps);
    expect(
      events(deps).map(({ kind, action, via, includesDestructive, pendingActionId }) => ({
        kind,
        action,
        via,
        includesDestructive,
        pendingActionId,
      })),
    ).toEqual([
      {
        kind: "vendor",
        action: "allowed",
        via: "card",
        includesDestructive: false,
        pendingActionId: "pa_1",
      },
      {
        kind: "vendor",
        action: "widened",
        via: "console",
        includesDestructive: true,
        pendingActionId: null,
      },
      {
        kind: "vendor",
        action: "withdrew",
        via: "console",
        includesDestructive: true,
        pendingActionId: null,
      },
    ]);
  });

  it("records the connection's line only when it inserted, never over one that stood", async () => {
    const standing = fakeDeps({ findVendorApproval: vi.fn(async () => vendorApproval) });
    await allowVendorWhenConnecting(ctx, SCOPE, "hubspot", standing, CARD);
    expect(standing.insertApprovalEvent).not.toHaveBeenCalled();
    const fresh = fakeDeps();
    await allowVendorWhenConnecting(ctx, SCOPE, "hubspot", fresh, { via: "console" });
    expect(events(fresh)).toMatchObject([
      { kind: "vendor", action: "allowed", via: "console", includesDestructive: false },
    ]);
  });

  it("records a build grant once, and its withdraw, against the connection's integration", async () => {
    const deps = fakeDeps({ deleteBuildApproval: vi.fn(async () => build) });
    await grantBuildApproval(ctx, SCOPE, "conn_1", deps, { via: "setup" });
    await withdrawBuildApproval(ctx, SCOPE, "conn_1", deps);
    const repeat = fakeDeps({
      insertBuildApproval: vi.fn(async () => null),
      findBuildApproval: vi.fn(async () => build),
    });
    await grantBuildApproval(ctx, SCOPE, "conn_1", repeat, CARD);
    expect(events(deps)).toEqual([
      expect.objectContaining({
        kind: "build",
        action: "allowed",
        via: "setup",
        connectionId: "conn_1",
        vendor: "hubspot",
      }),
      expect.objectContaining({ kind: "build", action: "withdrew", via: "console" }),
    ]);
    expect(repeat.insertApprovalEvent).not.toHaveBeenCalled();
  });
});
