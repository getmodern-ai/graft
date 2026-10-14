import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import { hashAgentToken } from "../tenancy";
import type { AgentDeps } from "./agent.deps";
import {
  addConnectionToAgentScope,
  connectExistingAgentToClient,
  createAgent,
  createAgentAwaitingHarness,
  createAgentForClient,
  issueAwaitingAgentToken,
  listAgents,
  removeConnectionFromAgentScope,
  revokeAgent,
  rotateAgentToken,
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
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

/** The same agent on `all` (ADR 0007 as amended 2026-09-19). */
const openRow: AgentRow = { ...row, scopeMode: "all" };

/** The same agent as Setup mints it (ADR 0024): no token and no client, so awaiting its harness. */
const awaitingRow: AgentRow = { ...row, tokenHash: null, tokenPrefix: null };

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
    listAgents: vi.fn(async () => [
      { ...row, workingSetCount: 0, connectionIds: [], lastActiveAt: null, hasRunTool: false },
    ]),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => ({ ...row, ...patch })),
    revokeAgent: vi.fn(async () => ({ ...row, revokedAt: NOW })),
    revokeMcpTokensForAgent: vi.fn(async () => 0),
    closePendingActionsForAgent: vi.fn(async () => []),
    issueAgentToken: vi.fn(async (_db, _p, _a, token) => ({ ...awaitingRow, ...token })),
    setAgentConnectedVia: vi.fn(async (_db, _p, _a, via) => ({
      ...row,
      connectedViaClientId: via.clientId,
      connectedViaClientName: via.clientName,
    })),
    replaceAgentConnections: vi.fn(async () => {}),
    addAgentConnection: vi.fn(async () => {}),
    removeAgentConnection: vi.fn(async () => {}),
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

describe("listAgents", () => {
  const ranAt = new Date("2026-10-01T10:00:00Z");
  const listed = (overrides: { lastActiveAt: Date | null; hasRunTool: boolean }) => ({
    ...row,
    id: "agent_2",
    scopeMode: "listed" as const,
    revokedAt: NOW,
    workingSetCount: 0,
    connectionIds: ["conn_b"],
    ...overrides,
  });
  const onAll = {
    ...row,
    workingSetCount: 2,
    connectionIds: ["conn_a", "conn_b"],
    lastActiveAt: null,
    hasRunTool: false,
  };

  it("carries each row's scope and last activity, folds hasRunTool from the rows with no second read, and keeps the row's flag off the agent", async () => {
    const deps = fakeDeps({
      listAgents: vi.fn(async () => [onAll, listed({ lastActiveAt: ranAt, hasRunTool: true })]),
    });
    const answer = await listAgents(ctx, PRINCIPAL, deps);
    expect(deps.listAgents).toHaveBeenCalledTimes(1);
    expect(deps.listAgents).toHaveBeenCalledWith(fakeDb, "person_1");
    expect(answer.hasRunTool).toBe(true);
    expect(
      answer.agents.map(({ id, scopeMode, connectionIds, lastActiveAt }) => ({
        id,
        scopeMode,
        connectionIds,
        lastActiveAt,
      })),
    ).toEqual([
      {
        id: row.id,
        scopeMode: row.scopeMode,
        connectionIds: ["conn_a", "conn_b"],
        lastActiveAt: null,
      },
      { id: "agent_2", scopeMode: "listed", connectionIds: ["conn_b"], lastActiveAt: ranAt },
    ]);
    expect(answer.agents[0]).not.toHaveProperty("tokenHash");
    expect(answer.agents[1]).not.toHaveProperty("hasRunTool");
  });

  it("answers hasRunTool false for an agent active only through refused or failed calls: activity is not a successful run", async () => {
    const deps = fakeDeps({
      listAgents: vi.fn(async () => [onAll, listed({ lastActiveAt: ranAt, hasRunTool: false })]),
    });
    const answer = await listAgents(ctx, PRINCIPAL, deps);
    expect(answer.agents[1]?.lastActiveAt).toEqual(ranAt);
    expect(answer.hasRunTool).toBe(false);
  });

  it("answers hasRunTool false for no agents", async () => {
    const none = fakeDeps({ listAgents: vi.fn(async () => []) });
    expect(await listAgents(ctx, PRINCIPAL, none)).toEqual({ agents: [], hasRunTool: false });
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

  /** GRA-292: so the Done list reads them as closed by the revoke, not as expired a day later. */
  it("closes the asks the agent left open, at the same moment and in the same transaction", async () => {
    const deps = fakeDeps();
    await revokeAgent(ctx, PRINCIPAL, "agent_1", deps);
    expect(deps.closePendingActionsForAgent).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      NOW,
    );
  });

  it("touches no token when there is no such agent, or it is revoked already", async () => {
    const deps = fakeDeps({ revokeAgent: vi.fn(async () => null) });
    await expect(revokeAgent(ctx, PRINCIPAL, "missing", deps)).resolves.toBeNull();
    expect(deps.revokeMcpTokensForAgent).not.toHaveBeenCalled();
    expect(deps.closePendingActionsForAgent).not.toHaveBeenCalled();
  });
});

/** ADR 0024: Setup mints its agent with no token and no client, awaiting its harness. */
describe("createAgentAwaitingHarness", () => {
  it("inserts the row with every token and origin column null, and answers no token", async () => {
    const deps = fakeDeps();
    const result = await createAgentAwaitingHarness(
      ctx,
      PRINCIPAL,
      { name: " Claude ", workingSetCap: 12, idleWindowDays: 7 },
      deps,
    );
    expect(vi.mocked(deps.insertAgent).mock.calls[0]?.[1]).toMatchObject({
      id: "agent_new",
      personId: "person_1",
      name: "Claude",
      tokenHash: null,
      tokenPrefix: null,
      connectedViaClientId: null,
      connectedViaClientName: null,
      scopeMode: "all",
      workingSetCap: 12,
      idleWindowDays: 7,
    });
    expect(result).not.toHaveProperty("token");
    expect(result.agent.tokenPrefix).toBeNull();
    expect(result.agent.connectedVia).toBeNull();
  });

  it("holds the limits to the same bounds as every other mint", async () => {
    await expect(
      createAgentAwaitingHarness(ctx, PRINCIPAL, { name: "Claude", workingSetCap: 0 }, fakeDeps()),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

/** ADR 0024 (GRA-208): the token Setup's finish step and *Connect an agent* issue, once. */
describe("issueAwaitingAgentToken", () => {
  it("mints once for an agent awaiting its harness and stores only the hash and the prefix", async () => {
    const deps = fakeDeps({ findAgent: vi.fn(async () => awaitingRow) });
    const result = await issueAwaitingAgentToken(ctx, PRINCIPAL, "agent_1", deps);
    expect(result.token.startsWith("grft_")).toBe(true);
    const written = vi.mocked(deps.issueAgentToken).mock.calls[0];
    expect(written?.slice(1, 3)).toEqual(["person_1", "agent_1"]);
    expect(written?.[3]).toEqual({
      tokenHash: hashAgentToken(result.token),
      tokenPrefix: result.token.slice(0, 8),
    });
    expect(result.agent.tokenPrefix).toBe(result.token.slice(0, 8));
  });

  it.each([
    ["revoked", { revokedAt: NOW }, /is revoked/],
    ["with a token", { tokenHash: "hash", tokenPrefix: "grft_abc" }, /already has a token/],
    [
      "connected by a client",
      { connectedViaClientId: "client_1", connectedViaClientName: "Claude" },
      /connected through Claude/,
    ],
  ])("refuses an agent %s before minting anything", async (_case, patch, message) => {
    const deps = fakeDeps({ findAgent: vi.fn(async () => ({ ...awaitingRow, ...patch })) });
    const refused = issueAwaitingAgentToken(ctx, PRINCIPAL, "agent_1", deps);
    await expect(refused).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(message),
      details: { reason: "agent_not_awaiting_harness" },
    });
    expect(deps.issueAgentToken).not.toHaveBeenCalled();
  });

  it("refuses when the guarded write matched nothing, and another person's agent as not found", async () => {
    const raced = fakeDeps({
      findAgent: vi.fn(async () => awaitingRow),
      issueAgentToken: vi.fn(async () => null),
    });
    await expect(issueAwaitingAgentToken(ctx, PRINCIPAL, "agent_1", raced)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const missing = fakeDeps({ findAgent: vi.fn(async () => null) });
    await expect(issueAwaitingAgentToken(ctx, PRINCIPAL, "agent_1", missing)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });
});

/** ADR 0007 as amended 2026-10-14 (GRA-306): an active static-token agent's token, replaced by hash. */
describe("rotateAgentToken", () => {
  it("mints a new token and writes its hash over the one it read, never a first issue", async () => {
    const deps = fakeDeps({
      issueAgentToken: vi.fn(async (_db, _p, _a, token) => ({ ...row, ...token })),
    });
    const result = await rotateAgentToken(ctx, PRINCIPAL, "agent_1", deps);
    expect(result.token.startsWith("grft_")).toBe(true);
    const written = vi.mocked(deps.issueAgentToken).mock.calls[0];
    expect(written?.slice(1, 3)).toEqual(["person_1", "agent_1"]);
    expect(written?.[3]).toEqual({
      tokenHash: hashAgentToken(result.token),
      tokenPrefix: result.token.slice(0, 8),
    });
    // The hash replaced is the one read, so the old token stops resolving the moment this lands.
    expect(written?.[4]).toBe(row.tokenHash);
    expect(result.agent.tokenPrefix).toBe(result.token.slice(0, 8));
    expect(JSON.stringify(result.agent)).not.toContain(result.token);
  });

  it.each([
    ["revoked", { revokedAt: NOW }, /is revoked/],
    [
      "connected by a client",
      { connectedViaClientId: "client_1", connectedViaClientName: "Claude" },
      /connected through Claude, which holds its own tokens/,
    ],
    ["awaiting its harness", { tokenHash: null, tokenPrefix: null }, /has no token yet/],
  ])("refuses an agent %s before minting anything", async (_case, patch, message) => {
    const deps = fakeDeps({ findAgent: vi.fn(async () => ({ ...row, ...patch })) });
    await expect(rotateAgentToken(ctx, PRINCIPAL, "agent_1", deps)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(message),
      details: { reason: "agent_token_not_rotatable" },
    });
    expect(deps.issueAgentToken).not.toHaveBeenCalled();
  });

  it("refuses when the guarded write matched nothing, and another person's agent as not found", async () => {
    const raced = fakeDeps({ issueAgentToken: vi.fn(async () => null) });
    await expect(rotateAgentToken(ctx, PRINCIPAL, "agent_1", raced)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "agent_token_not_rotatable" },
    });
    const missing = fakeDeps({ findAgent: vi.fn(async () => null) });
    await expect(rotateAgentToken(ctx, PRINCIPAL, "agent_1", missing)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(missing.issueAgentToken).not.toHaveBeenCalled();
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

describe("removeConnectionFromAgentScope", () => {
  /** GRA-294: under `listed`, one delete on the scope's key; the rest of the list stays. */
  it("under listed: deletes the one row under the scope pair once the connection is confirmed the person's, and answers the list", async () => {
    const deps = fakeDeps({ listAgentConnectionIds: vi.fn(async () => ["conn_1"]) });
    const result = await removeConnectionFromAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(result).toMatchObject({ connectionIds: ["conn_1"], materialised: false });
    expect(result.agent.scopeMode).toBe("listed");
    expect(deps.findConnectionsByIds).toHaveBeenCalledWith(fakeDb, "person_1", ["conn_2"]);
    expect(deps.removeAgentConnection).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "conn_2",
    );
    expect(deps.findAgentForUpdate).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1");
    expect(
      vi.mocked(deps.findAgentForUpdate).mock.invocationCallOrder[0] ?? Number.NaN,
    ).toBeLessThan(vi.mocked(deps.removeAgentConnection).mock.invocationCallOrder[0] ?? Number.NaN);
    expect(deps.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.updateAgent).not.toHaveBeenCalled();
  });

  /** ADR 0007 as amended 2026-09-19: turning one off under `all` narrows the agent, and says so. */
  it("under all: materialises listed with every connection the scope resolved to but this one, and answers materialised", async () => {
    const deps = fakeDeps({ findAgentForUpdate: vi.fn(async () => openRow) });
    const result = await removeConnectionFromAgentScope(ctx, PRINCIPAL, "agent_1", "conn_2", deps);
    expect(result).toMatchObject({ connectionIds: ["conn_1", "conn_3"], materialised: true });
    expect(result.agent.scopeMode).toBe("listed");
    expect(deps.updateAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", {
      scopeMode: "listed",
    });
    expect(deps.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_1", "conn_3"],
    );
    expect(deps.removeAgentConnection).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent and a connection that is not the person's, under either mode, writing nothing", async () => {
    const noAgent = fakeDeps({ findAgentForUpdate: vi.fn(async () => null) });
    await expect(
      removeConnectionFromAgentScope(ctx, PRINCIPAL, "missing", "conn_1", noAgent),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(noAgent.findConnectionsByIds).not.toHaveBeenCalled();

    for (const agentRow of [row, openRow]) {
      const foreign = fakeDeps({
        findAgentForUpdate: vi.fn(async () => agentRow),
        findConnectionsByIds: vi.fn(async () => []),
      });
      await expect(
        removeConnectionFromAgentScope(ctx, PRINCIPAL, "agent_1", "conn_x", foreign),
      ).rejects.toMatchObject({ code: "NOT_FOUND", details: { connectionIds: ["conn_x"] } });
      expect(foreign.removeAgentConnection).not.toHaveBeenCalled();
      expect(foreign.replaceAgentConnections).not.toHaveBeenCalled();
      expect(foreign.updateAgent).not.toHaveBeenCalled();
    }
  });
});

/**
 * The agent row's lock, held as Postgres holds `FOR UPDATE`: from `findAgentForUpdate` until the
 * transaction that took it ends. Each transaction gets its own handle, the writes land on one
 * in-memory agent, and `pause` holds a transaction between its locked read and its writes, so the
 * interleaving that would lose a connection is reached deterministically.
 */
function lockedWorld(initial: { mode: AgentRow["scopeMode"]; connections: string[] }) {
  const state = {
    mode: initial.mode,
    list: new Set<string>(),
    connections: [...initial.connections],
  };
  const log: string[] = [];
  type Tx = { name: string; release: () => void };
  const txOf = (db: unknown) => db as Tx;
  let tail: Promise<void> = Promise.resolve();
  let gate: Promise<void> | null = null;

  const ctxNamed = (name: string): ServiceContext =>
    ({
      db: {
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
          const tx: Tx = { name, release: () => {} };
          try {
            return await fn(tx);
          } finally {
            log.push(`${name}:commit`);
            tx.release();
          }
        },
      },
    }) as unknown as ServiceContext;

  const deps = fakeDeps({
    findAgentForUpdate: vi.fn(async (db) => {
      const tx = txOf(db);
      const before = tail;
      tail = new Promise<void>((release) => {
        tx.release = release;
      });
      await before;
      log.push(`${tx.name}:locked`);
      return { ...row, scopeMode: state.mode };
    }),
    findConnectionsByIds: vi.fn(async (_db, _p, ids: readonly string[]) =>
      ids.filter((id) => state.connections.includes(id)).map(connectionRow),
    ),
    listScopeConnectionIds: vi.fn(async () => {
      const resolved = state.mode === "all" ? [...state.connections] : [...state.list];
      if (gate) await gate;
      return resolved.sort();
    }),
    listAgentConnectionIds: vi.fn(async () => [...state.list].sort()),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => {
      if (patch.scopeMode) state.mode = patch.scopeMode;
      return { ...row, scopeMode: state.mode };
    }),
    replaceAgentConnections: vi.fn(async (_db, _scope, ids: readonly string[]) => {
      state.list = new Set(ids);
    }),
    addAgentConnection: vi.fn(async (db, _scope, id: string) => {
      log.push(`${txOf(db).name}:insert ${id}`);
      state.list.add(id);
    }),
    removeAgentConnection: vi.fn(async (_db, _scope, id: string) => {
      state.list.delete(id);
    }),
  });

  /** Hold every `listScopeConnectionIds` until the returned function is called. */
  const pause = () => {
    let open = () => {};
    gate = new Promise<void>((resolve) => {
      open = () => {
        gate = null;
        resolve();
      };
    });
    return open;
  };

  return { state, log, deps, ctx: ctxNamed, pause };
}

const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("one-connection scope writes serialise on the agent's row lock (GRA-294)", () => {
  /**
   * The race the lock closes: an agent on `all` has one connection turned off while another
   * connection is made and granted. The removal locks the row and reads the scope; the grant,
   * started meanwhile, waits on the lock rather than reading `all` and doing nothing, then finds
   * the agent on `listed` and writes its row, so the new connection is not lost.
   */
  it("a grant racing a materialising removal waits for it, sees listed, and keeps the new connection", async () => {
    const world = lockedWorld({ mode: "all", connections: ["conn_1", "conn_2", "conn_3"] });
    const open = world.pause();
    const removal = removeConnectionFromAgentScope(
      world.ctx("remove"),
      PRINCIPAL,
      "agent_1",
      "conn_2",
      world.deps,
    );
    await ticks();
    expect(world.log).toEqual(["remove:locked"]);

    // A connection made while the removal holds the lock, and the grant-on-connect after it.
    world.state.connections.push("conn_4");
    const grant = addConnectionToAgentScope(
      world.ctx("grant"),
      PRINCIPAL,
      "agent_1",
      "conn_4",
      world.deps,
    );
    await ticks();
    expect(world.log).toEqual(["remove:locked"]);

    open();
    const [removed, granted] = await Promise.all([removal, grant]);
    expect(world.log).toEqual([
      "remove:locked",
      "remove:commit",
      "grant:locked",
      "grant:insert conn_4",
      "grant:commit",
    ]);
    expect(removed).toMatchObject({ connectionIds: ["conn_1", "conn_3"], materialised: true });
    expect(granted.connectionIds).toEqual(["conn_1", "conn_3", "conn_4"]);
    expect(world.state.mode).toBe("listed");
    expect([...world.state.list].sort()).toEqual(["conn_1", "conn_3", "conn_4"]);
  });

  /** A whole-scope write started second lands whole after the removal, never interleaved with it. */
  it("setAgentScope to all started during a removal runs after it commits, and its answer stands", async () => {
    const world = lockedWorld({ mode: "all", connections: ["conn_1", "conn_2"] });
    const open = world.pause();
    const removal = removeConnectionFromAgentScope(
      world.ctx("remove"),
      PRINCIPAL,
      "agent_1",
      "conn_2",
      world.deps,
    );
    await ticks();
    const widen = setAgentScope(
      world.ctx("set"),
      PRINCIPAL,
      "agent_1",
      { mode: "all" },
      world.deps,
    );
    await ticks();
    expect(world.log).toEqual(["remove:locked"]);
    open();
    await Promise.all([removal, widen]);
    expect(world.log).toEqual(["remove:locked", "remove:commit", "set:locked", "set:commit"]);
    expect(world.state.mode).toBe("all");
    expect(world.state.list.size).toBe(0);
  });

  it("a removal started during setAgentScope to listed removes from the list that write committed", async () => {
    const world = lockedWorld({ mode: "all", connections: ["conn_1", "conn_2", "conn_3"] });
    const open = world.pause();
    const narrow = setAgentScope(
      world.ctx("set"),
      PRINCIPAL,
      "agent_1",
      { mode: "listed" },
      world.deps,
    );
    await ticks();
    const removal = removeConnectionFromAgentScope(
      world.ctx("remove"),
      PRINCIPAL,
      "agent_1",
      "conn_1",
      world.deps,
    );
    await ticks();
    expect(world.log).toEqual(["set:locked"]);
    open();
    const [, removed] = await Promise.all([narrow, removal]);
    expect(world.log).toEqual(["set:locked", "set:commit", "remove:locked", "remove:commit"]);
    expect(removed).toMatchObject({ connectionIds: ["conn_2", "conn_3"], materialised: false });
    expect([...world.state.list].sort()).toEqual(["conn_2", "conn_3"]);
  });
});
