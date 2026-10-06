import type { AgentRow } from "@graft/db/repo/agent";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import { describe, expect, it, vi } from "vitest";

import type { AgentDeps } from "../agent/agent.deps";
import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { SetupDeps } from "./setup.deps";
import {
  connectingAgentOf,
  finishSetup,
  getSetupState,
  issueConsoleAgentToken,
  moveSetupBack,
  moveSetupBuild,
  moveSetupConnect,
  moveSetupOn,
  type SetupBuildDeps,
  type SetupBuildMove,
  skipSetup,
  startSetup,
  startSetupBuild,
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
    findAgent: vi.fn(async (_db, _p, id) => agents.find((row) => row.id === id) ?? null),
    issueAgentToken: vi.fn(async (_db, _p, id, token, replacing = null) => {
      const index = agents.findIndex((row) => row.id === id);
      const row = agents[index];
      if (!row || row.connectedViaClientId || row.revokedAt) return null;
      // The repo's predicate: no hash for a first issue, the replaced one for a re-issue.
      if (row.tokenHash !== replacing) return null;
      const issued = { ...row, ...token };
      agents[index] = issued;
      return issued;
    }),
    updateAgent: vi.fn(async (_db, _p, id, patch) => {
      const index = agents.findIndex((row) => row.id === id);
      const row = agents[index];
      if (!row) return null;
      const updated = { ...row, ...patch };
      agents[index] = updated;
      return updated;
    }),
    replaceAgentConnections: vi.fn(async () => {}),
    listScopeConnectionIds: vi.fn(async () => ["conn_1", "conn_2"]),
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

  it("lands a move from vendor only on the record as it was seen there", async () => {
    const w = await onVendor();
    const move = (m: Parameters<typeof moveSetupConnect>[2]) =>
      moveSetupConnect(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    const seenAt = new Date("2026-09-23T10:00:00.001Z");
    const at = (iso: string) => {
      const row = w.record();
      if (row) Object.assign(row, { updatedAt: new Date(iso) });
    };
    at("2026-09-23T10:00:00.001Z");
    // Another tab chose, and that choice closed, leaving the record on vendor as a later write.
    await move({ kind: "ask", agentId: "agent_new", pendingActionId: "pa_1" });
    await move({ kind: "reopen", askId: "pa_1" });
    at("2026-09-23T10:00:00.009Z");
    const ask = { kind: "ask", agentId: "agent_new", pendingActionId: "pa_2" } as const;
    expect((await move({ ...ask, fromVendorAt: seenAt })).moved).toBe(false);
    expect(
      (
        await move({
          kind: "connected",
          agentId: "agent_new",
          connectionId: "conn_1",
          fromVendorAt: seenAt,
        })
      ).moved,
    ).toBe(false);
    expect(w.record()).toMatchObject({ step: "vendor", pendingActionId: null });
    // As it was seen: the move lands.
    const landed = await move({ ...ask, fromVendorAt: new Date("2026-09-23T10:00:00.009Z") });
    expect(landed.moved).toBe(true);
    expect(w.record()).toMatchObject({ step: "connect", pendingActionId: "pa_2" });
    // Off vendor, it never lands, whatever the instant.
    at("2026-09-23T10:00:00.020Z");
    const offVendor = await move({
      ...ask,
      pendingActionId: "pa_3",
      fromVendorAt: new Date("2026-09-23T10:00:00.020Z"),
    });
    expect(offVendor.moved).toBe(false);
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

  it("continues to the finish while it runs, and names the tool there when it lands", async () => {
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

  it("names the tool on a record completed before it landed, and stays completed", async () => {
    const w = await onBuilding();
    await w.move({ kind: "continue", acquireJobId: "job_1" });
    await finishSetup(ctx, PRINCIPAL, w.deps, w.agentDeps);
    expect(w.record()).toMatchObject({ step: "completed", toolId: null });
    const landed = await w.move({ kind: "built", acquireJobId: "job_1", toolId: "tool_1" });
    expect(landed.moved).toBe(true);
    expect(landed.state).toMatchObject({
      show: false,
      setup: { step: "completed", toolId: "tool_1" },
    });
    const again = await w.move({ kind: "built", acquireJobId: "job_1", toolId: "tool_1" });
    expect(again.moved).toBe(false);
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

describe("the result and finish steps", () => {
  /** A record on `result` for job `job_1` and tool `tool_1`, run as the agent minted for `harness`. */
  async function onResult(harness: "hermes" | "claude") {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness }, w.deps, w.agentDeps);
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      step: "result",
      connectionId: "conn_1",
      acquireJobId: "job_1",
      toolId: "tool_1",
    });
    const move = (m: SetupBuildMove) => moveSetupBuild(ctx, PRINCIPAL, m, w.deps, w.agentDeps);
    return { ...w, move, finish: () => finishSetup(ctx, PRINCIPAL, w.deps, w.agentDeps) };
  }

  it("moves from the result to the finish with the job and the tool kept, and refuses a stale move", async () => {
    const w = await onResult("hermes");
    await expect(w.move({ kind: "finish", acquireJobId: "job_0" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const finish = await w.move({ kind: "finish", acquireJobId: "job_1" });
    expect(finish.moved).toBe(true);
    expect(finish.state.setup).toMatchObject({
      step: "finish",
      acquireJobId: "job_1",
      toolId: "tool_1",
    });
    await expect(w.move({ kind: "finish", acquireJobId: "job_1" })).rejects.toMatchObject({
      details: { reason: "setup_step", step: "finish" },
    });
  });

  it("completes a token harness's Setup with the agent's token, once, and the show rule answers no", async () => {
    const w = await onResult("hermes");
    await expect(w.finish()).rejects.toMatchObject({
      details: { reason: "setup_step", step: "result" },
    });
    await w.move({ kind: "finish", acquireJobId: "job_1" });
    const done = await w.finish();
    expect(done.token).toMatch(/^grft_/);
    expect(done.state).toMatchObject({ step: "completed", show: false });
    expect(done.state.setup?.completedAt).toEqual(NOW);
    expect(done.state.agent?.tokenPrefix).toBe(done.token?.slice(0, 8));
    await expect(w.finish()).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "setup_completed" },
    });
  });

  it("completes an OAuth harness's Setup with no token, the agent still awaiting its consent", async () => {
    const w = await onResult("claude");
    await w.move({ kind: "finish", acquireJobId: "job_1" });
    const done = await w.finish();
    expect(done.token).toBeNull();
    expect(done.state.step).toBe("completed");
    expect(w.agentDeps.issueAgentToken).not.toHaveBeenCalled();
    expect(done.state.agent).toMatchObject({ tokenPrefix: null, connectedVia: null });
  });

  it("issues nothing to an agent that already has a token, or to one Setup adopted", async () => {
    const w = await onResult("hermes");
    const minted = w.agents[0];
    if (minted) w.agents[0] = { ...minted, tokenHash: "h", tokenPrefix: "grft_old" };
    await w.move({ kind: "finish", acquireJobId: "job_1" });
    expect((await w.finish()).token).toBeNull();

    const adopted = world({ agents: [agentRow("agent_1")] });
    await startSetup(ctx, PRINCIPAL, {}, adopted.deps, adopted.agentDeps);
    await adopted.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, { step: "finish" });
    const done = await finishSetup(ctx, PRINCIPAL, adopted.deps, adopted.agentDeps);
    expect(done.token).toBeNull();
    expect(done.state.setup).toMatchObject({ step: "completed", harness: null });
  });
});

/**
 * The console's token route (ADR 0024 as amended 2026-09-25; Greptile on #172): a first issue to
 * an agent awaiting its harness, and a replacement for the agent Setup runs as while Setup is not
 * completed, since the finish step held the only plaintext and a reload lost it.
 */
describe("issueConsoleAgentToken", () => {
  async function onFinish() {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "hermes" }, w.deps, w.agentDeps);
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, { step: "finish" });
    const issue = (agentId = "agent_new") =>
      issueConsoleAgentToken(ctx, PRINCIPAL, agentId, w.deps, w.agentDeps);
    return { ...w, issue };
  }

  it("issues the first token, then replaces it while Setup is not completed, the old hash gone", async () => {
    const w = await onFinish();
    const first = await w.issue();
    expect(first.token).toMatch(/^grft_/);
    const firstHash = w.agents[0]?.tokenHash;
    const second = await w.issue();
    expect(second.token).toMatch(/^grft_/);
    expect(second.token).not.toBe(first.token);
    expect(w.agents[0]?.tokenHash).not.toBe(firstHash);
    expect(second.agent.tokenPrefix).toBe(second.token.slice(0, 8));
    // The replacement names the hash it replaced, so the write lands only over that one.
    expect(vi.mocked(w.agentDeps.issueAgentToken).mock.calls[1]?.[4]).toBe(firstHash);
    // Judged under the record's lock.
    expect(w.deps.lockSetup).toHaveBeenCalled();
  });

  it("refuses a replacement once Setup is completed, and for an agent Setup does not run as", async () => {
    const w = await onFinish();
    await w.issue();
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      step: "completed",
      completedAt: NOW,
    });
    await expect(w.issue()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already has a token"),
      details: { reason: "agent_not_awaiting_harness" },
    });

    const other = world({ agents: [agentRow("agent_1"), agentRow("agent_2")] });
    await startSetup(ctx, PRINCIPAL, { agentId: "agent_1" }, other.deps, other.agentDeps);
    await expect(
      issueConsoleAgentToken(ctx, PRINCIPAL, "agent_2", other.deps, other.agentDeps),
    ).rejects.toMatchObject({ details: { reason: "agent_not_awaiting_harness" } });
  });

  it("refuses a replacement for an agent a client connected, or one revoked", async () => {
    for (const patch of [
      { connectedViaClientId: "client_1", connectedViaClientName: "Claude" },
      { revokedAt: NOW },
    ]) {
      const w = await onFinish();
      await w.issue();
      const row = w.agents[0];
      if (row) w.agents[0] = { ...row, ...patch };
      await expect(w.issue()).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "agent_not_awaiting_harness" },
      });
    }
  });

  it("refuses the replacement when Setup finished between the read and the lock", async () => {
    const w = await onFinish();
    await w.issue();
    const lock = vi.mocked(w.deps.lockSetup);
    const locked = lock.getMockImplementation();
    lock.mockImplementationOnce(async (db, person) => {
      // Another tab's Finish Setup lands first.
      await w.deps.saveSetup(db, person, { step: "completed", completedAt: NOW });
      return (await locked?.(db, person)) as SetupRow;
    });
    const before = w.agents[0]?.tokenHash;
    await expect(w.issue()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("can no longer be replaced"),
    });
    expect(w.agents[0]?.tokenHash).toBe(before);
  });
});

describe("going back and on again (GRA-215)", () => {
  /** A record on `step` holding what that step needs, run as the agent minted for `harness`. */
  async function on(
    step: "vendor" | "connect" | "goal" | "building" | "result" | "finish",
    harness: "claude" | "hermes" = "claude",
    held: { toolId?: string | null } = {},
  ) {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness }, w.deps, w.agentDeps);
    const at = ["vendor", "connect", "goal", "building", "result", "finish"].indexOf(step);
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      step,
      connectionId: at >= 1 ? "conn_1" : null,
      acquireJobId: at >= 3 ? "job_1" : null,
      toolId: held.toolId !== undefined ? held.toolId : at >= 4 ? "tool_1" : null,
    });
    return {
      ...w,
      back: (to: Parameters<typeof moveSetupBack>[2]["to"]) =>
        moveSetupBack(ctx, PRINCIPAL, { to }, w.deps, w.agentDeps),
      onward: (move: Parameters<typeof moveSetupOn>[2]) =>
        moveSetupOn(ctx, PRINCIPAL, move, w.deps, w.agentDeps),
    };
  }

  it("returns from the finish to every step it completed, keeping the connection, the job and the tool", async () => {
    for (const to of ["result", "building", "goal", "connect", "vendor", "harness"] as const) {
      const w = await on("finish");
      const back = await w.back(to);
      expect(back.moved).toBe(true);
      expect(back.state.step).toBe(to);
      expect(back.state.setup).toMatchObject({
        step: to,
        connectionId: "conn_1",
        acquireJobId: "job_1",
        toolId: "tool_1",
      });
    }
  });

  it("returns from each step to the one before it", async () => {
    const pairs = [
      ["vendor", "harness"],
      ["connect", "vendor"],
      ["goal", "connect"],
      ["building", "goal"],
      ["result", "building"],
    ] as const;
    for (const [from, to] of pairs) {
      const w = await on(from);
      expect((await w.back(to)).state.setup?.step).toBe(to);
    }
  });

  it("refuses a step ahead of the record, the step it stands on, and a completed Setup", async () => {
    const w = await on("goal");
    await expect(w.back("building")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "setup_step_ahead", step: "goal" },
    });
    await expect(w.back("goal")).rejects.toMatchObject({
      details: { reason: "setup_step_ahead" },
    });
    expect(w.record()).toMatchObject({ step: "goal" });

    const done = await on("finish");
    await finishSetup(ctx, PRINCIPAL, done.deps, done.agentDeps);
    await expect(done.back("goal")).rejects.toMatchObject({
      details: { reason: "setup_completed" },
    });
  });

  it("refuses the result a record passed while the job ran, since no tool is there to show", async () => {
    const w = await on("finish", "claude", { toolId: null });
    await expect(w.back("result")).rejects.toMatchObject({
      details: { reason: "setup_step_unavailable", step: "finish" },
    });
    expect((await w.back("building")).state.setup?.step).toBe("building");
  });

  it("keeps a running job when the person looks back, and walks on to it with nothing changed", async () => {
    const w = await on("building");
    await w.back("harness");
    expect(w.record()).toMatchObject({ step: "harness", acquireJobId: "job_1" });
    await w.onward({ from: "harness" });
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, { step: "connect" });
    const goal = await w.onward({ from: "connect" });
    expect(goal.state.setup).toMatchObject({ step: "goal", acquireJobId: "job_1" });
    const building = await w.onward({ from: "goal" });
    expect(building.state.setup).toMatchObject({ step: "building", acquireJobId: "job_1" });
    // The tool has not landed, so there is no result to walk on to.
    await expect(w.onward({ from: "building" })).rejects.toMatchObject({
      details: { reason: "setup_step_unavailable" },
    });
  });

  it("drops the job only when another vendor's connection replaces the one it was acquired against", async () => {
    const same = await on("building");
    await same.back("vendor");
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "connected", agentId: "agent_new", connectionId: "conn_1" },
      same.deps,
      same.agentDeps,
    );
    expect(same.record()).toMatchObject({ step: "goal", acquireJobId: "job_1" });

    const other = await on("result");
    await other.back("vendor");
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "connected", agentId: "agent_new", connectionId: "conn_2" },
      other.deps,
      other.agentDeps,
    );
    expect(other.record()).toMatchObject({
      step: "goal",
      connectionId: "conn_2",
      acquireJobId: null,
      toolId: null,
    });

    const asked = await on("building");
    await asked.back("vendor");
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "ask", agentId: "agent_new", pendingActionId: "pa_9" },
      asked.deps,
      asked.agentDeps,
    );
    // An ask leaves them until it is answered: with another connection they go, declined too.
    expect(asked.record()).toMatchObject({ step: "connect", acquireJobId: "job_1" });
    await moveSetupConnect(
      ctx,
      PRINCIPAL,
      { kind: "reopen", askId: "pa_9" },
      asked.deps,
      asked.agentDeps,
    );
    expect(asked.record()).toMatchObject({
      step: "vendor",
      connectionId: null,
      acquireJobId: null,
    });
  });

  it("changes the harness while the agent awaits it, renaming a default name, and moves to the vendor", async () => {
    const w = await on("goal");
    await w.back("harness");
    const next = await w.onward({ from: "harness", harness: "codex" });
    expect(next.state.setup).toMatchObject({ step: "vendor", harness: "codex" });
    expect(next.state.agent?.name).toBe("Codex");
    // The connection and anything built against it stay: the harness decides none of it.
    expect(next.state.setup).toMatchObject({ connectionId: "conn_1" });

    const named = await on("vendor");
    const agent = named.agents[0];
    if (agent) named.agents[0] = { ...agent, name: "Work Claude" };
    await named.back("harness");
    const kept = await named.onward({ from: "harness", harness: "chatgpt" });
    expect(kept.state.agent?.name).toBe("Work Claude");
  });

  it("refuses a different harness once the agent has its token or client, and for an adopted agent", async () => {
    const w = await on("vendor", "hermes");
    const agent = w.agents[0];
    if (agent) w.agents[0] = { ...agent, tokenHash: "h", tokenPrefix: "grft_abc" };
    await w.back("harness");
    await expect(w.onward({ from: "harness", harness: "openclaw" })).rejects.toMatchObject({
      details: { reason: "harness_fixed" },
    });
    // The same harness, or none named, continues.
    expect((await w.onward({ from: "harness" })).state.setup?.step).toBe("vendor");

    const adopted = world({ agents: [agentRow("agent_1")] });
    await startSetup(ctx, PRINCIPAL, {}, adopted.deps, adopted.agentDeps);
    await moveSetupBack(ctx, PRINCIPAL, { to: "harness" }, adopted.deps, adopted.agentDeps);
    await expect(
      moveSetupOn(
        ctx,
        PRINCIPAL,
        { from: "harness", harness: "claude" },
        adopted.deps,
        adopted.agentDeps,
      ),
    ).rejects.toMatchObject({ details: { reason: "harness_fixed" } });
  });

  it("refuses a continue from a step the record is not on, and one with nothing to continue to", async () => {
    const w = await on("goal", "claude");
    await expect(w.onward({ from: "connect" })).rejects.toMatchObject({
      details: { reason: "setup_step", step: "goal" },
    });
    // On goal with no job held, Build is the way on.
    await expect(w.onward({ from: "goal" })).rejects.toMatchObject({
      details: { reason: "setup_step_unavailable" },
    });
    const waiting = await on("connect");
    await waiting.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      connectionId: null,
      pendingActionId: "pa_1",
    });
    await expect(waiting.onward({ from: "connect" })).rejects.toMatchObject({
      details: { reason: "setup_step_unavailable" },
    });
  });
});

describe("Build over a job the record still holds (GRA-215)", () => {
  function buildDeps(w: ReturnType<typeof world>, status: "queued" | "running" | "failed") {
    const jobs: Record<string, unknown>[] = [];
    const deps = {
      setup: w.deps,
      agent: w.agentDeps,
      connection: { findConnection: vi.fn(async () => ({ id: "conn_1", revokedAt: null })) },
      approval: {
        findConnection: vi.fn(async () => ({ id: "conn_1" })),
        insertBuildApproval: vi.fn(async (_db: unknown, row: unknown) => row),
        findBuildApproval: vi.fn(async () => null),
        now: () => NOW,
      },
      acquireJob: {
        findAcquireJob: vi.fn(async (_db: unknown, _scope: unknown, id: string) => ({
          id,
          status,
        })),
        findConnection: vi.fn(async () => ({ id: "conn_1" })),
        insertAcquireJob: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
          jobs.push(row);
          return row;
        }),
        newId: () => `job_${jobs.length + 2}`,
        now: () => NOW,
      },
    } as unknown as SetupBuildDeps;
    return { deps, jobs };
  }

  async function onGoalHolding(status: "queued" | "running" | "failed") {
    const w = world({});
    await startSetup(ctx, PRINCIPAL, { harness: "claude" }, w.deps, w.agentDeps);
    await w.deps.saveSetup(fakeDb as never, PRINCIPAL.personId, {
      step: "building",
      connectionId: "conn_1",
      acquireJobId: "job_1",
    });
    await moveSetupBack(ctx, PRINCIPAL, { to: "goal" }, w.deps, w.agentDeps);
    const built = buildDeps(w, status);
    return { record: w.record, deps: built.deps, jobs: built.jobs };
  }

  const input = { goal: "Read the weather", firstProgressLine: "Queued: the job waits." };

  it("refuses to leave a running job behind unless the Build says so", async () => {
    for (const status of ["queued", "running"] as const) {
      const w = await onGoalHolding(status);
      await expect(startSetupBuild(ctx, PRINCIPAL, input, w.deps)).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "job_running", acquireJobId: "job_1" },
      });
      expect(w.jobs).toHaveLength(0);
      expect(w.record()).toMatchObject({ step: "goal", acquireJobId: "job_1" });
      const { state } = await startSetupBuild(
        ctx,
        PRINCIPAL,
        { ...input, discardJob: true },
        w.deps,
      );
      expect(w.jobs).toHaveLength(1);
      expect(state.setup).toMatchObject({ step: "building", acquireJobId: "job_2" });
    }
  });

  it("builds over a held job that already failed without asking", async () => {
    const w = await onGoalHolding("failed");
    const { state } = await startSetupBuild(ctx, PRINCIPAL, input, w.deps);
    expect(state.setup).toMatchObject({ step: "building", acquireJobId: "job_2" });
  });
});
