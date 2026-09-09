import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import { hashAgentToken } from "../tenancy";
import type { AgentDeps } from "./agent.deps";
import {
  createAgent,
  revokeAgent,
  setAgentScope,
  toAgentOutput,
  updateAgentLimits,
} from "./agent.service";

/**
 * The agent service with fakes and no database — the reference shape for every suite in this
 * package. `db` is never dereferenced; the transaction fake hands the same handle to its body.
 */

const NOW = new Date("2026-09-09T10:00:00Z");
const PRINCIPAL = { personId: "person_1" };

const row: AgentRow = {
  id: "agent_1",
  personId: "person_1",
  name: "laptop Hermes",
  tokenHash: "hash",
  tokenPrefix: "grft_abc",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const connectionRow = (id: string): ConnectionRow =>
  ({ id, personId: "person_1", vendor: "unleashed" }) as ConnectionRow;

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    insertAgent: vi.fn(async (_db, input) => ({ ...row, ...input }) as AgentRow),
    findAgent: vi.fn(async () => row),
    findAgentByTokenHash: vi.fn(async () => row),
    listAgents: vi.fn(async () => [row]),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => ({ ...row, ...patch })),
    revokeAgent: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    replaceAgentConnections: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => []),
    findConnectionsByIds: vi.fn(async (_db, _p, ids) => ids.map(connectionRow)),
    listAllActiveAgents: vi.fn(async () => [row]),
    newId: () => "agent_new",
    now: () => NOW,
    randomBytes: (bytes) => Buffer.alloc(bytes, 1),
    ...overrides,
  };
}

describe("createAgent", () => {
  it("returns the token exactly once and stores only its hash and prefix", async () => {
    const deps = fakeDeps();
    const result = await createAgent(ctx, PRINCIPAL, { name: "laptop Hermes" }, deps);

    expect(result.token.startsWith("grft_")).toBe(true);
    const inserted = vi.mocked(deps.insertAgent).mock.calls[0]?.[1];
    expect(inserted?.tokenHash).toBe(hashAgentToken(result.token));
    expect(inserted?.tokenPrefix).toBe(result.token.slice(0, 8));
    expect(JSON.stringify(inserted)).not.toContain(result.token);
    expect(JSON.stringify(result.agent)).not.toContain(result.token);
    expect(result.agent).not.toHaveProperty("tokenHash");
  });

  it("writes the person, the id and only the limits that were given", async () => {
    const deps = fakeDeps();
    await createAgent(ctx, PRINCIPAL, { name: "  ops  ", workingSetCap: 5 }, deps);

    const inserted = vi.mocked(deps.insertAgent).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      id: "agent_new",
      personId: "person_1",
      name: "ops",
      workingSetCap: 5,
    });
    expect(inserted).not.toHaveProperty("idleWindowDays");
  });

  it("refuses an empty name, a cap or a window outside the range, before writing", async () => {
    const deps = fakeDeps();
    for (const input of [
      { name: "   " },
      { name: "ok", workingSetCap: 0 },
      { name: "ok", workingSetCap: 2.5 },
      { name: "ok", idleWindowDays: 0 },
      { name: "ok", idleWindowDays: 100_000 },
    ]) {
      await expect(createAgent(ctx, PRINCIPAL, input, deps)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(deps.insertAgent).not.toHaveBeenCalled();
  });

  it("writes the initial scope inside the same transaction, de-duplicated", async () => {
    const deps = fakeDeps();
    const result = await createAgent(
      ctx,
      PRINCIPAL,
      { name: "ops", connectionIds: ["conn_1", "conn_2", "conn_1"] },
      deps,
    );

    expect(result.connectionIds).toEqual(["conn_1", "conn_2"]);
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_new" },
      ["conn_1", "conn_2"],
    );
  });

  /** A connection that is not the person's and one that does not exist are the same answer (ADR 0007). */
  it("refuses a connection id the person does not own as NOT_FOUND, naming it, and writes nothing", async () => {
    const deps = fakeDeps({
      findConnectionsByIds: vi.fn(async () => [connectionRow("conn_1")]),
    });
    const attempt = createAgent(
      ctx,
      PRINCIPAL,
      { name: "ops", connectionIds: ["conn_1", "conn_other"] },
      deps,
    );
    await expect(attempt).rejects.toThrow(ServiceError);
    await expect(attempt).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Connection not found: conn_other",
    });
    expect(deps.insertAgent).not.toHaveBeenCalled();
  });
});

describe("toAgentOutput", () => {
  it("never carries the token hash", () => {
    const output = toAgentOutput(row);
    expect(output).not.toHaveProperty("tokenHash");
    expect(output.tokenPrefix).toBe("grft_abc");
  });
});

describe("updateAgentLimits", () => {
  it("passes only the given keys, so an absent one does not overwrite a stored value", async () => {
    const deps = fakeDeps();
    await updateAgentLimits(ctx, PRINCIPAL, "agent_1", { idleWindowDays: 7 }, deps);
    expect(deps.updateAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", {
      idleWindowDays: 7,
    });
  });

  it("answers null for no such agent", async () => {
    const deps = fakeDeps({ updateAgent: vi.fn(async () => null) });
    await expect(
      updateAgentLimits(ctx, PRINCIPAL, "missing", { name: "x" }, deps),
    ).resolves.toBeNull();
  });
});

describe("revokeAgent", () => {
  it("stamps the clock's moment under the person", async () => {
    const deps = fakeDeps();
    const result = await revokeAgent(ctx, PRINCIPAL, "agent_1", deps);
    expect(deps.revokeAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", NOW);
    expect(result?.revokedAt).toEqual(NOW);
  });
});

describe("setAgentScope", () => {
  it("replaces the set under the scope pair once every id is confirmed the person's", async () => {
    const deps = fakeDeps();
    const result = await setAgentScope(ctx, PRINCIPAL, "agent_1", ["conn_2", "conn_1"], deps);
    expect(result.connectionIds).toEqual(["conn_2", "conn_1"]);
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_2", "conn_1"],
    );
  });

  it("refuses an unknown agent before checking any connection", async () => {
    const deps = fakeDeps({ findAgent: vi.fn(async () => null) });
    await expect(setAgentScope(ctx, PRINCIPAL, "missing", ["conn_1"], deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.findConnectionsByIds).not.toHaveBeenCalled();
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
  });

  it("leaves the old scope intact when an id is refused", async () => {
    const deps = fakeDeps({ findConnectionsByIds: vi.fn(async () => []) });
    await expect(setAgentScope(ctx, PRINCIPAL, "agent_1", ["conn_x"], deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
  });
});
