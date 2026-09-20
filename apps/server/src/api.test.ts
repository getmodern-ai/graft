import {
  type AgentDeps,
  type ApprovalDeps,
  type ConnectionDeps,
  createGatewayProvider,
  DEFAULT_PROVIDERS,
  keyringProvider,
  type LedgerDeps,
  type PendingActionDeps,
  type ToolDeps,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import type { VendorUsageRow } from "@graft/db/repo/usage";
import type { WorkingSetChangeRow, WorkingSetEntry } from "@graft/db/repo/working-set";
import { signHandoffToken } from "@graft/mcp";
import type { Analytics, Capture } from "@graft/observability";
import { initLogger } from "evlog";
import { describe, expect, it, vi } from "vitest";

import { createServer } from "./app";
import { FAKE_MODEL_KEY_CIPHERTEXT, fakeModelKeyDeps } from "./testing/fake-model-key";

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

const connectionRow: ConnectionRow = {
  id: "conn_1",
  personId: "person_1",
  provider: "keyring",
  providerRef: null,
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
  providerReleaseFailedAt: null,
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
  connectionId: "conn_1",
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

/** An agent's ask to use a connection of the person's it was not given (GRA-104): `conn_2`, beside the `conn_1` its scope holds. */
const scopeAction: PendingActionRow = {
  ...openAction,
  id: "pa_3",
  kind: "scope",
  connectionId: "conn_2",
  payload: {
    connectionId: "conn_2",
    vendor: "demo",
    displayName: "Demo (other)",
    provider: "keyring",
    primaryHost: "https://api.demo.example",
    hosts: ["api.demo.example"],
    scheme: "api_key_header",
    docsUrl: null,
  },
};

const approvalRow: ApprovalRow = {
  agentId: "agent_1",
  toolId: "tool_1",
  decision: "allow",
  decidedAt: NOW,
  askEveryCall: false,
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
    findAgentForUpdate: vi.fn(async () => agentRow),
    findAgentByTokenHash: vi.fn(async () => agentRow),
    findAgentByMcpAccessTokenHash: vi.fn(async () => null),
    listAgents: vi.fn(async () => [agentRow]),
    updateAgent: vi.fn(async (_db, _p, _a, patch) => ({ ...agentRow, ...patch })),
    revokeAgent: vi.fn(async () => ({ ...agentRow, revokedAt: NOW })),
    revokeMcpTokensForAgent: vi.fn(async () => 0),
    listConnectedHarnesses: vi.fn(async () => []),
    setAgentConnectedVia: vi.fn(async () => agentRow),
    replaceAgentConnections: vi.fn(async () => {}),
    addAgentConnection: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => ["conn_1"]),
    listScopeConnectionIds: vi.fn(async () => ["conn_1"]),
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
    findConnectionForUpdate: vi.fn(async () => connectionRow),
    findConnectionByIdUnscoped: vi.fn(async () => connectionRow),
    listConnections: vi.fn(async () => [connectionRow]),
    setConnectionCredential: vi.fn(async (_db, _p, _id, args) => ({
      ...connectionRow,
      credentialCiphertext: args.ciphertext,
      credentialSetAt: args.setAt,
    })),
    setConnectionOAuthState: vi.fn(async (_db, _p, _id, state) => ({
      ...connectionRow,
      oauthRefreshState: state,
    })),
    setConnectionProviderRef: vi.fn(async (_db, _p, _id, providerRef) => ({
      ...connectionRow,
      providerRef,
      revokedAt: null,
    })),
    recordProviderRelease: vi.fn(async (_db, _p, _id, outcome) => ({
      ...connectionRow,
      revokedAt: NOW,
      ...(outcome.released
        ? { providerRef: null, providerReleaseFailedAt: null }
        : { providerReleaseFailedAt: outcome.at }),
    })),
    revokeConnection: vi.fn(async () => ({ ...connectionRow, revokedAt: NOW })),
    reconnectConnection: vi.fn(async () => ({ ...connectionRow, revokedAt: null })),
    addConnectionHosts: vi.fn(async (_db, _p, _id, hosts) => ({ ...connectionRow, hosts })),
    deleteApprovalsForVendor: vi.fn(async () => []),
    deleteBuildApprovalsForConnection: vi.fn(async () => []),
    expirePendingActionsForConnection: vi.fn(async () => []),
    deleteWorkingSetEntriesForConnection: vi.fn(async () => []),
    insertWorkingSetChange: vi.fn(async (_db, input) => input as never),
    // The person's `listed` agent holding the row, and an agent on `all` (ADR 0007 as amended 2026-09-19).
    listAgentIdsForConnection: vi.fn(async () => ["agent_1", "agent_open"]),
    vault: { encrypt: vi.fn(async () => Buffer.from("ciphertext")) },
    providers: DEFAULT_PROVIDERS,
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
    findConnectionForUpdate: vi.fn(async () => connectionRow),
    newId: () => "tool_new",
    now: () => NOW,
  };
}

function approvalDeps(): ApprovalDeps {
  return {
    findApproval: vi.fn(async () => approvalRow),
    listApprovals: vi.fn(async () => [approvalRow]),
    upsertApproval: vi.fn(async (_db, input) => ({ ...approvalRow, ...input }) as ApprovalRow),
    updateAskEveryCall: vi.fn(async (_db, _scope, _toolId, on) => ({
      ...approvalRow,
      askEveryCall: on,
    })),
    deleteApproval: vi.fn(async () => approvalRow),
    findBuildApproval: vi.fn(async () => null),
    insertBuildApproval: vi.fn(async () => buildApprovalRow),
    settleAnsweredToolActions: vi.fn(async () => []),
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

function harness(
  session: { user: { id: string } } | null,
  extra: Partial<Parameters<typeof createServer>[0]["api"]> = {},
) {
  const deps = {
    agent: agentDeps(),
    connection: connectionDeps(),
    workingSet: workingSetDeps(),
    tool: toolDeps(),
    ledger: ledgerDeps(),
    approval: approvalDeps(),
    pendingAction: pendingActionDeps(),
    modelKey: fakeModelKeyDeps({ now: () => NOW }),
  };
  // The process's `tools/list_changed` notifier as the API sees it (GRA-69): what a revoke tells.
  const notifier = { changed: vi.fn() };
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
      notifier,
      ...extra,
    },
  });
  return { app, deps, notifier };
}

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("the analytics chokepoint (GRA-100)", () => {
  const recorder = () => {
    const captured: Capture[] = [];
    const analytics: Analytics = {
      name: "recorder",
      capture: (input) => {
        captured.push(input);
      },
      shutdown: async () => undefined,
    };
    return { captured, analytics };
  };

  it("counts a tracked mutation that succeeded, on the session's person, and nothing else", async () => {
    const { captured, analytics } = recorder();
    const { app } = harness({ user: { id: "person_1" } }, { analytics });
    const created = await app.request("/api/agents", json({ name: "hermes" }));
    expect(created.status).toBe(201);
    await app.request("/api/agents");
    const refused = await app.request("/api/agents", json({}));
    expect(refused.status).toBe(400);
    expect(captured).toEqual([
      { distinctId: "person_1", event: "agent_created", properties: { via: "console" } },
    ]);
  });

  it("counts nothing without a session, and nothing at all under the open form's no-op", async () => {
    const { captured, analytics } = recorder();
    const { app } = harness(null, { analytics });
    expect((await app.request("/api/agents", json({ name: "hermes" }))).status).toBe(401);
    expect(captured).toEqual([]);
    const { app: open } = harness({ user: { id: "person_1" } });
    expect((await open.request("/api/agents", json({ name: "hermes" }))).status).toBe(201);
  });
});

describe("the session door", () => {
  it("answers 401 UNAUTHORIZED without a session, on every person route", async () => {
    const { app } = harness(null);
    for (const [path, init] of [
      ["/api/me", undefined],
      ["/api/me/model-key", undefined],
      ["/api/me/model-key", json({ provider: "openai", apiKey: "k" }, "PUT")],
      ["/api/me/model-key", { method: "DELETE" }],
      ["/api/agents", undefined],
      ["/api/agents", json({ name: "x" })],
      ["/api/connections", undefined],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ error: "UNAUTHORIZED" });
    }
  });

  it("answers the liveness probe without a session and nothing else about the deployment", async () => {
    const { app } = harness(null);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  /** The door paints a button per name here, so a self-host with no client shows the email form alone. */
  it("names the sign-in providers without a session — none unless the server was handed clients", async () => {
    const { app } = harness(null);
    const res = await app.request("/api/sign-in-methods");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ social: [] });
    const withGoogle = createServer({
      keys: null,
      vault: { decrypt: async () => ({}) },
      connections: { get: async () => null },
      followRedirects: false,
      api: {
        auth: {
          handler: async () => new Response("auth", { status: 200 }),
          getSession: async () => null,
        },
        deps: { db: fakeDb as unknown as DbOrTx, ...harness(null).deps },
        corsOrigins: [],
        signInMethods: { social: ["google"] },
        handoff: HANDOFF,
      },
    });
    expect(await (await withGoogle.request("/api/sign-in-methods")).json()).toEqual({
      social: ["google"],
    });
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
      json({ name: "laptop Hermes", scopeMode: "listed", connectionIds: ["conn_1"] }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; agent: Record<string, unknown> };
    expect(body.token.startsWith("grft_")).toBe(true);
    expect(body.agent.scopeMode).toBe("listed");
    expect(body.agent).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(body.agent)).not.toContain(body.token);

    const listed = await app.request("/api/agents");
    const text = await listed.text();
    expect(text).not.toContain(body.token);
    expect(text).not.toContain("tokenHash");
    expect(text).toContain('"tokenPrefix":"grft_abc"');
  });

  /** ADR 0007 as amended 2026-09-19: a body naming no mode makes an agent on every connection. */
  it("creates an agent on all connections when the body names no mode, writing no list and answering the resolved scope", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const created = await app.request("/api/agents", json({ name: "Claude" }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      agent: Record<string, unknown>;
      connectionIds: string[];
    };
    expect(body.agent.scopeMode).toBe("all");
    expect(body.connectionIds).toEqual(["conn_1"]);
    expect(vi.mocked(deps.agent.insertAgent).mock.calls[0]?.[1]?.scopeMode).toBe("all");
    expect(deps.agent.replaceAgentConnections).not.toHaveBeenCalled();

    // A list beside `all` is refused, and a mode outside the enum is the schema's 400.
    const both = await app.request(
      "/api/agents",
      json({ name: "Claude", scopeMode: "all", connectionIds: ["conn_1"] }),
    );
    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: "BAD_REQUEST" });
    const unknown = await app.request("/api/agents", json({ name: "Claude", scopeMode: "some" }));
    expect(unknown.status).toBe(400);
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

  it("answers the agent with its scope and connected harnesses, and 404 for one that is not the person's", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const connectedHarnesses = [
      { clientId: "client_claude", clientName: "Claude" },
      { clientId: "client_hermes", clientName: "Hermes" },
    ];
    vi.mocked(deps.agent.listConnectedHarnesses).mockResolvedValueOnce(connectedHarnesses);
    const found = await app.request("/api/agents/agent_1");
    expect(await found.json()).toMatchObject({
      agent: { id: "agent_1", scopeMode: "listed" },
      connectionIds: ["conn_1"],
      connectedHarnesses,
    });
    // The ids are the scope as it resolves for the agent's mode, in one statement (ADR 0007 as amended 2026-09-19).
    expect(deps.agent.listScopeConnectionIds).toHaveBeenCalledWith(fakeDb, {
      personId: "person_1",
      agentId: "agent_1",
    });
    expect(deps.agent.listConnectedHarnesses).toHaveBeenCalledWith(fakeDb, {
      personId: "person_1",
      agentId: "agent_1",
    });

    vi.mocked(deps.agent.findAgent).mockResolvedValueOnce(null);
    const missing = await app.request("/api/agents/agent_x");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "NOT_FOUND", message: "Agent not found" });
    expect(deps.agent.listConnectedHarnesses).toHaveBeenCalledTimes(1);
  });

  it("sets the scope to a list, to all connections, and refuses the old shape; and revokes", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const scoped = await app.request(
      "/api/agents/agent_1/scope",
      json({ mode: "listed", connectionIds: ["conn_1", "conn_2"] }, "PUT"),
    );
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({
      agent: { scopeMode: "listed" },
      connectionIds: ["conn_1", "conn_2"],
    });
    expect(deps.agent.updateAgent).toHaveBeenCalledWith(fakeDb, "person_1", "agent_1", {
      scopeMode: "listed",
    });
    expect(deps.agent.replaceAgentConnections).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      ["conn_1", "conn_2"],
    );

    // To all: the mode written, the list cleared, the resolved scope answered.
    const widened = await app.request("/api/agents/agent_1/scope", json({ mode: "all" }, "PUT"));
    expect(widened.status).toBe(200);
    expect(await widened.json()).toMatchObject({
      agent: { scopeMode: "all" },
      connectionIds: ["conn_1"],
    });
    expect(deps.agent.updateAgent).toHaveBeenLastCalledWith(fakeDb, "person_1", "agent_1", {
      scopeMode: "all",
    });
    expect(deps.agent.replaceAgentConnections).toHaveBeenLastCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      [],
    );

    // The shape before GRA-105 — a bare list — is the schema's 400, not a silent `listed`.
    const bare = await app.request(
      "/api/agents/agent_1/scope",
      json({ connectionIds: ["conn_1"] }, "PUT"),
    );
    expect(bare.status).toBe(400);

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
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    const base = {
      vendor: "demo",
      displayName: "Demo",
      scheme: "api_key_header",
      schemeConfig: { headerName: "x-demo-key" },
      primaryHost: "https://api.demo.example/",
    };
    const created = await app.request("/api/connections", json(base));
    expect(created.status).toBe(201);
    const made = (await created.json()) as { connection: { id: string } };
    expect(made).toMatchObject({
      connection: {
        // The keyring, named on the wire, when the body names no provider (ADR 0019).
        provider: "keyring",
        primaryHost: "https://api.demo.example",
        hosts: ["api.demo.example"],
        credentialSetAt: null,
      },
    });
    // The row is in the scope of every agent on `all` the moment it exists (ADR 0007 as amended
    // 2026-09-19), so every session whose scope reaches it hears `tools/list_changed` (Greptile on #88).
    expect(deps.connection.listAgentIdsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      made.connection.id,
    );
    expect(notifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent_1",
      "agent_open",
    ]);
    const unknown = await app.request("/api/connections", json({ ...base, provider: "broker" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      message: "No connection provider named broker is enabled on this deployment",
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
  it("enters a credential and answers credentialSetAt and nothing of the credential; a rotation on a live row tells no session", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
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
    expect(notifier.changed).not.toHaveBeenCalled();
  });

  /** A re-entry on a revoked row is its reconnection (ADR 0007): the execute tool returns to every list whose scope reaches it. */
  it("re-entering a credential on a revoked row tells every session whose scope reaches it", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.connection.findConnection).mockResolvedValueOnce({
      ...connectionRow,
      revokedAt: NOW,
    });
    const res = await app.request(
      "/api/connections/conn_1/credential",
      json({ fields: { apiKey: "sk_live_1" } }, "PUT"),
    );
    expect(res.status).toBe(200);
    expect(notifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent_1",
      "agent_open",
    ]);
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

  it("revokes, answering what was swept, and tells every live session whose list changed", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    // Agent 1 holds the connection in its scope; agent 2 had a tool bound to it promoted (GRA-69).
    deps.connection.listAgentIdsForConnection = vi.fn(async () => ["agent_1"]);
    deps.connection.deleteWorkingSetEntriesForConnection = vi.fn(async () => [
      { agentId: "agent_2", toolId: "tool_1" } as never,
    ]);
    const res = await app.request("/api/connections/conn_1/revoke", { method: "POST" });
    expect(await res.json()).toMatchObject({
      connection: { revokedAt: NOW.toISOString() },
      approvalsDeleted: 0,
      buildApprovalsDeleted: 0,
      pendingActionsExpired: 0,
      demoted: [{ agentId: "agent_2", toolId: "tool_1" }],
      affectedAgentIds: ["agent_1", "agent_2"],
    });
    expect(notifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual(["agent_1", "agent_2"]);
  });

  it("tells no session when the connection is not the person's", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    deps.connection.revokeConnection = vi.fn(async () => null);
    const res = await app.request("/api/connections/conn_x/revoke", { method: "POST" });
    expect(res.status).toBe(404);
    expect(notifier.changed).not.toHaveBeenCalled();
  });

  /** The way back for a revoked gateway row (ADR 0019, GRA-58); a keyring row's stays the credential re-entry. */
  it("reconnects a revoked gateway connection, and refuses a keyring one by naming its way back", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    const gateway = createGatewayProvider({
      hosts: ["api.demo.example"],
      upstreamUrl: "https://gateway.corp.example",
      headerName: "X-Deployment-Token",
      headerValue: "deployment-identity-secret-value",
    });
    deps.connection.providers = [gateway, keyringProvider];
    const gatewayRow: ConnectionRow = {
      ...connectionRow,
      id: "conn_g",
      provider: "gateway",
      scheme: "gateway",
      schemeConfig: {},
      revokedAt: NOW,
    };
    vi.mocked(deps.connection.findConnection).mockResolvedValue(gatewayRow);
    vi.mocked(deps.connection.reconnectConnection).mockResolvedValue({
      ...gatewayRow,
      revokedAt: null,
    });
    const res = await app.request("/api/connections/conn_g/reconnect", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connection: { id: "conn_g", provider: "gateway", revokedAt: null, credentialSetAt: null },
    });
    expect(deps.connection.reconnectConnection).toHaveBeenCalledWith(fakeDb, "person_1", "conn_g");
    // The execute tool returns to every list whose scope reaches the row, and those sessions hear it.
    expect(deps.connection.listAgentIdsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_g",
    );
    expect(notifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent_1",
      "agent_open",
    ]);

    vi.mocked(deps.connection.findConnection).mockResolvedValue({
      ...connectionRow,
      revokedAt: NOW,
    });
    const keyring = await app.request("/api/connections/conn_1/reconnect", { method: "POST" });
    expect(keyring.status).toBe(400);
    expect(await keyring.json()).toMatchObject({
      error: "BAD_REQUEST",
      message: expect.stringContaining("re-entering its credential"),
    });
  });

  it("refuses to register a connection under a relay scheme — that is a provider's to write", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/connections",
      json({
        vendor: "demo",
        displayName: "Demo",
        scheme: "gateway",
        primaryHost: "https://api.demo.example",
      }),
    );
    expect(res.status).toBe(400);
    expect(deps.connection.insertConnection).not.toHaveBeenCalled();
  });
});

describe("the connection handoff's submits (GRA-28)", () => {
  const connectionAction: PendingActionRow = {
    ...openAction,
    id: "pa_c",
    kind: "connection",
    connectionId: null,
    payload: {
      vendor: "acme",
      displayName: "Acme",
      scheme: "api_key_header",
      schemeConfig: { headerName: "x-acme-key" },
      primaryHost: "https://api.acme.example",
      hosts: ["api.acme.example"],
      docsUrl: null,
      note: "written by the agent's model",
    },
  };
  const credentialAction: PendingActionRow = {
    ...openAction,
    id: "pa_k",
    kind: "credential",
    connectionId: "conn_1",
    payload: {
      connectionId: "conn_1",
      vendor: "demo",
      connectionName: "Demo",
      scheme: "api_key_header",
      hosts: ["api.demo.example"],
      reason: "401",
      revoked: false,
    },
  };
  const submission = {
    vendor: "acme",
    displayName: "Acme Orders (production)",
    scheme: "api_key_header",
    schemeConfig: { headerName: "x-acme-key" },
    primaryHost: "https://api.acme.example/v1/",
    hosts: ["files.acme.example"],
    credential: { apiKey: "sk_live_1" },
  };

  /** The person edits the proposal, never its routing (ADR 0019): the row is the ask's provider's. */
  it("binds the row to the provider the ask was routed to and refuses a body naming another", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValue({
      ...connectionAction,
      payload: { ...connectionAction.payload, provider: "keyring" },
    });
    const refused = await app.request(
      "/api/pending-actions/pa_c/connection",
      json({ ...submission, provider: "broker" }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      message: expect.stringContaining("routed to the keyring provider"),
    });
    expect(deps.connection.insertConnection).not.toHaveBeenCalled();
  });

  it("creates the connection as edited, with its credential, gives it to the requesting agent, records the answer, and echoes nothing of the secret", async () => {
    const { app, deps, notifier } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(
      connectionAction,
    );
    // The reads and the write between the two statements answer the row just inserted, as the repo would.
    vi.mocked(deps.connection.findConnection).mockImplementation(async (_db, _p, id) => ({
      ...connectionRow,
      id,
    }));
    vi.mocked(deps.connection.setConnectionCredential).mockImplementation(
      async (_db, _p, id, args) => ({
        ...connectionRow,
        id,
        credentialCiphertext: args.ciphertext,
        credentialSetAt: args.setAt,
      }),
    );
    const res = await app.request("/api/pending-actions/pa_c/connection", json(submission));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain(`"credentialSetAt":"${NOW.toISOString()}"`);
    expect(text).toContain('"answer":{"connectionId":"conn_new"}');
    // Every session whose scope reaches the new row — the asking agent's and every agent on
    // `all` — hears `tools/list_changed`, not the asking agent's alone (Greptile on #88).
    expect(deps.connection.listAgentIdsForConnection).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "conn_new",
    );
    expect(notifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent_1",
      "agent_open",
    ]);
    expect(text).not.toContain("sk_live_1");
    expect(text).not.toContain("iphertext");

    expect(deps.connection.insertConnection).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        id: "conn_new",
        // The provider the ask was routed to — the keyring, for an ask recorded without one (ADR 0019).
        provider: "keyring",
        vendor: "acme",
        displayName: "Acme Orders (production)",
        primaryHost: "https://api.acme.example/v1",
        hosts: ["api.acme.example", "files.acme.example"],
      }),
    );
    expect(deps.connection.vault.encrypt).toHaveBeenCalledWith(
      { apiKey: "sk_live_1" },
      { personId: "person_1", connectionId: "conn_new" },
    );
    // The requesting agent's scope gains the connection and keeps what it had (ADR 0007): one
    // idempotent insert of the pair, never a rewrite of the list (Greptile on #87).
    expect(deps.agent.addAgentConnection).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "conn_new",
    );
    expect(deps.agent.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "pa_c",
      {
        answer: { connectionId: "conn_new" },
        answeredAt: NOW,
      },
    );
    // The secret reached the vault and nothing else.
    for (const fn of [
      deps.pendingAction.answerPendingAction,
      deps.connection.insertConnection,
      deps.connection.setConnectionCredential,
      deps.agent.addAgentConnection,
    ]) {
      expect(JSON.stringify(vi.mocked(fn).mock.calls)).not.toContain("sk_live_1");
    }
  });

  it("refuses a host that is not public as host_not_public, naming it, before anything is written", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(
      connectionAction,
    );
    const res = await app.request(
      "/api/pending-actions/pa_c/connection",
      json({ ...submission, hosts: ["169.254.169.254"] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "BAD_REQUEST",
      message: expect.stringContaining("not a public host"),
      details: { reason: "host_not_public", host: "169.254.169.254" },
    });
    expect(deps.connection.insertConnection).not.toHaveBeenCalled();
    expect(deps.connection.vault.encrypt).not.toHaveBeenCalled();
    expect(deps.pendingAction.answerPendingAction).not.toHaveBeenCalled();
  });

  it("refuses an answered, taken or expired action, one of another kind and an unknown one, before writing", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const find = vi.mocked(deps.pendingAction.findPendingActionForPerson);
    for (const [row, status] of [
      [{ ...connectionAction, answeredAt: NOW, answer: { connectionId: "conn_9" } }, 409],
      [{ ...connectionAction, consumedAt: NOW }, 409],
      [{ ...connectionAction, expiresAt: new Date(NOW.getTime() - 1) }, 410],
      [openAction, 400],
      [null, 404],
    ] as const) {
      find.mockResolvedValueOnce(row);
      const res = await app.request("/api/pending-actions/pa_c/connection", json(submission));
      expect(res.status, `${row?.kind ?? "none"}`).toBe(status);
    }
    // A credential ask refuses a connection submit, and the reverse.
    find.mockResolvedValueOnce(credentialAction);
    expect(
      (await app.request("/api/pending-actions/pa_k/connection", json(submission))).status,
    ).toBe(400);
    find.mockResolvedValueOnce(connectionAction);
    expect(
      (
        await app.request(
          "/api/pending-actions/pa_c/credential",
          json({ credential: { apiKey: "k" } }),
        )
      ).status,
    ).toBe(400);
    expect(deps.connection.insertConnection).not.toHaveBeenCalled();
    expect(deps.connection.vault.encrypt).not.toHaveBeenCalled();
  });

  it("re-enters a credential for a credential ask, records the connection on the answer, and touches no approval", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(
      credentialAction,
    );
    const res = await app.request(
      "/api/pending-actions/pa_k/credential",
      json({ credential: { apiKey: "sk_live_2" } }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`"credentialSetAt":"${NOW.toISOString()}"`);
    expect(text).toContain('"answer":{"connectionId":"conn_1"}');
    expect(text).not.toContain("sk_live_2");
    expect(deps.connection.vault.encrypt).toHaveBeenCalledWith(
      { apiKey: "sk_live_2" },
      { personId: "person_1", connectionId: "conn_1" },
    );
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "pa_k",
      {
        answer: { connectionId: "conn_1" },
        answeredAt: NOW,
      },
    );
    expect(deps.connection.insertConnection).not.toHaveBeenCalled();
    expect(deps.agent.replaceAgentConnections).not.toHaveBeenCalled();
    expect(deps.approval.upsertApproval).not.toHaveBeenCalled();
    expect(deps.approval.deleteApproval).not.toHaveBeenCalled();
  });

  /** The console's Add connection: the same form with no pending action behind it. */
  it("registers a connection with its credential in one call when the body carries one", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    // The read between the two writes answers the row just inserted — a bearer connection.
    vi.mocked(deps.connection.findConnection).mockImplementation(async (_db, _p, id) => ({
      ...connectionRow,
      id,
      scheme: "bearer",
      schemeConfig: {},
    }));
    const res = await app.request(
      "/api/connections",
      json({
        vendor: "acme",
        displayName: "Acme",
        scheme: "bearer",
        primaryHost: "https://api.acme.example",
        credential: { token: "tok_1" },
      }),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain(`"credentialSetAt":"${NOW.toISOString()}"`);
    expect(text).not.toContain("tok_1");
    expect(deps.connection.vault.encrypt).toHaveBeenCalledWith(
      { token: "tok_1" },
      { personId: "person_1", connectionId: "conn_new" },
    );
    expect(deps.pendingAction.answerPendingAction).not.toHaveBeenCalled();
  });

  /** The fakes answer the fixture row's id whatever they were given; the row just inserted is what the route reads back. */
  const answerTheRowJustInserted = (deps: ReturnType<typeof harness>["deps"]) => {
    vi.mocked(deps.connection.findConnection).mockImplementation(async (_db, _p, id) => ({
      ...connectionRow,
      id,
    }));
    vi.mocked(deps.connection.setConnectionCredential).mockImplementation(
      async (_db, _p, id, args) => ({
        ...connectionRow,
        id,
        credentialCiphertext: args.ciphertext,
        credentialSetAt: args.setAt,
      }),
    );
  };

  /**
   * GRA-75 (ADR 0008, amendment of 2026-09-18): the confirmation may record `acquire`'s build
   * approval for the asking agent, in the transaction that makes the connection.
   */
  it("records the asking agent's build approval with the new connection when approveBuild is on, and answers it", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(
      connectionAction,
    );
    answerTheRowJustInserted(deps);
    const res = await app.request(
      "/api/pending-actions/pa_c/connection",
      json({ ...submission, approveBuild: true }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toHaveProperty("buildApproval");
    // The asking agent and the connection just made — never another agent, never the person's.
    expect(deps.approval.insertBuildApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      connectionId: "conn_new",
      grantedAt: NOW,
    });
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "pa_c",
      {
        answer: { connectionId: "conn_new" },
        answeredAt: NOW,
      },
    );
  });

  it("records no build approval when approveBuild is off or absent", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const find = vi.mocked(deps.pendingAction.findPendingActionForPerson);
    answerTheRowJustInserted(deps);
    for (const body of [submission, { ...submission, approveBuild: false }]) {
      find.mockResolvedValueOnce(connectionAction);
      const res = await app.request("/api/pending-actions/pa_c/connection", json(body));
      expect(res.status).toBe(201);
      expect(await res.json()).not.toHaveProperty("buildApproval");
    }
    expect(deps.approval.insertBuildApproval).not.toHaveBeenCalled();
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledTimes(2);
  });

  /**
   * The grant runs inside the submit's transaction, before the answer. The fake `transaction` here
   * runs its body and cannot roll anything back — that is Postgres's — so what this proves is the
   * order: a grant that fails ends the request before the answer is recorded, and the agent's
   * waiting call is not told "connected" about a connection the database will not keep.
   */
  it("a build approval that cannot be written fails the submit before the answer is recorded", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValueOnce(
      connectionAction,
    );
    answerTheRowJustInserted(deps);
    vi.mocked(deps.approval.insertBuildApproval).mockRejectedValueOnce(new Error("no room"));
    const res = await app.request(
      "/api/pending-actions/pa_c/connection",
      json({ ...submission, approveBuild: true }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(deps.pendingAction.answerPendingAction).not.toHaveBeenCalled();
  });

  it("needs a session on both submits", async () => {
    const { app } = harness(null);
    for (const path of [
      "/api/pending-actions/pa_c/connection",
      "/api/pending-actions/pa_k/credential",
    ]) {
      const res = await app.request(path, json({ credential: {} }));
      expect(res.status, path).toBe(401);
    }
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

  it("records an allow as the standing approval and spends the action — a destructive tool's yes holds like a write's", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pendingAction: { id: "pa_1", answer: { allow: true } },
      approval: { agentId: "agent_1", toolId: "tool_1", decision: "allow", askEveryCall: false },
    });
    expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
      fakeDb,
      "person_1",
      "pa_1",
      { answer: { allow: true }, answeredAt: NOW },
    );
    expect(deps.approval.upsertApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
    });
    // The answer left the setting alone, so nothing was set.
    expect(deps.approval.updateAskEveryCall).not.toHaveBeenCalled();
    // The row carries the whole yes, so the action is spent here.
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "pa_1",
      NOW,
    );
  });

  it("turns ask-every-call on with the yes, in the same write, and leaves that per-call yes for the agent's next call to take", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/pending-actions/pa_1/answer",
      json({ allow: true, askEveryCall: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pendingAction: { answer: { allow: true, askEveryCall: true } },
      approval: { decision: "allow", askEveryCall: true },
    });
    expect(deps.approval.upsertApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
      askEveryCall: true,
    });
    // The answer route never takes the agent page's path, which would spend the very answer it
    // is leaving for the agent.
    expect(deps.approval.updateAskEveryCall).not.toHaveBeenCalled();
    expect(deps.approval.settleAnsweredToolActions).not.toHaveBeenCalled();
    expect(deps.pendingAction.consumePendingAction).not.toHaveBeenCalled();
  });

  it("turns ask-every-call off with the yes, and then spends the action — the row holds on its own", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/pending-actions/pa_1/answer",
      json({ allow: true, askEveryCall: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approval: { askEveryCall: false } });
    expect(deps.approval.upsertApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "allow",
      decidedAt: NOW,
      askEveryCall: false,
    });
    expect(deps.approval.updateAskEveryCall).not.toHaveBeenCalled();
    expect(deps.pendingAction.consumePendingAction).toHaveBeenCalledTimes(1);
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

  it("records a decline as a standing deny, and never touches the setting on a no", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const res = await app.request(
      "/api/pending-actions/pa_1/answer",
      json({ allow: false, askEveryCall: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approval: { decision: "deny" } });
    // The setting the body carried is not written with a no: the upsert names no `askEveryCall`.
    expect(deps.approval.upsertApproval).toHaveBeenCalledWith(fakeDb, {
      agentId: "agent_1",
      toolId: "tool_1",
      decision: "deny",
      decidedAt: NOW,
    });
    expect(deps.approval.updateAskEveryCall).not.toHaveBeenCalled();
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

  /**
   * The scope ask (GRA-104): the generic answer route, with the same body plus `approveBuild`.
   * A yes is the scope write the agent page's picker makes, then the build approval when asked for,
   * in the answer's transaction; a no writes nothing; either way the answer is left for the agent's
   * waiting call to take.
   */
  describe("a scope ask", () => {
    const answersScope = (deps: ReturnType<typeof harness>["deps"]) => {
      // The pre-read the lock order needs (the action, for the connection it names), then the answer.
      vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValue(scopeAction);
      vi.mocked(deps.pendingAction.answerPendingAction).mockImplementation(
        async (_db, _p, _id, args) => ({ ...scopeAction, answer: args.answer, answeredAt: NOW }),
      );
    };

    it("Allow with the build choice locks the connection first, then answers the ask, grows the scope by one idempotent insert and grants the build approval, in that order, and leaves the answer for the agent", async () => {
      const { app, deps } = harness({ user: { id: "person_1" } });
      answersScope(deps);
      vi.mocked(deps.agent.listAgentConnectionIds).mockResolvedValueOnce(["conn_1", "conn_2"]);
      const res = await app.request(
        "/api/pending-actions/pa_3/answer",
        json({ allow: true, approveBuild: true }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        pendingAction: { id: "pa_3", kind: "scope", answer: { allow: true, approveBuild: true } },
        connectionIds: ["conn_1", "conn_2"],
        // The fake's row (it answers `conn_1` whatever it is given); the insert below is the proof.
        buildApproval: { agentId: "agent_1" },
      });
      expect(deps.pendingAction.answerPendingAction).toHaveBeenCalledWith(
        fakeDb,
        "person_1",
        "pa_3",
        { answer: { allow: true, approveBuild: true }, answeredAt: NOW },
      );
      // The connection is read with the row locked (FOR UPDATE) before anything is written, so a
      // revoke — which locks the same row — serialises against this answer (Greptile on #87).
      expect(deps.connection.findConnectionForUpdate).toHaveBeenCalledWith(
        fakeDb,
        "person_1",
        "conn_2",
      );
      expect(deps.connection.findConnection).not.toHaveBeenCalled();
      // The scope write is one idempotent insert of the pair, never a read and a rewrite of the list.
      expect(deps.agent.addAgentConnection).toHaveBeenCalledWith(
        fakeDb,
        { personId: "person_1", agentId: "agent_1" },
        "conn_2",
      );
      expect(deps.agent.replaceAgentConnections).not.toHaveBeenCalled();
      expect(deps.approval.insertBuildApproval).toHaveBeenCalledWith(fakeDb, {
        agentId: "agent_1",
        connectionId: "conn_2",
        grantedAt: NOW,
      });
      // Lock, answer, scope, approval — the order the transaction takes them (as far as the fakes
      // show): the connection lock before the action's update, which is the revoke's order too, so
      // the two cannot deadlock (Greptile on #87).
      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder[0] ?? Number.NaN;
      expect(order(vi.mocked(deps.connection.findConnectionForUpdate))).toBeLessThan(
        order(vi.mocked(deps.pendingAction.answerPendingAction)),
      );
      expect(order(vi.mocked(deps.pendingAction.answerPendingAction))).toBeLessThan(
        order(vi.mocked(deps.agent.addAgentConnection)),
      );
      expect(order(vi.mocked(deps.agent.addAgentConnection))).toBeLessThan(
        order(vi.mocked(deps.approval.insertBuildApproval)),
      );
      // No tool approval is touched, and the answer is the agent's waiting call to take.
      expect(deps.approval.upsertApproval).not.toHaveBeenCalled();
      expect(deps.pendingAction.consumePendingAction).not.toHaveBeenCalled();
    });

    it("Allow with the choice off grows the scope and grants nothing else", async () => {
      const { app, deps } = harness({ user: { id: "person_1" } });
      answersScope(deps);
      vi.mocked(deps.agent.listAgentConnectionIds).mockResolvedValueOnce(["conn_1", "conn_2"]);
      const res = await app.request("/api/pending-actions/pa_3/answer", json({ allow: true }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ connectionIds: ["conn_1", "conn_2"] });
      expect(body).not.toHaveProperty("buildApproval");
      expect(deps.agent.addAgentConnection).toHaveBeenCalledTimes(1);
      expect(deps.approval.insertBuildApproval).not.toHaveBeenCalled();
    });

    it("Decline records the no and writes nothing else, and the agent's next call reads it", async () => {
      const { app, deps } = harness({ user: { id: "person_1" } });
      answersScope(deps);
      const res = await app.request(
        "/api/pending-actions/pa_3/answer",
        json({ allow: false, approveBuild: true }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        pendingAction: { answer: { allow: false, approveBuild: true } },
      });
      expect(body).not.toHaveProperty("connectionIds");
      expect(body).not.toHaveProperty("buildApproval");
      expect(deps.agent.addAgentConnection).not.toHaveBeenCalled();
      expect(deps.agent.replaceAgentConnections).not.toHaveBeenCalled();
      expect(deps.approval.insertBuildApproval).not.toHaveBeenCalled();
      expect(deps.pendingAction.consumePendingAction).not.toHaveBeenCalled();
    });

    it("a revoke that beat the answer closes the ask and refuses 409 connection_revoked, growing no scope", async () => {
      const { app, deps } = harness({ user: { id: "person_1" } });
      answersScope(deps);
      // The locked read is what sees the revoke: a revoke holds the same row lock, so this read
      // waits for it to commit and then reads the row as revoked.
      vi.mocked(deps.connection.findConnectionForUpdate).mockResolvedValueOnce({
        ...connectionRow,
        id: "conn_2",
        revokedAt: NOW,
      });
      const res = await app.request(
        "/api/pending-actions/pa_3/answer",
        json({ allow: true, approveBuild: true }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        details: { reason: "connection_revoked", connectionId: "conn_2" },
      });
      expect(deps.connection.expirePendingActionsForConnection).toHaveBeenCalledWith(
        fakeDb,
        "person_1",
        "conn_2",
        NOW,
      );
      // Seen before the action was touched: the revoke closed it, and no answer lands on it.
      expect(deps.pendingAction.answerPendingAction).not.toHaveBeenCalled();
      expect(deps.agent.addAgentConnection).not.toHaveBeenCalled();
      expect(deps.approval.insertBuildApproval).not.toHaveBeenCalled();
    });

    it("refuses approveBuild that is not a boolean as 400", async () => {
      const { app, deps } = harness({ user: { id: "person_1" } });
      const res = await app.request(
        "/api/pending-actions/pa_3/answer",
        json({ allow: true, approveBuild: "yes" }),
      );
      expect(res.status).toBe(400);
      expect(deps.pendingAction.answerPendingAction).not.toHaveBeenCalled();
    });
  });

  it("maps an answered or expired action to 409 and 410, and a bad body to 400", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    // The row is read twice on this path — once unlocked for the lock order, once for the refusal's
    // reason — so the fake answers the same row to both.
    vi.mocked(deps.pendingAction.answerPendingAction).mockResolvedValueOnce(null);
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValue({
      ...openAction,
      answeredAt: NOW,
    });
    const answered = await app.request("/api/pending-actions/pa_1/answer", json({ allow: true }));
    expect(answered.status).toBe(409);

    vi.mocked(deps.pendingAction.answerPendingAction).mockResolvedValueOnce(null);
    vi.mocked(deps.pendingAction.findPendingActionForPerson).mockResolvedValue({
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

  it("sets a tool's ask-every-call on and off, on a write as on a destructive tool, and refuses a read-only tool with 400", async () => {
    const { app, deps } = harness({ user: { id: "person_1" } });
    const on = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: true }, "PUT"),
    );
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ approval: { askEveryCall: true } });
    expect(deps.approval.updateAskEveryCall).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "tool_1",
      true,
    );
    // A per-call yes left waiting for the agent was given under the old setting, and is spent.
    expect(deps.approval.settleAnsweredToolActions).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "tool_1",
      NOW,
    );

    const off = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: false }, "PUT"),
    );
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ approval: { askEveryCall: false } });

    vi.mocked(deps.approval.findAuthoredToolById).mockResolvedValueOnce({
      ...destructiveTool,
      destructive: false,
    });
    const write = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: true }, "PUT"),
    );
    expect(write.status).toBe(200);

    vi.mocked(deps.approval.findAuthoredToolById).mockResolvedValueOnce({
      ...destructiveTool,
      destructive: false,
      readOnly: true,
    });
    const read = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: true }, "PUT"),
    );
    expect(read.status).toBe(400);

    const malformed = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: "yes" }, "PUT"),
    );
    expect(malformed.status).toBe(400);

    vi.mocked(deps.approval.updateAskEveryCall).mockResolvedValueOnce(null);
    const none = await app.request(
      "/api/approvals/tool_1/ask-every-call?agentId=agent_1",
      json({ on: true }, "PUT"),
    );
    expect(none.status).toBe(404);
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
    // And any yes still waiting for the agent goes with the row, so nothing re-creates it.
    expect(deps.approval.settleAnsweredToolActions).toHaveBeenCalledWith(
      fakeDb,
      { personId: "person_1", agentId: "agent_1" },
      "tool_1",
      NOW,
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
      ["/api/approvals/tool_1/ask-every-call?agentId=agent_1", json({ on: true }, "PUT")],
      ["/api/approvals/tool_1?agentId=agent_1", { method: "DELETE" }],
    ] as const) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(401);
    }
  });
});

describe("the person's model key", () => {
  const session = { user: { id: "person_1" } };

  it("enters a key, answers the public shape and never the key, reads it back, and removes it", async () => {
    const { app, deps } = harness(session);

    const empty = await app.request("/api/me/model-key");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ modelKey: null });

    const put = await app.request(
      "/api/me/model-key",
      json(
        {
          provider: "anthropic",
          apiKey: "sk-ant-the-secret",
          authoringModel: "claude-x",
          baseUrl: null,
        },
        "PUT",
      ),
    );
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body).toEqual({
      modelKey: {
        provider: "anthropic",
        authoringModel: "claude-x",
        triageModel: null,
        baseUrl: null,
        setAt: NOW.toISOString(),
      },
    });
    expect(JSON.stringify(body)).not.toContain("sk-ant");
    // The row holds the vault's ciphertext, not the key.
    expect(deps.modelKey.rows.get("person_1")?.keyCiphertext).toBe(FAKE_MODEL_KEY_CIPHERTEXT);

    const read = await app.request("/api/me/model-key");
    const readText = await read.text();
    expect(JSON.parse(readText)).toMatchObject({ modelKey: { provider: "anthropic" } });
    expect(readText).not.toContain("sk-ant");

    const gone = await app.request("/api/me/model-key", { method: "DELETE" });
    expect(await gone.json()).toEqual({ deleted: true });
    const again = await app.request("/api/me/model-key", { method: "DELETE" });
    expect(await again.json()).toEqual({ deleted: false });
  });

  it("refuses a provider it does not know and a body that is not the shape, as 400", async () => {
    const { app } = harness(session);
    const provider = await app.request(
      "/api/me/model-key",
      json({ provider: "gemini", apiKey: "k" }, "PUT"),
    );
    expect(provider.status).toBe(400);
    expect(await provider.json()).toMatchObject({
      error: "BAD_REQUEST",
      details: { field: "provider" },
    });
    const shape = await app.request("/api/me/model-key", json({ provider: "openai" }, "PUT"));
    expect(shape.status).toBe(400);
  });
});
