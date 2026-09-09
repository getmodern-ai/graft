import type {
  AgentDeps,
  ApprovalDeps,
  ConnectionDeps,
  PendingActionDeps,
  ToolDeps,
  WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { WorkingSetChangeRow } from "@graft/db/repo/working-set";
import { signHandoffToken } from "@graft/mcp";
import { initLogger } from "evlog";
import { describe, expect, it, vi } from "vitest";

import { createServer } from "./app";

/**
 * The JSON API's wire behaviour with fakes: a fake Better Auth that answers a session or none, and
 * fake repositories, so what is asserted is the transport — the session door, the status a
 * `ServiceError` maps to, what a body carries and what it must not — while the services' own rules
 * are proved in `@graft/core`. The database-backed run of the same routes is
 * `database.integration.test.ts`.
 */

initLogger({ silent: true });

const NOW = new Date("2026-09-09T10:00:00Z");

const agentRow: AgentRow = {
  id: "agent_1",
  personId: "person_1",
  name: "laptop Hermes",
  tokenHash: "the-hash",
  tokenPrefix: "grft_abc",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const connectionRow: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  vendor: "demo",
  displayName: "Demo",
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-demo-key" },
  primaryHost: "https://api.demo.example",
  hosts: ["api.demo.example"],
  credentialCiphertext: null,
  credentialSetAt: null,
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthAuthorizeUrl: null,
  oauthTokenUrl: null,
  oauthScopes: null,
  oauthRefreshState: null,
  revokedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const HANDOFF = {
  consoleUrl: "http://console.graft.test/app",
  secret: "api-test-handoff-secret-that-is-long-enough-32",
};

const destructiveTool = {
  id: "tool_1",
  personId: "person_1",
  vendor: "demo",
  name: "delete-item",
  description: "Deletes an item.",
  readOnly: false,
  destructive: true,
} as AuthoredToolRow;

const openAction: PendingActionRow = {
  id: "pa_1",
  agentId: "agent_1",
  kind: "tool",
  payload: {
    toolId: "tool_1",
    toolName: "demo__delete-item",
    vendor: "demo",
    description: "Deletes an item.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    connectionId: "conn_1",
    connectionName: "Demo",
    hosts: ["api.demo.example"],
  },
  expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  answeredAt: null,
  answer: null,
  consumedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const buildAction: PendingActionRow = {
  ...openAction,
  id: "pa_2",
  kind: "build",
  payload: { connectionId: "conn_1", vendor: "demo", connectionName: "Demo", hosts: [] },
};

const approvalRow: ApprovalRow = {
  agentId: "agent_1",
  toolId: "tool_1",
  decision: "allow",
  decidedAt: NOW,
  perCallRelaxed: false,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const buildApprovalRow: BuildApprovalRow = {
  agentId: "agent_1",
  connectionId: "conn_1",
  grantedAt: NOW,
  owner: "person",
  createdAt: NOW,
};

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };

function agentDeps(): AgentDeps {
  return {
    insertAgent: vi.fn(async (_db, input) => ({ ...agentRow, ...input }) as AgentRow),
    findAgent: vi.fn(async () => agentRow),
    findAgentByTokenHash: vi.fn(async () => agentRow),
    listAgents: vi.fn(async () => [agentRow]),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => ({ ...agentRow, ...patch })),
    revokeAgent: vi.fn(async () => ({ ...agentRow, revokedAt: NOW })),
    replaceAgentConnections: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => ["conn_1"]),
    findConnectionsByIds: vi.fn(async (_db, _p, ids: readonly string[]) =>
      ids.map((id) => ({ ...connectionRow, id })),
    ),
    listAllActiveAgents: vi.fn(async () => [agentRow]),
    newId: () => "agent_new",
    now: () => NOW,
  };
}

function connectionDeps(): ConnectionDeps {
  return {
    insertConnection: vi.fn(
      async (_db, input) => ({ ...connectionRow, ...input }) as ConnectionRow,
    ),
    findConnection: vi.fn(async () => connectionRow),
    findConnectionByIdUnscoped: vi.fn(async () => connectionRow),
    listConnections: vi.fn(async () => [connectionRow]),
    setConnectionCredential: vi.fn(async (_db, _p, _id, args) => ({
      ...connectionRow,
      credentialCiphertext: args.ciphertext,
      credentialSetAt: args.setAt,
    })),
    revokeConnection: vi.fn(async () => ({ ...connectionRow, revokedAt: NOW })),
    deleteApprovalsForVendor: vi.fn(async () => []),
    deleteBuildApprovalsForConnection: vi.fn(async () => []),
    vault: { encrypt: vi.fn(async () => Buffer.from("ciphertext")) },
    newId: () => "conn_new",
    now: () => NOW,
  };
}

const toolRow: AuthoredToolRow = {
  id: "tool_1",
  personId: "person_1",
  vendor: "demo",
  name: "list-orders",
  description: "Lists orders",
  inputSchema: { type: "object", properties: {} },
  currentVersionId: null,
  readOnly: true,
  destructive: false,
  defaultConnectionId: "conn_1",
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

/** Newest first, as the repo answers: the rule's demotion, then the promotion it undid. */
const changeRows: WorkingSetChangeRow[] = [
  {
    id: "change_2",
    agentId: "agent_1",
    toolId: "tool_1",
    change: "demote",
    cause: "idle",
    owner: "person",
    createdAt: new Date("2026-10-01T10:00:00Z"),
  },
  {
    id: "change_1",
    agentId: "agent_1",
    toolId: "tool_1",
    change: "promote",
    cause: "publish",
    owner: "person",
    createdAt: NOW,
  },
];

/** A dependency this suite never reaches: reaching it is the bug the fake should name. */
const unused = () =>
  vi.fn(async (): Promise<never> => {
    throw new Error("not reached in this suite");
  });

function workingSetDeps(): WorkingSetDeps {
  return {
    listWorkingSet: vi.fn(async () => []),
    findWorkingSetEntry: vi.fn(async () => null),
    countWorkingSet: vi.fn(async () => 0),
    insertWorkingSetEntry: unused(),
    deleteWorkingSetEntry: unused(),
    touchWorkingSetUsed: unused(),
    insertWorkingSetChange: unused(),
    listWorkingSetChanges: vi.fn(async (_db, _scope, limit: number) => changeRows.slice(0, limit)),
    findAuthoredToolById: vi.fn(async () => toolRow),
    newId: () => "change_new",
    now: () => NOW,
  };
}

function toolDeps(): ToolDeps {
  return {
    insertAuthoredTool: unused(),
    findAuthoredTool: vi.fn(async () => toolRow),
    findAuthoredToolById: vi.fn(async () => toolRow),
    listAuthoredTools: vi.fn(async () => [toolRow]),
    updateAuthoredTool: unused(),
    insertToolVersion: unused(),
    listToolVersions: vi.fn(async () => []),
    findToolVersion: vi.fn(async () => null),
    setCurrentToolVersion: unused(),
    recordToolVersionDryRun: unused(),
    findConnection: vi.fn(async () => connectionRow),
    newId: () => "tool_new",
    now: () => NOW,
  };
}

function approvalDeps(): ApprovalDeps {
  return {
    findApproval: vi.fn(async () => approvalRow),
    listApprovals: vi.fn(async () => [approvalRow]),
    upsertApproval: vi.fn(async (_db, input) => ({ ...approvalRow, ...input }) as ApprovalRow),
    relaxApproval: vi.fn(async () => ({ ...approvalRow, perCallRelaxed: true })),
    deleteApproval: vi.fn(async () => approvalRow),
    findBuildApproval: vi.fn(async () => null),
    insertBuildApproval: vi.fn(async () => buildApprovalRow),
    findAuthoredToolById: vi.fn(async () => destructiveTool),
    findConnection: vi.fn(async () => connectionRow),
    now: () => NOW,
  };
}

function pendingActionDeps(): PendingActionDeps {
  return {
    insertPendingAction: vi.fn(async (_db, input) => ({ ...openAction, ...input }) as never),
    findPendingAction: vi.fn(async () => openAction),
    findPendingActionForPerson: vi.fn(async () => openAction),
    listOpenPendingActions: vi.fn(async () => [openAction, buildAction]),
    answerPendingAction: vi.fn(async (_db, _p, _id, args) => ({
      ...openAction,
      answer: args.answer,
      answeredAt: args.answeredAt,
    })),
    consumePendingAction: vi.fn(async () => null),
    newId: () => "pa_new",
    now: () => NOW,
  };
}

function harness(session: { user: { id: string } } | null) {
  const deps = {
    agent: agentDeps(),
    connection: connectionDeps(),
    workingSet: workingSetDeps(),
    tool: toolDeps(),
    approval: approvalDeps(),
    pendingAction: pendingActionDeps(),
  };
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth", { status: 200 }),
        getSession: async () => session,
      },
      deps: { db: fakeDb as unknown as DbOrTx, ...deps },
      corsOrigins: ["http://localhost:3001"],
      handoff: HANDOFF,
    },
  });
  return { app, deps };
}

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("the session door", () => {
  it("answers 401 UNAUTHORIZED without a session, on every person route", async () => {
    const { app } = harness(null);
    for (const [path, init] of [
      ["/api/me", undefined],
      ["/api/agents", undefined],
      ["/api/agents", json({ name: "x" })],
      ["/api/connections", undefined],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ error: "UNAUTHORIZED" });
    }
  });

  it("hands Better Auth's routes to its handler", async () => {
    const { app } = harness(null);
    const res = await app.request("/api/auth/get-session");
    expect(await res.text()).toBe("auth");
  });

  it("answers the console's origin with CORS headers, and the proxy without", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const api = await app.request("/api/me", { headers: { origin: "http://localhost:3001" } });
    expect(api.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
    expect(api.headers.get("access-control-allow-credentials")).toBe("true");

    const proxy = await app.request("/api/proxy/c/conn_1/items", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3001" },
    });
    expect(proxy.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("agents", () => {
  it("creates an agent, answering the token once, and never shows it again", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const created = await app.request(
      "/api/agents",
      json({ name: "laptop Hermes", connectionIds: ["conn_1"] }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; agent: Record<string, unknown> };
    expect(body.token.startsWith("grft_")).toBe(true);
    expect(body.agent).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(body.agent)).not.toContain(body.token);

    const listed = await app.request("/api/agents");
    const text = await listed.text();
    expect(text).not.toContain(body.token);
    expect(text).not.toContain("tokenHash");
    expect(text).toContain('"tokenPrefix":"grft_abc"');
  });

  it("maps a service refusal to its status and code", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const bad = await app.request("/api/agents", json({ name: "ok", workingSetCap: 0 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "BAD_REQUEST" });

    const shape = await app.request("/api/agents", json({ nope: true }));
    expect(shape.status).toBe(400);
    expect(await shape.json()).toMatchObject({
      error: "BAD_REQUEST",
      details: { issues: expect.any(Array) },
    });

    const notJson = await app.request("/api/agents", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("answers the agent with its scope, and 404 for one that is not the person's", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const found = await app.request("/api/agents/agent_1");
    expect(await found.json()).toMatchObject({
      agent: { id: "agent_1" },
      connectionIds: ["conn_1"],
    });

    vi.mocked(deps.agent.findAgent).mockResolvedValueOnce(null);
    const missing = await app.request("/api/agents/agent_x");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "NOT_FOUND", message: "Agent not found" });
  });

  it("replaces the scope and revokes", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const scoped = await app.request(
      "/api/agents/agent_1/scope",
      json({ connectionIds: ["conn_1", "conn_2"] }, "PUT"),
    );
    expect(scoped.status).toBe(200);
    expect(deps.agent.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_1", "conn_2"],
    );

    const revoked = await app.request("/api/agents/agent_1/revoke", { method: "POST" });
    expect(await revoked.json()).toMatchObject({ agent: { revokedAt: NOW.toISOString() } });
  });
});

describe("the working-set history", () => {
  /** GRA-24: every demotion has a recorded cause, and the console's history reads it. */
  it("answers each change with its cause and the tool by vendor and name, newest first", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/agents/agent_1/working-set/changes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changes: [
        {
          id: "change_2",
          change: "demote",
          cause: "idle",
          createdAt: "2026-10-01T10:00:00.000Z",
          tool: { id: "tool_1", vendor: "demo", name: "list-orders", description: "Lists orders" },
        },
        {
          id: "change_1",
          change: "promote",
          cause: "publish",
          createdAt: NOW.toISOString(),
          tool: { id: "tool_1", vendor: "demo", name: "list-orders", description: "Lists orders" },
        },
      ],
    });
    // The read is scoped by the pair, so another person's agent id answers nothing (ADR 0007).
    expect(deps.workingSet.listWorkingSetChanges).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      50,
    );
  });

  it("takes ?limit=, refuses one out of range, and answers 404 for an agent that is not the person's", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const one = await app.request("/api/agents/agent_1/working-set/changes?limit=1");
    expect(((await one.json()) as { changes: unknown[] }).changes).toHaveLength(1);

    for (const bad of ["0", "501", "many"]) {
      const res = await app.request(`/api/agents/agent_1/working-set/changes?limit=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: "BAD_REQUEST" });
    }

    vi.mocked(deps.agent.findAgent).mockResolvedValueOnce(null);
    const missing = await app.request("/api/agents/agent_x/working-set/changes");
    expect(missing.status).toBe(404);
    // Only the in-range request reached the read: a bad limit and a foreign agent stop before it.
    expect(deps.workingSet.listWorkingSetChanges).toHaveBeenCalledTimes(1);
  });

  it("needs a session", async () => {
    const { app } = harness(null);
    const res = await app.request("/api/agents/agent_1/working-set/changes");
    expect(res.status).toBe(401);
  });
});

describe("connections", () => {
  it("registers a connection and refuses a private host with the rule's sentence", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const base = {
      vendor: "demo",
      displayName: "Demo",
      scheme: "api_key_header",
      schemeConfig: { headerName: "x-demo-key" },
      primaryHost: "https://api.demo.example/",
    };
    const created = await app.request("/api/connections", json(base));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      connection: {
        primaryHost: "https://api.demo.example",
        hosts: ["api.demo.example"],
        credentialSetAt: null,
      },
    });

    const refused = await app.request(
      "/api/connections",
      json({ ...base, primaryHost: "https://169.254.169.254" }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "BAD_REQUEST",
      message: expect.stringContaining("not a public host"),
    });
  });

  /** GRA-6's acceptance criterion at the wire: the fields go in, and only the time comes out. */
  it("enters a credential and answers credentialSetAt and nothing of the credential", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/connections/conn_1/credential",
      json({ fields: { apiKey: "sk_live_1" } }, "PUT"),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`"credentialSetAt":"${NOW.toISOString()}"`);
    expect(text).not.toContain("sk_live_1");
    expect(text).not.toContain("iphertext");
    expect(deps.connection.vault.encrypt).toHaveBeenCalledWith(
      { apiKey: "sk_live_1" },
      { personId: "person_1", connectionId: "conn_1" },
    );
  });

  it("revokes, answering what was swept", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/connections/conn_1/revoke", { method: "POST" });
    expect(await res.json()).toMatchObject({
      connection: { revokedAt: NOW.toISOString() },
      approvalsDeleted: 0,
      buildApprovalsDeleted: 0,
    });
  });
});

describe("pending actions", () => {
  it("lists the open actions across the person's agents, each with the requesting agent and a signed link", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/pending-actions");
    expect(res.status).toBe(200);
    const { pendingActions } = (await res.json()) as { pendingActions: Record<string, unknown>[] };
    expect(pendingActions).toHaveLength(2);
    expect(pendingActions[0]).toMatchObject({
      id: "pa_1",
      kind: "tool",
      agent: { id: "agent_1", name: "laptop Hermes" },
      payload: { toolName: "demo__delete-item", annotations: { destructiveHint: true } },
      answeredAt: null,
    });
    const token = signHandoffToken(openAction, HANDOFF.secret);
    expect(pendingActions[0]?.url).toBe(`http://console.graft.test/app/pending/pa_1?t=${token}`);
  });

  it("answers one action by its signed link, and refuses a tampered, reused or expired link naming which", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const token = signHandoffToken(openAction, HANDOFF.secret);
    const ok = await app.request(`/api/pending-actions/pa_1?t=${token}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      pendingAction: { id: "pa_1", kind: "tool", agent: { name: "laptop Hermes" } },
    });

    const missing = await app.request("/api/pending-actions/pa_1");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({
      error: "FORBIDDEN",
      details: { reason: "tampered" },
    });
    const forged = await app.request(`/api/pending-actions/pa_1?t=${token.slice(0, -1)}A`);
    expect(forged.status).toBe(403);

    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce({
      ...openAction,
      answeredAt: NOW,
      consumedAt: NOW,
    });
    const reused = await app.request(`/api/pending-actions/pa_1?t=${token}`);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ details: { reason: "consumed" } });

    const expiredRow = { ...openAction, expiresAt: new Date(NOW.getTime() - 1) };
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(expiredRow);
    const expired = await app.request(
      `/api/pending-actions/pa_1?t=${signHandoffToken(expiredRow, HANDOFF.secret)}`,
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: "GONE", details: { reason: "expired" } });

    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(null);
    const unknown = await app.request(`/api/pending-actions/pa_x?t=${token}`);
    expect(unknown.status).toBe(404);
  });

  it("records an allow as the standing approval, relaxes a destructive tool when asked, and answers both rows", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.tool.findAuthoredToolById).mockResolvedValueOnce(destructiveTool);
    const res = await app.request(
      "/api/pending-actions/pa_1/answer",
      json({ allow: true, relax: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pendingAction: { id: "pa_1", answer: { allow: true, relax: true } },
      approval: { agentId: "agent_1", toolId: "tool_1", decision: "allow", perCallRelaxed: true },
    });
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "pa_1",
      {
        answer: { allow: true, relax: true },
        answeredAt: NOW,
      },
    );
    expect(deps.approval.upsertApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
    });
    expect(deps.approval.relaxApproval).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "tool_1",
    );
    // Relaxed, the row carries the whole yes, so the action is spent here.
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "pa_1",
      NOW,
    );
  });

  it("leaves a destructive tool's per-call yes for the agent's next call to take", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.tool.findAuthoredToolById).mockResolvedValueOnce(destructiveTool);
    const res = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      approval: { decision: "allow", perCallRelaxed: false },
    });
    expect(deps.pendingAction.consumePendingAction).not.toHaveBeenCalled();
  });

  it("spends a write tool's yes at once — the approval row is the whole answer", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(res.status).toBe(200);
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledTimes(1);
    expect(deps.approval.relaxApproval).not.toHaveBeenCalled();
  });

  it("tolerates the agent taking the answer between the two statements", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingAction).mockResolvedValueOnce({
      ...openAction,
      answeredAt: NOW,
      consumedAt: NOW,
    });
    const res = await app.request("/api/pending-actions/pa_1/answer", json({ allow: false }));
    expect(res.status).toBe(200);
  });

  it("records a decline as a standing deny, and never relaxes on a no", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/pending-actions/pa_1/answer",
      json({ allow: false, relax: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approval: { decision: "deny" } });
    expect(deps.approval.relaxApproval).not.toHaveBeenCalled();
    // A no is in the row in full, so the action is spent here too.
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledTimes(1);
  });

  it("grants the build approval on a build ask's allow, and writes nothing on its decline", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.answerPendingAction).mockImplementation(
      async (_db, _p, _id, args) => ({ ...buildAction, answer: args.answer, answeredAt: NOW }),
    );
    const yes = await app.request("/api/pending-actions/pa_2/answer", json({ allow: true }));
    expect(await yes.json()).toMatchObject({
      pendingAction: { id: "pa_2", kind: "build" },
      buildApproval: { agentId: "agent_1", connectionId: "conn_1" },
    });
    expect(deps.approval.insertBuildApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      connectionId: "conn_1",
      grantedAt: NOW,
    });

    const no = await app.request("/api/pending-actions/pa_2/answer", json({ allow: false }));
    const body = (await no.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("buildApproval");
    expect(body).not.toHaveProperty("approval");
    expect(deps.approval.upsertApproval).not.toHaveBeenCalled();
    // A build yes is in its row in full and was spent; a build decline records nothing and is left
    // for the agent's next call to read once.
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledTimes(1);
  });

  it("maps an answered or expired action to 409 and 410, and a bad body to 400", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.answerPendingAction).mockResolvedValueOnce(null);
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce({
      ...openAction,
      answeredAt: NOW,
    });
    const answered = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(answered.status).toBe(409);

    vi.mocked(deps.pendingAction.answerPendingAction).mockResolvedValueOnce(null);
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce({
      ...openAction,
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const expired = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(expired.status).toBe(410);

    const bad = await app.request("/api/pending-actions/pa_1/answer", json({ allow: "yes" }));
    expect(bad.status).toBe(400);
    expect(deps.approval.upsertApproval).not.toHaveBeenCalled();
  });
});

describe("approvals", () => {
  it("lists an agent's approvals, and demands the agent", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/approvals?agentId=agent_1");
    expect(await res.json()).toEqual({
      approvals: [expect.objectContaining({ toolId: "tool_1", decision: "allow" })],
    });
    expect(deps.approval.listApprovals).toHaveBeenCalledWith(fakeDb, {
      personId: "person_1",
      agentId: "agent_1",
    });
    const bare = await app.request("/api/approvals");
    expect(bare.status).toBe(400);
  });

  it("relaxes a destructive tool's per-call ask, and refuses a tool that is not destructive with 400", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const relaxed = await app.request("/api/approvals/tool_1/relax?agentId=agent_1", {
      method: "POST",
    });
    expect(relaxed.status).toBe(200);
    expect(await relaxed.json()).toMatchObject({ approval: { perCallRelaxed: true } });

    vi.mocked(deps.approval.findAuthoredToolById).mockResolvedValueOnce({
      ...destructiveTool,
      destructive: false,
    });
    const write = await app.request("/api/approvals/tool_1/relax?agentId=agent_1", {
      method: "POST",
    });
    expect(write.status).toBe(400);
  });

  it("withdraws an approval, answering the row it removed, and 404 when none stood", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const gone = await app.request("/api/approvals/tool_1?agentId=agent_1", { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toMatchObject({ approval: { toolId: "tool_1" } });
    expect(deps.approval.deleteApproval).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "tool_1",
    );

    vi.mocked(deps.approval.deleteApproval).mockResolvedValueOnce(null);
    const none = await app.request("/api/approvals/tool_1?agentId=agent_1", { method: "DELETE" });
    expect(none.status).toBe(404);
  });

  it("answers 401 without a session on every new route", async () => {
    const { app } = harness(null);
    for (const [path, init] of [
      ["/api/pending-actions", undefined],
      ["/api/pending-actions/pa_1?t=x", undefined],
      ["/api/pending-actions/pa_1/answer", json({ allow: true })],
      ["/api/approvals?agentId=agent_1", undefined],
      ["/api/approvals/tool_1/relax?agentId=agent_1", { method: "POST" }],
      ["/api/approvals/tool_1?agentId=agent_1", { method: "DELETE" }],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(401);
    }
  });
});
