import type { AgentDeps, ConnectionDeps, LedgerDeps, ToolDeps, WorkingSetDeps } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { VendorUsageRow } from "@graft/db/repo/usage";
import type { WorkingSetChangeRow, WorkingSetEntry } from "@graft/db/repo/working-set";
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

/** The one promoted tool `GET /agents/:id/working-set` answers, joined to its row as the repo does. */
const workingSetEntry: WorkingSetEntry = {
  agentId: "agent_1",
  toolId: "tool_1",
  promotedAt: NOW,
  lastUsedAt: null,
  promotedBy: "publish",
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
  tool: toolRow,
};

/** Two ledger lines the connection's recent-calls view reads: a tool of the vendor, and its execute tool. */
const usageRows: VendorUsageRow[] = [
  {
    id: "usage_2",
    agentId: "agent_1",
    agentName: "laptop Hermes",
    toolId: null,
    versionId: null,
    toolName: "execute__conn_1",
    outcome: "error",
    dryRun: false,
    latencyMs: 40,
    owner: "person",
    createdAt: new Date("2026-10-01T10:00:00Z"),
  },
  {
    id: "usage_1",
    agentId: "agent_1",
    agentName: "laptop Hermes",
    toolId: "tool_1",
    versionId: "ver_1",
    toolName: "demo__list-orders",
    outcome: "ok",
    dryRun: true,
    latencyMs: 120,
    owner: "person",
    createdAt: NOW,
  },
];

function ledgerDeps(): LedgerDeps {
  return {
    insertUsage: unused(),
    listUsage: vi.fn(async () => []),
    listUsageForVendor: vi.fn(async (_db, _person, args) => usageRows.slice(0, args.limit)),
    lastUsedAtByTool: vi.fn(async () => []),
    newId: () => "usage_new",
    now: () => NOW,
  };
}

function workingSetDeps(): WorkingSetDeps {
  return {
    listWorkingSet: vi.fn(async () => [workingSetEntry]),
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

function harness(session: { user: { id: string } } | null) {
  const deps = {
    agent: agentDeps(),
    connection: connectionDeps(),
    workingSet: workingSetDeps(),
    tool: toolDeps(),
    ledger: ledgerDeps(),
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

describe("the working set", () => {
  /** GRA-26: the console's working-set view is the promoted tools with their rows, under the pair. */
  it("answers each promoted tool with its row, and never the code", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/agents/agent_1/working-set");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workingSet: [
        {
          toolId: "tool_1",
          promotedAt: NOW.toISOString(),
          lastUsedAt: null,
          promotedBy: "publish",
          tool: {
            id: "tool_1",
            vendor: "demo",
            name: "list-orders",
            description: "Lists orders",
            readOnly: true,
            destructive: false,
            defaultConnectionId: "conn_1",
            currentVersionId: null,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        },
      ],
    });
    expect(deps.workingSet.listWorkingSet).toHaveBeenCalledWith(fakeDb, {
      personId: "person_1",
      agentId: "agent_1",
    });
  });

  it("answers 404 for an agent that is not the person's, before any read", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.agent.findAgent).mockResolvedValueOnce(null);
    const res = await app.request("/api/agents/agent_x/working-set");
    expect(res.status).toBe(404);
    expect(deps.workingSet.listWorkingSet).not.toHaveBeenCalled();
  });

  it("lists the toolbox — the pointer rows with their annotations, nothing of the module", async () => {
    const { app } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Record<string, unknown>[] };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      id: "tool_1",
      vendor: "demo",
      name: "list-orders",
      readOnly: true,
      destructive: false,
      defaultConnectionId: "conn_1",
    });
    expect(body.tools[0]).not.toHaveProperty("inputSchema");
    expect(body.tools[0]).not.toHaveProperty("personId");
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

  /** GRA-26: recent vendor calls come from the ledger, under the person, by vendor and execute name. */
  it("answers a connection's recent calls with the agent's name, newest first", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/connections/conn_1/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      calls: [
        {
          id: "usage_2",
          agentId: "agent_1",
          agentName: "laptop Hermes",
          toolId: null,
          toolName: "execute__conn_1",
          outcome: "error",
          dryRun: false,
          latencyMs: 40,
          createdAt: "2026-10-01T10:00:00.000Z",
        },
        {
          id: "usage_1",
          agentId: "agent_1",
          agentName: "laptop Hermes",
          toolId: "tool_1",
          toolName: "demo__list-orders",
          outcome: "ok",
          dryRun: true,
          latencyMs: 120,
          createdAt: NOW.toISOString(),
        },
      ],
    });
    expect(deps.ledger.listUsageForVendor).toHaveBeenCalledWith(fakeDb, "person_1", {
      vendor: "demo",
      toolNames: ["execute__conn_1"],
      limit: 50,
    });
  });

  it("takes ?limit= on the calls, refuses one out of range, and 404s a connection that is not the person's", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const one = await app.request("/api/connections/conn_1/usage?limit=1");
    expect(((await one.json()) as { calls: unknown[] }).calls).toHaveLength(1);

    for (const bad of ["0", "501", "many"]) {
      const res = await app.request(`/api/connections/conn_1/usage?limit=${bad}`);
      expect(res.status, bad).toBe(400);
    }

    vi.mocked(deps.connection.findConnection).mockResolvedValueOnce(null);
    const missing = await app.request("/api/connections/conn_x/usage");
    expect(missing.status).toBe(404);
    expect(deps.ledger.listUsageForVendor).toHaveBeenCalledTimes(1);
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
