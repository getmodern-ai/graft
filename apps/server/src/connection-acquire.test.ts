import { join } from "node:path";

import { starterProposal, starterVendorOf, toProxyConnection } from "@graft/core";
import {
  type AcquireRunner,
  createAcquireRunner,
  createMcpDeps,
  createToolListChangedNotifier,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { createScriptedModel, type ScriptedStep, scriptedGoals } from "@graft/model";
import type { Capture } from "@graft/observability";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
} from "@graft/publish";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { initLogger } from "evlog";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { SETUP_BUILD_UNCONFIGURED_MESSAGE, SETUP_FIRST_PROGRESS_LINE } from "./setup-build";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * An integration's page getting a new tool for a chosen agent (GRA-303; ADR 0024 as amended
 * 2026-10-14), over the API with no Setup record: an agent made in the console, a keyless
 * Open-Meteo connection, Create as that agent's build approval, the job worked by the real runner
 * with a scripted model in Graft's model's seat, the fake sandbox and a fake Open-Meteo behind the
 * real proxy, and the connection's job list finding it. What is asserted is the wire and the store.
 */

initLogger({ silent: true });

const OPEN_METEO = (() => {
  const starter = starterVendorOf("open-meteo");
  if (!starter) throw new Error("no open-meteo starter");
  return starter;
})();

const CONSOLE_ORIGIN = "http://localhost";
const FORECAST = { current: { temperature_2m: 14.2 }, latitude: -37.81, longitude: 144.96 };

/** A `$` for module source, so `${D}{x}` reads as `${x}` in the module and is not interpolated here. */
const D = "$";
const FORECAST_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  '  const res = await ctx.fetch("/forecast?latitude=-37.81&longitude=144.96&current=temperature_2m");',
  `  if (!res.ok) throw new Error(\`GET /forecast ${D}{res.status}\`);`,
  "  return await res.json();",
  "};",
  "",
].join("\n");

const PASSING_SCRIPT: ScriptedStep[] = [
  {
    on: "goal",
    answer: {
      kind: "write_module",
      note: "Drafted current-weather around GET /forecast.",
      draft: {
        name: "current-weather",
        description: "Reads the current temperature for a city from Open-Meteo.",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          additionalProperties: false,
        },
        files: [{ path: "index.ts", content: FORECAST_MODULE }],
        testInput: { city: "Melbourne" },
        proofReads: [],
      },
    },
  },
];

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let mcp: ReturnType<typeof createMcpDeps>;
let runner: AcquireRunner;
let app: ReturnType<typeof createServer>;
const captured: Capture[] = [];
/** Whose session the next request carries. */
let person = "person_a";

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  vendor = await startFakeVendor({
    keys,
    connections: [],
    resolve: async (id) => {
      const row = store.connections.get(id);
      return row ? toProxyConnection(row) : null;
    },
    respond: (request) =>
      new URL(request.url).pathname === "/v1/forecast"
        ? Response.json(FORECAST)
        : Response.json({ error: "not found" }, { status: 404 }),
  });
  sandbox = createFakeSandboxBackend();
  const fake = createFakeDeps(store);
  const check: typeof mcp.checkModule = async (input) => ({
    entry: input.entry,
    refusals: [],
    advice: [],
    annotations: { readOnly: true, destructive: false },
    contextMembersUsed: [],
    blobReadFields: [],
  });
  const publish = createPublishDeps({
    db: fake.db,
    store: createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") }),
    mirror: createNoopToolboxMirror(),
    sandbox,
    metadata: createFakeMetadataSource({}),
    policy: DEFAULT_PACKAGE_POLICY,
    tool: fake.tool,
    check,
  });
  const handoff = {
    consoleUrl: "http://console.graft.test",
    secret: "graft-connection-acquire-test-handoff-secret-32",
    waitMs: 0,
    ttlMs: 60_000,
    pollMs: 20,
  };
  mcp = createMcpDeps({
    toolSource: null,
    ...fake,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    handoff,
    publish,
    checkModule: check,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    notifier: createToolListChangedNotifier({ windowMs: 50 }),
    model: null,
    acquire: { maxAttempts: 2, tokenCeiling: 400_000 },
  });
  runner = createAcquireRunner(mcp, {
    concurrency: 1,
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 60,
    heartbeatMs: 200,
  });
  mcp.acquireRunner = runner;
  app = createServer({
    keys,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth"),
        getSession: async () => ({ user: { id: person } }),
      },
      deps: {
        db: fake.db,
        agent: fake.agent,
        connection: fake.connection,
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
      },
      corsOrigins: [],
      authUrl: CONSOLE_ORIGIN,
      handoff,
      connectionRouting: mcp,
      acquire: mcp,
      run: mcp,
      analytics: {
        name: "recorder",
        shutdown: async () => {},
        capture: (event) => {
          captured.push(event);
        },
      },
    },
    mcp,
  });
}, 30_000);

afterEach(async () => {
  await runner.idle();
  mcp.model = null;
  person = "person_a";
});

afterAll(async () => {
  runner.stop();
  mcp.notifier?.close();
  mcp.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON answer by field.
const read = async (res: Response): Promise<any> => {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const post = (body?: unknown) => ({
  method: "POST",
  headers: {
    origin: CONSOLE_ORIGIN,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const get = async (path: string) => read(await app.request(path));

/** An agent made in the console, on every connection unless `listed` narrows it to none. */
async function makeAgent(name: string, scopeMode: "all" | "listed" = "all"): Promise<string> {
  const res = await app.request(
    "/api/agents",
    post({ name, scopeMode, ...(scopeMode === "listed" ? { connectionIds: [] } : {}) }),
  );
  expect(res.status).toBe(201);
  return (await read(res)).agent.id;
}

/** Open-Meteo, keyless, through the console's ordinary form. */
async function makeConnection(): Promise<string> {
  const { docsUrl: _docs, ...registration } = starterProposal(OPEN_METEO);
  const res = await app.request("/api/connections", post(registration));
  expect(res.status).toBe(201);
  return (await read(res)).connection.id;
}

const acquire = (connectionId: string, body: unknown) =>
  app.request(`/api/connections/${connectionId}/acquire`, post(body));

describe("an integration's page builds a tool for a chosen agent", () => {
  it("Create grants the build approval, the job passes, and the connection's list finds it", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    const agentId = await makeAgent("Claude");
    const connectionId = await makeConnection();

    // The chips: the scripted model's proposal for the connection, and Create available.
    const chips = await get(`/api/connections/${connectionId}/goal-suggestions`);
    expect(chips).toEqual({
      suggestions: scriptedGoals(OPEN_METEO.displayName),
      build: { available: true },
    });

    const res = await acquire(connectionId, { agentId, goal: OPEN_METEO.goal });
    expect(res.status).toBe(201);
    const started = await read(res);
    expect(started).toMatchObject({
      status: "queued",
      connectionId,
      agent: { id: agentId, name: "Claude", revoked: false },
      goal: OPEN_METEO.goal,
      progress: [SETUP_FIRST_PROGRESS_LINE],
    });
    const jobId: string = started.jobId;

    // Create is the build approval: the row for the pair, and no pending action opened for it.
    expect([...store.buildApprovals.values()].filter((row) => row.agentId === agentId)).toEqual([
      expect.objectContaining({ agentId, connectionId }),
    ]);
    expect((await get("/api/pending-actions")).pendingActions).toEqual([]);
    expect(store.acquireJobs.get(jobId)).toMatchObject({
      agentId,
      connectionId,
      hints: `${OPEN_METEO.hints} The vendor's documentation starts at https://open-meteo.com/en/docs.`,
    });
    expect(captured).toContainEqual({
      distinctId: "person_a",
      event: "acquire_started",
      properties: { via: "console", job_id: jobId, agent_id: agentId },
    });

    await runner.idle();
    const { jobs } = await get(`/api/connections/${connectionId}/acquire-jobs`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId,
      status: "succeeded",
      attempts: 1,
      agent: { id: agentId, name: "Claude" },
      result: { tool: "open-meteo__current-weather" },
    });
    // The agent's job route answers the same job, and the tool landed in that agent's working set.
    expect(await get(`/api/agents/${agentId}/acquire-jobs/${jobId}`)).toMatchObject({
      jobId,
      status: "succeeded",
    });
    const workingSet = await get(`/api/agents/${agentId}/working-set`);
    expect(JSON.stringify(workingSet)).toContain("current-weather");

    // Another person sees none of it: the agent, the connection and its reads are not found.
    person = "person_b";
    const theirs = await makeConnection();
    expect((await acquire(connectionId, { agentId, goal: "Read the weather" })).status).toBe(404);
    expect((await acquire(theirs, { agentId, goal: "Read the weather" })).status).toBe(404);
    expect((await app.request(`/api/connections/${connectionId}/acquire-jobs`)).status).toBe(404);
    expect((await app.request(`/api/connections/${connectionId}/goal-suggestions`)).status).toBe(
      404,
    );
    expect((await get(`/api/connections/${theirs}/acquire-jobs`)).jobs).toEqual([]);
  });

  it("refuses with Setup's sentence when no model can author, and offers no chips", async () => {
    person = "person_c";
    const agentId = await makeAgent("Codex");
    const connectionId = await makeConnection();
    const res = await acquire(connectionId, { agentId, goal: "Read the weather" });
    expect(res.status).toBe(409);
    expect(await read(res)).toEqual({
      error: "CONFLICT",
      message: SETUP_BUILD_UNCONFIGURED_MESSAGE,
      details: { reason: "acquire_unconfigured" },
    });
    expect(await get(`/api/connections/${connectionId}/goal-suggestions`)).toEqual({
      suggestions: [],
      build: {
        available: false,
        reason: "acquire_unconfigured",
        message: SETUP_BUILD_UNCONFIGURED_MESSAGE,
      },
    });
  });

  it("refuses a connection outside the agent's scope, a revoked one, and a bad body, starting nothing", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    person = "person_d";
    const narrowed = await makeAgent("Hermes", "listed");
    const connectionId = await makeConnection();
    const before = store.acquireJobs.size;

    const outside = await acquire(connectionId, { agentId: narrowed, goal: "Read the weather" });
    expect(outside.status).toBe(409);
    expect((await read(outside)).details).toEqual({
      reason: "connection_not_in_scope",
      connectionId,
    });

    const wide = await makeAgent("Claude");
    const revoked = await app.request(`/api/connections/${connectionId}/revoke`, post());
    expect(revoked.status).toBe(200);
    const gone = await acquire(connectionId, { agentId: wide, goal: "Read the weather" });
    expect(gone.status).toBe(409);
    expect((await read(gone)).details).toEqual({ reason: "connection_revoked", connectionId });

    expect((await acquire(connectionId, { agentId: wide, goal: "  " })).status).toBe(400);
    expect(
      (await acquire(connectionId, { agentId: wide, goal: "x", connectionId: "c" })).status,
    ).toBe(400);
    expect(store.acquireJobs.size).toBe(before);
    expect((await get(`/api/connections/${connectionId}/acquire-jobs`)).jobs).toEqual([]);
  });
});
