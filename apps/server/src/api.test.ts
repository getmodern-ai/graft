import type { AgentDeps, ConnectionDeps } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
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

function harness(session: { user: { id: string } } | null) {
  const deps = { agent: agentDeps(), connection: connectionDeps() };
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
