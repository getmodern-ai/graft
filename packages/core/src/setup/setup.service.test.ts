import type { AgentRow } from "@graft/db/repo/agent";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import { describe, expect, it, vi } from "vitest";

import type { AgentDeps } from "../agent/agent.deps";
import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { SetupDeps } from "./setup.deps";
import {
  connectingAgentOf,
  getSetupState,
  moveSetupBuild,
  moveSetupConnect,
  type SetupBuildMove,
  skipSetup,
  startSetup,
} from "./setup.service";

/**
 * The Setup service over fakes: an in-memory record and agent table, so what is asserted is what a
 * caller sees in the state after each verb — the agent minted or adopted, the step, the show rule.
 */

const NOW = new Date("2026-09-23T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };
const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

const agentRow = (id: string, overrides: Partial<AgentRow> = {}): AgentRow => ({
  id,
  personId: "person_1",
  name: id,
  tokenHash: `hash_${id}`,
  tokenPrefix: `grft_${id}`,
  connectedViaClientId: null,
  connectedViaClientName: null,
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function world(options: { agents?: AgentRow[]; work?: { connections: number; tools: number } }) {
  const agents = [...(options.agents ?? [])];
  let record: SetupRow | null = null;
  const blank = (): SetupRow => ({
    personId: "person_1",
    step: "harness",
    harness: null,
    agentId: null,
    pendingActionId: null,
    connectionId: null,
    acquireJobId: null,
    toolId: null,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    owner: "person",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const save = (patch: SetupPatch) => {
    record = { ...(record ?? blank()), ...patch } as SetupRow;
    return record;
  };
  const deps: SetupDeps = {
    findSetup: vi.fn(async () => record),
    lockSetup: vi.fn(async () => record ?? save({})),
    saveSetup: vi.fn(async (_db, _p, patch) => save(patch)),
    countSetupWork: vi.fn(async () => options.work ?? { connections: 0, tools: 0 }),
    now: () => NOW,
  };
  const agentDeps = {
    insertAgent: vi.fn(async (_db, input) => {
      const row = agentRow(input.id, input as Partial<AgentRow>);
      agents.push(row);
      return row;
    }),
    listAgents: vi.fn(async () => agents.map((row) => ({ ...row, workingSetCount: 0 }))),
    replaceAgentConnections: vi.fn(async () => {}),
    listScopeConnectionIds: vi.fn(async () => []),
    findConnectionsByIds: vi.fn(async () => []),
    newId: () => "agent_new",
    now: () => NOW,
  } as unknown as AgentDeps;
  return { deps, agentDeps, agents, record: () => record };
}

describe("getSetupState", () => {
  it("answers the harness step and the show rule's yes for a fresh person", async () => {
    const w = world({});
    const state = await getSetupState(ctx, PRINCIPAL, w.deps, w.agentDeps);
    expect(state).toEqual({
      setup: null,
      step: "harness",
      show: true,
      agent: null,
      activeAgents: [],
    });
  });

  it("answers no for a person who connected a vendor by hand", async () => {
    const w = world({ work: { connections: 1, tools: 0 } });
    expect((await getSetupState(ctx, PRINCIPAL, w.deps, w.agentDeps)).show).toBe(false);
  });
});

describe("startSetup", () => {
  it("mints an agent awaiting its harness for a person with none, and moves on to the vendor", async () => {
    const w = world({});
    const state = await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    expect(vi.mocked(w.agentDeps.insertAgent).mock.calls[0]?.[1]).toMatchObject({
      name: "Claude",
      tokenHash: null,
      tokenPrefix: null,
      connectedViaClientId: null,
      scopeMode: "all",
    });
    expect(state.step).toBe("vendor");
    expect(state.setup).toMatchObject({ harness: "claude", agentId: "agent_new", startedAt: NOW });
    expect(state.agent).toMatchObject({ id: "agent_new", tokenPrefix: null, connectedVia: null });
    expect(state.show).toBe(true);
  });

  it("mints with the advanced options when given", async () => {
    const w = world({});
    await startSetup(
      ctx,
      PRINCIPAL,
      {
        harness: "hermes",
        agent: { name: "laptop Hermes", workingSetCap: 5, idleWindowDays: 3, scopeMode: "listed" },
      },
      w.deps,
      w.agentDeps,
    );
    expect(vi.mocked(w.agentDeps.insertAgent).mock.calls[0]?.[1]).toMatchObject({
      name: "laptop Hermes",
      workingSetCap: 5,
      idleWindowDays: 3,
      scopeMode: "listed",
    });
  });

  it("refuses a start that names no harness for a person with no agent", async () => {
    const w = world({});
    await expect(startSetup(ctx, PRINCIPAL, {}, w.deps, w.agentDeps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "harness_required" },
    });
    expect(w.agentDeps.insertAgent).not.toHaveBeenCalled();
  });

  it("resumes rather than mints again: a second start answers the same agent", async () => {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    const again = await startSetup(ctx, PRINCIPAL, { harness: "codex" }, w.deps, w.agentDeps);
    expect(w.agentDeps.insertAgent).toHaveBeenCalledTimes(1);
    expect(again.setup).toMatchObject({ harness: "claude", agentId: "agent_new" });
    expect(again.step).toBe("vendor");
  });

  it("adopts the one active agent without asking, recording no harness", async () => {
    const w = world({
      agents: [agentRow("agent_claude", { tokenHash: null, tokenPrefix: null })],
    });
    const state = await startSetup(ctx, PRINCIPAL, {}, w.deps, w.agentDeps);
    expect(w.agentDeps.insertAgent).not.toHaveBeenCalled();
    expect(state.setup).toMatchObject({ agentId: "agent_claude", harness: null, step: "vendor" });
    expect(state.agent?.id).toBe("agent_claude");
  });

  it("does not count a revoked agent as one to adopt", async () => {
    const w = world({ agents: [agentRow("agent_old", { revokedAt: NOW })] });
    await expect(startSetup(ctx, PRINCIPAL, {}, w.deps, w.agentDeps)).rejects.toMatchObject({
      details: { reason: "harness_required" },
    });
    const state = await startSetup(ctx, PRINCIPAL, { harness: "chatgpt" }, w.deps, w.agentDeps);
    expect(state.setup?.agentId).toBe("agent_new");
  });

  it("asks which among several, and runs as the one named", async () => {
    const w = world({ agents: [agentRow("agent_a"), agentRow("agent_b")] });
    await expect(startSetup(ctx, PRINCIPAL, {}, w.deps, w.agentDeps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "agent_required", agentIds: ["agent_a", "agent_b"] },
    });
    const state = await startSetup(ctx, PRINCIPAL, { agentId: "agent_b" }, w.deps, w.agentDeps);
    expect(state.setup?.agentId).toBe("agent_b");
  });

  it("records no harness beside an adopted agent, whether one or named among several", async () => {
    const one = world({ agents: [agentRow("agent_claude")] });
    const adopted = await startSetup(
      ctx,
      PRINCIPAL,
      { harness: "claude" },
      one.deps,
      one.agentDeps,
    );
    expect(adopted.setup).toMatchObject({ agentId: "agent_claude", harness: null });
    const several = world({ agents: [agentRow("agent_a"), agentRow("agent_b")] });
    const named = await startSetup(
      ctx,
      PRINCIPAL,
      { harness: "hermes", agentId: "agent_b" },
      several.deps,
      several.agentDeps,
    );
    expect(named.setup).toMatchObject({ agentId: "agent_b", harness: null });
  });

  it("refuses an agent that is not one of the person's active agents", async () => {
    const w = world({ agents: [agentRow("agent_a"), agentRow("agent_b", { revokedAt: NOW })] });
    await expect(
      startSetup(ctx, PRINCIPAL, { agentId: "agent_b" }, w.deps, w.agentDeps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to mint beside an agent the person already has", async () => {
    const w = world({ agents: [agentRow("agent_a")] });
    await expect(
      startSetup(ctx, PRINCIPAL, { harness: "claude", agent: {} }, w.deps, w.agentDeps),
    ).rejects.toMatchObject({ details: { reason: "agent_exists" } });
  });

  it("refuses both an agent to adopt and one to mint", async () => {
    const w = world({});
    await expect(
      startSetup(ctx, PRINCIPAL, { agentId: "agent_a", agent: {} }, w.deps, w.agentDeps),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("goes back to the harness step, and mints again, once the agent it ran as is revoked", async () => {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    const minted = w.agents[0];
    if (minted) minted.revokedAt = NOW;
    expect((await getSetupState(ctx, PRINCIPAL, w.deps, w.agentDeps)).step).toBe("harness");
  });
});

describe("skipSetup", () => {
  it("marks a fresh person's Setup skipped, and the show rule answers no", async () => {
    const w = world({});
    const state = await skipSetup(ctx, PRINCIPAL, w.deps, w.agentDeps);
    expect(state.setup).toMatchObject({ skippedAt: NOW, startedAt: null });
    expect(state.show).toBe(false);
  });

  it("judges the skip on the locked record, and leaves a completed one unmarked", async () => {
    const w = world({});
    await w.deps.saveSetup(fakeDb as never, "person_1", { step: "completed", completedAt: NOW });
    const state = await skipSetup(ctx, PRINCIPAL, w.deps, w.agentDeps);
    expect(w.deps.lockSetup).toHaveBeenCalled();
    expect(state.setup).toMatchObject({ step: "completed", skippedAt: null });
  });

  it("keeps the agent it ran as, and a start clears the skip", async () => {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "hermes" }, w.deps, w.agentDeps);
    const skipped = await skipSetup(ctx, PRINCIPAL, w.deps, w.agentDeps);
    expect(skipped.setup).toMatchObject({ agentId: "agent_new", step: "vendor", skippedAt: NOW });
    const resumed = await startSetup(ctx, PRINCIPAL, {}, w.deps, w.agentDeps);
    expect(resumed.setup?.skippedAt).toBeNull();
    expect(resumed.show).toBe(true);
    expect(w.agentDeps.insertAgent).toHaveBeenCalledTimes(1);
  });
});

describe("the connect step's moves", () => {
  async function onVendor() {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    return w;
  }

  it("names the ask on connect, then the connection on goal once the ask is answered", async () => {
    const w = await onVendor();
    const move = (m: Parameters<typeof moveSetupConnect>[2]) =>
      moveSetupConnect(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    const asked = await move({ kind: "ask", agentId: "agent_new", pendingActionId: "pa_1" });
    expect(asked).toMatchObject({ moved: true, state: { setup: { step: "connect" } } });
    expect(asked.state.setup).toMatchObject({ step: "connect", pendingActionId: "pa_1" });
    // A repeat, or another starter, re-points the ask while on connect.
    await move({ kind: "ask", agentId: "agent_new", pendingActionId: "pa_2" });
    // A read that learned from the first ask is stale and changes nothing.
    const stale = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_1",
      askId: "pa_1",
    });
    expect(stale.moved).toBe(false);
    expect(w.record()).toMatchObject({ step: "connect", pendingActionId: "pa_2" });
    const done = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_2",
      askId: "pa_2",
    });
    expect(done.moved).toBe(true);
    expect(done.state.setup).toMatchObject({
      step: "goal",
      connectionId: "conn_2",
      pendingActionId: null,
    });
    expect(() => connectingAgentOf(done.state)).toThrow(ServiceError);
    // A second read that learned the same answer finds the record moved on: it answers the same
    // state, and says it did not move it, so the step is counted once.
    const again = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_2",
      askId: "pa_2",
    });
    expect(again).toMatchObject({ moved: false, state: { step: "goal" } });
  });

  it("goes back to the vendor step from goal when its connection is lost, and only then", async () => {
    const w = await onVendor();
    const move = (m: Parameters<typeof moveSetupConnect>[2]) =>
      moveSetupConnect(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    await move({ kind: "connected", agentId: "agent_new", connectionId: "conn_1" });
    expect((await move({ kind: "lost", connectionId: "conn_other" })).moved).toBe(false);
    expect(w.record()).toMatchObject({ step: "goal", connectionId: "conn_1" });
    const lost = await move({ kind: "lost", connectionId: "conn_1" });
    expect(lost).toMatchObject({ moved: true, state: { step: "vendor" } });
    expect(w.record()).toMatchObject({ step: "vendor", connectionId: null });
    expect((await move({ kind: "lost", connectionId: "conn_1" })).moved).toBe(false);
  });

  it("lands a move from vendor only on a record still on vendor", async () => {
    const w = await onVendor();
    const move = (m: Parameters<typeof moveSetupConnect>[2]) =>
      moveSetupConnect(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    const landed = await move({
      kind: "ask",
      agentId: "agent_new",
      pendingActionId: "pa_1",
      fromVendor: true,
    });
    expect(landed.moved).toBe(true);
    // Another choice moved the record on: a second routing's ask or connection changes nothing.
    const late = await move({
      kind: "ask",
      agentId: "agent_new",
      pendingActionId: "pa_2",
      fromVendor: true,
    });
    expect(late.moved).toBe(false);
    const lateConnection = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_1",
      fromVendor: true,
    });
    expect(lateConnection.moved).toBe(false);
    expect(w.record()).toMatchObject({ step: "connect", pendingActionId: "pa_1" });
    await move({ kind: "reopen", askId: "pa_1" });
    const connected = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_1",
      fromVendor: true,
    });
    expect(connected.moved).toBe(true);
    expect(w.record()).toMatchObject({ step: "goal", connectionId: "conn_1" });
  });

  it("runs confirm under the lock once the guard passes, and a no leaves the record", async () => {
    const w = await onVendor();
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "connected", agentId: "agent_new", connectionId: "conn_1" },
      w.deps,
      w.agentDeps,
    );
    const asked: string[] = [];
    const lost = (answer: boolean, connectionId = "conn_1") =>
      moveSetupConnect(
        ctx,
        PRINCIPAL,
        { kind: "lost", connectionId },
        w.deps,
        w.agentDeps,
        async () => {
          asked.push(connectionId);
          return answer;
        },
      );
    // The guard fails first: confirm is never asked.
    expect((await lost(true, "conn_other")).moved).toBe(false);
    expect(asked).toEqual([]);
    // Judged again and found untrue: the record stays on goal.
    expect((await lost(false)).moved).toBe(false);
    expect(w.record()).toMatchObject({ step: "goal", connectionId: "conn_1" });
    expect((await lost(true)).moved).toBe(true);
    expect(w.record()).toMatchObject({ step: "vendor", connectionId: null });
    expect(asked).toEqual(["conn_1", "conn_1"]);
  });

  it("goes back to the vendor step when the ask it waits on closed without a connection", async () => {
    const w = await onVendor();
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "ask", agentId: "agent_new", pendingActionId: "pa_1" },
      w.deps,
      w.agentDeps,
    );
    const back = await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "reopen", askId: "pa_1" },
      w.deps,
      w.agentDeps,
    );
    expect(back.state.setup).toMatchObject({ step: "vendor", pendingActionId: null });
  });

  it("refuses a move for an agent the record does not run as, and a Setup not yet started", async () => {
    const w = await onVendor();
    await expect(
      moveSetupConnect(
        ctx,
        PRINCIPAL,
        { kind: "connected", agentId: "agent_other", connectionId: "conn_1" },
        w.deps,
        w.agentDeps,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const fresh = world({});
    const state = await getSetupState(ctx, PRINCIPAL, fresh.deps, fresh.agentDeps);
    expect(() => connectingAgentOf(state)).toThrow("Setup has not started");
  });
});

describe("the building step's moves", () => {
  /** A record on `building` for job `job_1`, as `startSetupBuild` leaves it. */
  async function onBuilding() {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      step: "building",
      connectionId: "conn_1",
      acquireJobId: "job_1",
    });
    const move = (m: SetupBuildMove) => moveSetupBuild(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    return { ...w, move };
  }

  it("names the tool and moves to the result once the job it waits on passed", async () => {
    const w = await onBuilding();
    // A read about another job is stale and changes nothing.
    await w.move({ kind: "built", acquireJobId: "job_0", toolId: "tool_0" });
    expect(w.record()).toMatchObject({ step: "building", toolId: null });
    const built = await w.move({ kind: "built", acquireJobId: "job_1", toolId: "tool_1" });
    expect(built.moved).toBe(true);
    expect(built.state.setup).toMatchObject({
      step: "result",
      toolId: "tool_1",
      acquireJobId: "job_1",
    });
    // A second read of the same pass is a no-op, and says so, so the step is counted once.
    const again = await w.move({ kind: "built", acquireJobId: "job_1", toolId: "tool_1" });
    expect(again).toMatchObject({ moved: false, state: { step: "result" } });
    expect(w.record()).toMatchObject({ step: "result" });
  });

  it("continues to the finish while it builds, and names the tool there when it lands", async () => {
    const w = await onBuilding();
    const finish = await w.move({ kind: "continue", acquireJobId: "job_1" });
    expect(finish.state.setup).toMatchObject({
      step: "finish",
      acquireJobId: "job_1",
      toolId: null,
    });
    const landed = await w.move({ kind: "built", acquireJobId: "job_1", toolId: "tool_1" });
    expect(landed).toMatchObject({ moved: true, state: { setup: { toolId: "tool_1" } } });
    expect(landed.state.setup).toMatchObject({ step: "finish", toolId: "tool_1" });
  });

  it("goes back to the goal with the job cleared on a retry, and refuses a stale one", async () => {
    const w = await onBuilding();
    await expect(w.move({ kind: "retry", acquireJobId: "job_0" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const back = await w.move({ kind: "retry", acquireJobId: "job_1" });
    expect(back.state.setup).toMatchObject({
      step: "goal",
      acquireJobId: null,
      connectionId: "conn_1",
    });
    await expect(w.move({ kind: "continue", acquireJobId: "job_1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
