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
  moveSetupConnect,
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
    expect(asked.setup).toMatchObject({ step: "connect", pendingActionId: "pa_1" });
    // A repeat, or another starter, re-points the ask while on connect.
    await move({ kind: "ask", agentId: "agent_new", pendingActionId: "pa_2" });
    // A read that learned from the first ask is stale and changes nothing.
    await move({ kind: "connected", agentId: "agent_new", connectionId: "conn_1", askId: "pa_1" });
    expect(w.record()).toMatchObject({ step: "connect", pendingActionId: "pa_2" });
    const done = await move({
      kind: "connected",
      agentId: "agent_new",
      connectionId: "conn_2",
      askId: "pa_2",
    });
    expect(done.setup).toMatchObject({
      step: "goal",
      connectionId: "conn_2",
      pendingActionId: null,
    });
    expect(() => connectingAgentOf(done)).toThrow(ServiceError);
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
    expect(back.setup).toMatchObject({ step: "vendor", pendingActionId: null });
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
