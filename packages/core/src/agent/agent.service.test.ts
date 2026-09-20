import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import { hashAgentToken } from "../tenancy";
import type { AgentDeps } from "./agent.deps";
import {
  addConnectionToAgentScope,
  archiveAgent,
  connectExistingAgentToClient,
  createAgent,
  createAgentForClient,
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
  connectedViaClientId: null,
  connectedViaClientName: null,
  scopeMode: "listed",
  workingSetCap: 20,
  idleWindowDays: 21,
  archivedAt: null,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

/** The same agent on `all` (ADR 0007 as amended 2026-09-19). */
const openRow: AgentRow = { ...row, scopeMode: "all" };

const connectionRow = (id: string): ConnectionRow =>
  ({ id, personId: "person_1", vendor: "unleashed" }) as ConnectionRow;

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    insertAgent: vi.fn(async (_db, input) => ({ ...row, ...input }) as AgentRow),
    findAgent: vi.fn(async () => row),
    findAgentForUpdate: vi.fn(async () => row),
    findAgentByTokenHash: vi.fn(async () => row),
    findAgentByMcpAccessTokenHash: vi.fn(async () => null),
    listAgents: vi.fn(async () => [row]),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => ({ ...row, ...patch })),
    revokeAgent: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    archiveAgent: vi.fn(async () => ({ ...row, revokedAt: NOW, archivedAt: NOW })),
    revokeMcpTokensForAgent: vi.fn(async () => 0),
    setAgentConnectedVia: vi.fn(async (_db, _p, _a, via) => ({
      ...row,
      connectedViaClientId: via.clientId,
      connectedViaClientName: via.clientName,
    })),
    replaceAgentConnections: vi.fn(async () => {}),
    addAgentConnection: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => []),
    // The person's three connections, as the resolved read answers for an agent on `all`.
    listScopeConnectionIds: vi.fn(async () => ["conn_1", "conn_2", "conn_3"]),
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

  /** ADR 0007 as amended 2026-09-19: a new agent reaches every connection of the person's unless narrowed. */
  it("starts on all connections by default: the row says so, no list is written, and the answer is every connection the person has", async () => {
    const deps = fakeDeps();
    const result = await createAgent(ctx, PRINCIPAL, { name: "Claude" }, deps);
    const inserted = vi.mocked(deps.insertAgent).mock.calls[0]?.[1];
    expect(inserted?.scopeMode).toBe("all");
    expect(result.agent.scopeMode).toBe("all");
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.findConnectionsByIds).not.toHaveBeenCalled();
    expect(result.connectionIds).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(deps.listScopeConnectionIds).toHaveBeenCalledWith(fakeDb, {
      personId: "person_1",
      agentId: "agent_new",
    });
  });

  it("refuses a list beside scopeMode all, before writing — the caller has two answers in mind", async () => {
    const deps = fakeDeps();
    await expect(
      createAgent(
        ctx,
        PRINCIPAL,
        { name: "ok", scopeMode: "all", connectionIds: ["conn_1"] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.insertAgent).not.toHaveBeenCalled();
    // An empty list is no list: the console's form may send one.
    const empty = await createAgent(
      ctx,
      PRINCIPAL,
      { name: "ok", scopeMode: "all", connectionIds: [] },
      deps,
    );
    expect(empty.agent.scopeMode).toBe("all");
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

  it("writes the initial list inside the same transaction under listed, de-duplicated", async () => {
    const deps = fakeDeps();
    const result = await createAgent(
      ctx,
      PRINCIPAL,
      { name: "ops", scopeMode: "listed", connectionIds: ["conn_1", "conn_2", "conn_1"] },
      deps,
    );

    const inserted = vi.mocked(deps.insertAgent).mock.calls[0]?.[1];
    expect(inserted?.scopeMode).toBe("listed");
    expect(result.agent.scopeMode).toBe("listed");
    expect(result.connectionIds).toEqual(["conn_1", "conn_2"]);
    expect(deps.listScopeConnectionIds).not.toHaveBeenCalled();
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
      { name: "ops", scopeMode: "listed", connectionIds: ["conn_1", "conn_other"] },
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
    expect(output.connectedVia).toBeNull();
  });

  it("carries the connecting client as one field, and only when both halves are recorded", () => {
    expect(
      toAgentOutput({
        ...row,
        tokenHash: null,
        tokenPrefix: null,
        connectedViaClientId: "client_1",
        connectedViaClientName: "Claude",
      }),
    ).toMatchObject({
      tokenPrefix: null,
      connectedVia: { clientId: "client_1", clientName: "Claude" },
    });
    expect(toAgentOutput({ ...row, connectedViaClientId: "client_1" }).connectedVia).toBeNull();
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

describe("archiveAgent", () => {
  it("archives and revokes OAuth tokens through the same transaction handle", async () => {
    const deps = fakeDeps();
    const result = await archiveAgent(ctx, PRINCIPAL, row.id, deps);
    expect(result).toMatchObject({ id: row.id, revokedAt: NOW, archivedAt: NOW });
    expect(result).not.toHaveProperty("tokenHash");
    expect(deps.archiveAgent).toHaveBeenCalledWith(fakeDb, PRINCIPAL.personId, row.id, NOW);
    expect(deps.revokeMcpTokensForAgent).toHaveBeenCalledWith(
      fakeDb,
      { personId: PRINCIPAL.personId, agentId: row.id },
      NOW,
    );
  });

  it("returns the first archive on retry, without moving its timestamps", async () => {
    const archived = { ...row, archivedAt: NOW, revokedAt: new Date("2026-09-01T00:00:00Z") };
    const deps = fakeDeps({
      archiveAgent: vi.fn(async () => null),
      findAgent: vi.fn(async () => archived),
    });
    expect(await archiveAgent(ctx, PRINCIPAL, row.id, deps)).toMatchObject({
      id: row.id,
      archivedAt: NOW,
      revokedAt: archived.revokedAt,
    });
    expect(deps.revokeMcpTokensForAgent).not.toHaveBeenCalled();
  });

  it("returns nothing for a missing or foreign agent and touches no OAuth tokens", async () => {
    const deps = fakeDeps({
      archiveAgent: vi.fn(async () => null),
      findAgent: vi.fn(async () => null),
    });
    expect(await archiveAgent(ctx, PRINCIPAL, "foreign", deps)).toBeNull();
    expect(deps.findAgent).toHaveBeenCalledWith(fakeDb, PRINCIPAL.personId, "foreign");
    expect(deps.revokeMcpTokensForAgent).not.toHaveBeenCalled();
  });

  it("propagates a token revoke failure so the transaction can roll back", async () => {
    const deps = fakeDeps({
      revokeMcpTokensForAgent: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });
    await expect(archiveAgent(ctx, PRINCIPAL, row.id, deps)).rejects.toThrow("unavailable");
  });
});

describe("revokeAgent", () => {
  it("stamps the clock's moment under the person, and revokes every MCP client's tokens in the same transaction", async () => {
    const deps = fakeDeps();
    const result = await revokeAgent(ctx, PRINCIPAL, "agent_1", deps);
    expect(deps.revokeAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", NOW);
    expect(deps.revokeMcpTokensForAgent).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      NOW,
    );
    expect(result?.revokedAt).toEqual(NOW);
  });

  it("touches no token when there is no such agent, or it is revoked already", async () => {
    const deps = fakeDeps({ revokeAgent: vi.fn(async () => null) });
    await expect(revokeAgent(ctx, PRINCIPAL, "missing", deps)).resolves.toBeNull();
    expect(deps.revokeMcpTokensForAgent).not.toHaveBeenCalled();
  });
});

/** ADR 0018: the consent mints an agent with no static token and the client recorded as its origin. */
describe("createAgentForClient", () => {
  const via = { clientId: "client_1", clientName: "Claude" };

  it("inserts the row with null token columns and the client as its origin, and answers no token", async () => {
    const deps = fakeDeps();
    const result = await createAgentForClient(
      ctx,
      PRINCIPAL,
      { name: "Claude", scopeMode: "listed", connectionIds: ["conn_1"], connectedVia: via },
      deps,
    );
    const inserted = vi.mocked(deps.insertAgent).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({
      id: "agent_new",
      personId: "person_1",
      name: "Claude",
      tokenHash: null,
      tokenPrefix: null,
      connectedViaClientId: "client_1",
      connectedViaClientName: "Claude",
    });
    expect(result).not.toHaveProperty("token");
    expect(result.agent.tokenPrefix).toBeNull();
    expect(result.agent.connectedVia).toEqual(via);
    expect(result.connectionIds).toEqual(["conn_1"]);
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_new" },
      ["conn_1"],
    );
  });

  it("starts on all connections by default, as the console's create does", async () => {
    const deps = fakeDeps();
    const result = await createAgentForClient(
      ctx,
      PRINCIPAL,
      { name: "Claude", connectedVia: via },
      deps,
    );
    expect(vi.mocked(deps.insertAgent).mock.calls[0]?.[1]?.scopeMode).toBe("all");
    expect(result.agent.scopeMode).toBe("all");
    expect(result.connectionIds).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
  });

  it("applies the same name and scope rules as the console's create", async () => {
    const deps = fakeDeps({ findConnectionsByIds: vi.fn(async () => []) });
    await expect(
      createAgentForClient(ctx, PRINCIPAL, { name: "  ", connectedVia: via }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createAgentForClient(
        ctx,
        PRINCIPAL,
        { name: "ok", scopeMode: "listed", connectionIds: ["conn_x"], connectedVia: via },
        deps,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.insertAgent).not.toHaveBeenCalled();
  });
});

describe("connectExistingAgentToClient", () => {
  const via = { clientId: "client_1", clientName: "Claude" };

  it("records the client on an agent that has no origin yet, and answers the agent", async () => {
    const deps = fakeDeps();
    const result = await connectExistingAgentToClient(ctx, PRINCIPAL, "agent_1", via, deps);
    expect(deps.setAgentConnectedVia).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", via);
    expect(result.connectedVia).toEqual(via);
    expect(result.tokenPrefix).toBe("grft_abc");
  });

  it("keeps the first origin when the row already has one", async () => {
    const already = {
      ...row,
      connectedViaClientId: "client_0",
      connectedViaClientName: "ChatGPT",
    };
    const deps = fakeDeps({
      findAgent: vi.fn(async () => already),
      setAgentConnectedVia: vi.fn(async () => null),
    });
    const result = await connectExistingAgentToClient(ctx, PRINCIPAL, "agent_1", via, deps);
    expect(result.connectedVia).toEqual({ clientId: "client_0", clientName: "ChatGPT" });
  });

  it("refuses an unknown agent as NOT_FOUND and a revoked one as BAD_REQUEST, writing nothing", async () => {
    const missing = fakeDeps({ findAgent: vi.fn(async () => null) });
    await expect(
      connectExistingAgentToClient(ctx, PRINCIPAL, "missing", via, missing),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.setAgentConnectedVia).not.toHaveBeenCalled();

    const revoked = fakeDeps({ findAgent: vi.fn(async () => ({ ...row, revokedAt: NOW })) });
    await expect(
      connectExistingAgentToClient(ctx, PRINCIPAL, "agent_1", via, revoked),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(revoked.setAgentConnectedVia).not.toHaveBeenCalled();
  });
});

describe("setAgentScope", () => {
  it("to listed: writes the mode and replaces the list under the scope pair once every id is confirmed the person's", async () => {
    const deps = fakeDeps();
    const result = await setAgentScope(
      ctx,
      PRINCIPAL,
      "agent_1",
      { mode: "listed", connectionIds: ["conn_2", "conn_1"] },
      deps,
    );
    expect(result.connectionIds).toEqual(["conn_2", "conn_1"]);
    expect(result.agent.scopeMode).toBe("listed");
    expect(deps.updateAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", {
      scopeMode: "listed",
    });
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_2", "conn_1"],
    );
  });

  /** ADR 0007 as amended 2026-09-19: the list is cleared, so nothing stale resurfaces on a later narrowing. */
  it("to all: writes the mode, clears the list, and answers every connection the person has", async () => {
    const deps = fakeDeps();
    const result = await setAgentScope(ctx, PRINCIPAL, "agent_1", { mode: "all" }, deps);
    expect(result.agent.scopeMode).toBe("all");
    expect(result.connectionIds).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(deps.updateAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", {
      scopeMode: "all",
    });
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      [],
    );
    expect(deps.findConnectionsByIds).not.toHaveBeenCalled();
  });

  it("to listed with no list: materialises the scope as it stands, so narrowing starts from what the agent had", async () => {
    const deps = fakeDeps({ findAgentForUpdate: vi.fn(async () => openRow) });
    const result = await setAgentScope(ctx, PRINCIPAL, "agent_1", { mode: "listed" }, deps);
    expect(result.connectionIds).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(result.agent.scopeMode).toBe("listed");
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_1", "conn_2", "conn_3"],
    );
    // The row is locked first and the scope read after it, inside the transaction — so a grant
    // racing this narrowing serialises on the row and the list is the scope as it commits
    // (Greptile on #88); a read before the transaction lost a connection made in between.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0] ?? Number.NaN;
    expect(deps.findAgent).not.toHaveBeenCalled();
    expect(deps.findAgentForUpdate).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1");
    expect(order(vi.mocked(deps.findAgentForUpdate))).toBeLessThan(
      order(vi.mocked(deps.listScopeConnectionIds)),
    );
    expect(order(vi.mocked(deps.listScopeConnectionIds))).toBeLessThan(
      order(vi.mocked(deps.updateAgent)),
    );
    expect(order(vi.mocked(deps.updateAgent))).toBeLessThan(
      order(vi.mocked(deps.replaceAgentConnections)),
    );
  });

  it("refuses an unknown agent before checking any connection", async () => {
    const deps = fakeDeps({ findAgentForUpdate: vi.fn(async () => null) });
    await expect(
      setAgentScope(ctx, PRINCIPAL, "missing", { mode: "listed", connectionIds: ["conn_1"] }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.findConnectionsByIds).not.toHaveBeenCalled();
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  it("leaves the old scope intact when an id is refused", async () => {
    const deps = fakeDeps({ findConnectionsByIds: vi.fn(async () => []) });
    await expect(
      setAgentScope(ctx, PRINCIPAL, "agent_1", { mode: "listed", connectionIds: ["conn_x"] }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });
});

describe("addConnectionToAgentScope", () => {
  /** The scope table as the primary key makes it: a set per agent, so a second insert of a pair is a no-op. */
  const scopeTable = (initial: readonly string[]) => {
    const rows = new Set(initial);
    return fakeDeps({
      addAgentConnection: vi.fn(async (_db, _scope, connectionId: string) => {
        rows.add(connectionId);
      }),
      listAgentConnectionIds: vi.fn(async () => [...rows].sort()),
    });
  };

  /** GRA-28: the agent that asked is given the connection it asked for, and keeps what it had. */
  it("adds the connection beside what is already there with one idempotent insert under the scope pair, once it is confirmed the person's — never a read and a rewrite of the list", async () => {
    const deps = scopeTable(["conn_1"]);
    const result = await addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(result.connectionIds).toEqual(["conn_1", "conn_2"]);
    expect(deps.findConnectionsByIds).toHaveBeenCalledWith(fakeDb, "person_1", ["conn_2"]);
    expect(deps.addAgentConnection).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "conn_2",
    );
    // The mode is read from the row locked, inside the transaction, before the insert — the same
    // lock a narrowing takes, so the two serialise (Greptile on #88).
    expect(deps.findAgent).not.toHaveBeenCalled();
    expect(deps.findAgentForUpdate).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1");
    expect(
      vi.mocked(deps.findAgentForUpdate).mock.invocationCallOrder[0] ?? Number.NaN,
    ).toBeLessThan(vi.mocked(deps.addAgentConnection).mock.invocationCallOrder[0] ?? Number.NaN);
    // The whole-list write is the agent page's (`setAgentScope`); a grant never makes it, so a
    // concurrent edit of the scope is not overwritten with a stale list (Greptile on #87).
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
  });

  it("adding a connection already in the scope leaves one row and changes nothing", async () => {
    const deps = scopeTable(["conn_1", "conn_2"]);
    const result = await addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(result.connectionIds).toEqual(["conn_1", "conn_2"]);
    expect(deps.addAgentConnection).toHaveBeenCalledTimes(1);
    const again = await addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(again.connectionIds).toEqual(["conn_1", "conn_2"]);
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
  });

  /** ADR 0007 as amended 2026-09-19: every grant-on-connect path is a no-op for an agent on `all`. */
  it("is a no-op for an agent on all — the connection is already in its scope — and still refuses a foreign id", async () => {
    const deps = fakeDeps({ findAgentForUpdate: vi.fn(async () => openRow) });
    const result = await addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(result.agent.scopeMode).toBe("all");
    expect(result.connectionIds).toEqual(["conn_1", "conn_2", "conn_3"]);
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.listAgentConnectionIds).not.toHaveBeenCalled();

    const foreign = fakeDeps({
      findAgentForUpdate: vi.fn(async () => openRow),
      findConnectionsByIds: vi.fn(async () => []),
    });
    await expect(
      addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_x", foreign),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an unknown agent and a connection that is not the person's, writing nothing", async () => {
    const noAgent = fakeDeps({ findAgentForUpdate: vi.fn(async () => null) });
    await expect(
      addConnectionToAgentScope(ctx, PRINCIPAL, "missing", "conn_1", noAgent),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(noAgent.addAgentConnection).not.toHaveBeenCalled();

    const foreign = fakeDeps({ findConnectionsByIds: vi.fn(async () => []) });
    await expect(
      addConnectionToAgentScope(ctx, PRINCIPAL, "agent_1", "conn_x", foreign),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { connectionIds: ["conn_x"] } });
    expect(foreign.addAgentConnection).not.toHaveBeenCalled();
  });
});
