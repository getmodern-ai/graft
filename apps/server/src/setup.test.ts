import type { AgentDeps, SetupDeps } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import type { Analytics, Capture } from "@graft/observability";
import { initLogger } from "evlog";
import { describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api";
import { createServer } from "./app";

/**
 * Setup's three routes over the API (ADR 0024; GRA-204): a signed-in session, an in-memory record
 * and agent table behind the real services, so what is asserted is the wire — the state each verb
 * answers, the agent minted or adopted, the refusals — and the analytics row each start and skip
 * adds. The services' own rules are `@graft/core`'s suites.
 */

initLogger({ silent: true });

const NOW = new Date("2026-09-23T10:00:00Z");
const CONSOLE_ORIGIN = "http://localhost:3001";
const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };

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

function harness(options: { agents?: AgentRow[]; work?: { connections: number; tools: number } }) {
  const agents = [...(options.agents ?? [])];
  let record: SetupRow | null = null;
  const save = (patch: SetupPatch): SetupRow => {
    record = {
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
      ...record,
      ...patch,
    } as SetupRow;
    return record;
  };
  const setup: SetupDeps = {
    findSetup: async () => record,
    lockSetup: async () => record ?? save({}),
    saveSetup: async (_db, _p, patch) => save(patch),
    countSetupWork: async () => options.work ?? { connections: 0, tools: 0 },
    now: () => NOW,
  };
  let minted = 0;
  const agent = {
    insertAgent: vi.fn(async (_db, input) => {
      const row = agentRow(input.id, input as Partial<AgentRow>);
      agents.push(row);
      return row;
    }),
    listAgents: async () => agents.map((row) => ({ ...row, workingSetCount: 0 })),
    replaceAgentConnections: async () => {},
    listScopeConnectionIds: async () => [],
    findConnectionsByIds: async () => [],
    newId: () => `agent_new_${++minted}`,
    now: () => NOW,
  } as unknown as AgentDeps;
  const captured: Capture[] = [];
  const analytics: Analytics = {
    name: "recorder",
    capture: (event) => {
      captured.push(event);
    },
    shutdown: async () => undefined,
  };
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth", { status: 200 }),
        getSession: async () => ({ user: { id: "person_1" } }),
      },
      // Setup reaches the agent service and its own record and nothing else of the API's deps.
      deps: { db: fakeDb as unknown as DbOrTx, agent, setup } as unknown as ApiDeps,
      corsOrigins: [CONSOLE_ORIGIN],
      handoff: { consoleUrl: CONSOLE_ORIGIN, secret: "setup-test-handoff-secret-long-enough-32" },
      analytics,
    },
  });
  return { app, agents, agent, captured, record: () => record };
}

/** The state as the test reads it: loosely, since every assertion names what it looks at. */
// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON answer by field.
const read = async (res: Response): Promise<any> => res.json();

const post = (body?: unknown) => ({
  method: "POST",
  headers: {
    origin: CONSOLE_ORIGIN,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("GET /api/setup", () => {
  it("answers a fresh person the harness step and the show rule's yes", async () => {
    const h = harness({});
    const res = await h.app.request("/api/setup");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      setup: null,
      step: "harness",
      show: true,
      agent: null,
      activeAgents: [],
    });
  });

  it("answers no for a person with a connection and no record", async () => {
    const h = harness({ work: { connections: 1, tools: 0 } });
    expect(await (await h.app.request("/api/setup")).json()).toMatchObject({ show: false });
  });
});

describe("POST /api/setup/start", () => {
  it("mints an agent awaiting its harness, and a reload resumes on the vendor step with it", async () => {
    const h = harness({});
    const res = await h.app.request("/api/setup/start", post({ harness: "claude" }));
    expect(res.status).toBe(200);
    const started = await res.json();
    expect(started).toMatchObject({
      step: "vendor",
      show: true,
      setup: { step: "vendor", harness: "claude", agentId: "agent_new_1", skippedAt: null },
      agent: { id: "agent_new_1", name: "Claude", tokenPrefix: null, connectedVia: null },
    });
    expect(h.agents[0]).toMatchObject({ tokenHash: null, connectedViaClientId: null });

    const reloaded = await (await h.app.request("/api/setup")).json();
    expect(reloaded).toMatchObject({ step: "vendor", agent: { id: "agent_new_1" } });

    // A second start (a double click, another tab) answers the same agent.
    const again = await read(await h.app.request("/api/setup/start", post({ harness: "codex" })));
    expect(again.setup).toMatchObject({ agentId: "agent_new_1", harness: "claude" });
    expect(h.agent.insertAgent).toHaveBeenCalledTimes(1);

    expect(h.captured[0]).toEqual({
      distinctId: "person_1",
      event: "setup_started",
      properties: { via: "console", harness: "claude" },
    });
  });

  it("mints with the advanced options, and refuses a list beside them", async () => {
    const h = harness({});
    const refused = await h.app.request(
      "/api/setup/start",
      post({ harness: "hermes", agent: { scopeMode: "listed", connectionIds: ["conn_1"] } }),
    );
    expect(refused.status).toBe(400);
    const res = await h.app.request(
      "/api/setup/start",
      post({ harness: "hermes", agent: { name: "laptop Hermes", workingSetCap: 8 } }),
    );
    expect(await res.json()).toMatchObject({
      agent: { name: "laptop Hermes", workingSetCap: 8, scopeMode: "all" },
    });
  });

  it("refuses a harness that is not one of the seven, and a start with none", async () => {
    const h = harness({});
    expect((await h.app.request("/api/setup/start", post({ harness: "slack" }))).status).toBe(400);
    const none = await h.app.request("/api/setup/start", post({}));
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ details: { reason: "harness_required" } });
    expect(h.agent.insertAgent).not.toHaveBeenCalled();
  });

  it("adopts the one active agent, from consent, without a harness", async () => {
    const h = harness({
      agents: [
        agentRow("agent_claude", {
          tokenHash: null,
          tokenPrefix: null,
          connectedViaClientId: "client_1",
          connectedViaClientName: "Claude",
        }),
      ],
    });
    const state = await (await h.app.request("/api/setup/start", post({}))).json();
    expect(state).toMatchObject({
      step: "vendor",
      setup: { agentId: "agent_claude", harness: null },
      agent: { id: "agent_claude", connectedVia: { clientName: "Claude" } },
    });
    expect(h.agent.insertAgent).not.toHaveBeenCalled();
    expect(h.captured[0]?.properties).toEqual({ via: "console", harness: null });
  });

  it("requires the agent among several, and runs as the one named", async () => {
    const h = harness({ agents: [agentRow("agent_a"), agentRow("agent_b")] });
    const refused = await h.app.request("/api/setup/start", post({}));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      details: { reason: "agent_required", agentIds: ["agent_a", "agent_b"] },
    });
    const state = await read(await h.app.request("/api/setup/start", post({ agentId: "agent_b" })));
    expect(state.setup.agentId).toBe("agent_b");
    expect((await h.app.request("/api/setup/start", post({ agentId: "agent_a" }))).status).toBe(
      409,
    );
  });

  it("refuses a start from another origin before anything is minted", async () => {
    const h = harness({});
    const res = await h.app.request("/api/setup/start", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ harness: "claude" }),
    });
    expect(res.status).toBe(403);
    expect(h.agents).toHaveLength(0);
  });
});

describe("POST /api/setup/skip", () => {
  it("marks Setup skipped, the show rule answers no, and the row carries the harness", async () => {
    const h = harness({});
    const res = await h.app.request("/api/setup/skip", post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      show: false,
      setup: { skippedAt: NOW.toISOString(), startedAt: null },
    });
    expect((await read(await h.app.request("/api/setup"))).show).toBe(false);
    expect(h.captured[0]).toEqual({
      distinctId: "person_1",
      event: "setup_skipped",
      properties: { via: "console", harness: null },
    });
  });

  it("reopens on a start: the skip is cleared and the show rule answers yes again", async () => {
    const h = harness({});
    await h.app.request("/api/setup/skip", post());
    const state = await (
      await h.app.request("/api/setup/start", post({ harness: "hermes" }))
    ).json();
    expect(state).toMatchObject({ show: true, step: "vendor", setup: { skippedAt: null } });
  });
});
