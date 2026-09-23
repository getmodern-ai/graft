import { join } from "node:path";

import {
  hashAgentToken,
  type SetupDeps,
  type StarterVendor,
  starterVendorOf,
  toProxyConnection,
} from "@graft/core";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import {
  type AcquireRunner,
  createAcquireRunner,
  createMcpDeps,
  createToolListChangedNotifier,
  openAgentSession,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import {
  createScriptedModel,
  type ModelAdapter,
  type ScriptedStep,
  scriptedGoals,
} from "@graft/model";
import type { Capture } from "@graft/observability";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
} from "@graft/publish";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { SETUP_BUILD_UNCONFIGURED_MESSAGE, SETUP_FIRST_PROGRESS_LINE } from "./setup-build";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * Setup's goal, build and building steps over the API (GRA-207; ADR 0024), walked from the harness
 * step on: the keyless Open-Meteo ask answered through the existing route, the goal step's
 * context, Build as the build approval, the job polled through the agent's job route to a pass,
 * and the record naming the tool. The loop underneath is the real one: the runner over the
 * in-memory store, a scripted model in the seat Graft's model takes, the fake sandbox running the
 * real runner, and a fake Open-Meteo behind the real proxy. What is asserted is the wire and the
 * store: the state, the job's shape, the approvals and the asks.
 */

initLogger({ silent: true });

const OPEN_METEO: StarterVendor = (() => {
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
const GIVING_UP: ScriptedStep[] = [
  { on: "goal", answer: { kind: "give_up", reason: "The documentation names no such read." } },
];

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let mcp: ReturnType<typeof createMcpDeps>;
let runner: AcquireRunner;
let app: ReturnType<typeof createServer>;
const captured: Capture[] = [];
/**
 * Serialise the API's top-level transactions, as the record's row lock does in Postgres, for the
 * one test that races two reads: the in-memory store has no lock of its own.
 */
let serialise = false;
/** Whose session the next request carries: each test is its own person, so records never mix. */
let person = "person_0";
let people = 0;

/** One Setup record per person, in memory, as `SetupDeps` reads and writes it. */
function inMemorySetup(now: () => Date): SetupDeps {
  const records = new Map<string, SetupRow>();
  const save = (personId: string, patch: SetupPatch): SetupRow => {
    const at = now();
    const next = {
      personId,
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
      createdAt: at,
      updatedAt: at,
      ...records.get(personId),
      ...patch,
    } as SetupRow;
    records.set(personId, next);
    return next;
  };
  return {
    findSetup: async (_db, personId) => records.get(personId) ?? null,
    lockSetup: async (_db, personId) => records.get(personId) ?? save(personId, {}),
    saveSetup: async (_db, personId, patch) => save(personId, patch),
    countSetupWork: async () => ({ connections: 0, tools: 0 }),
    now,
  };
}

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  vendor = await startFakeVendor({
    keys,
    connections: [],
    // The keyless confirmation makes the row during the test; the proxy reads it from the store.
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
    secret: "graft-setup-build-test-handoff-secret-long-32",
    waitMs: 0,
    ttlMs: 60_000,
    pollMs: 20,
  };
  mcp = createMcpDeps({
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
  let chain: Promise<unknown> = Promise.resolve();
  const apiDb = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (!serialise) return fake.db.transaction(fn);
      const run = chain.then(() => fn(fake.db));
      chain = run.catch(() => {});
      return run;
    },
  } as typeof fake.db;
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
        db: apiDb,
        agent: fake.agent,
        connection: fake.connection,
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
        setup: inMemorySetup(() => store.now()),
      },
      corsOrigins: [],
      authUrl: CONSOLE_ORIGIN,
      handoff,
      connectionRouting: mcp,
      acquire: mcp,
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
  serialise = false;
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

/**
 * A fresh person through the harness and connect steps: Hermes, then Open-Meteo's keyless ask
 * confirmed through the route the card posts to, with the build choice as given, and the record
 * read onto `goal`. Answers the agent and the connection.
 */
async function onGoal(approveBuild: boolean): Promise<{ agentId: string; connectionId: string }> {
  people += 1;
  person = `person_${people}`;
  const started = await read(await app.request("/api/setup/start", post({ harness: "hermes" })));
  const agentId: string = started.agent.id;
  const asked = await read(
    await app.request("/api/setup/connect", post({ starterId: "open-meteo" })),
  );
  const askId: string = asked.setup.pendingActionId;
  const { payload } = (await get("/api/pending-actions")).pendingActions[0];
  const confirmed = await app.request(
    `/api/pending-actions/${askId}/connection`,
    post({
      vendor: payload.vendor,
      displayName: payload.displayName,
      primaryHost: payload.primaryHost,
      hosts: payload.hosts,
      scheme: payload.scheme,
      schemeConfig: payload.schemeConfig,
      credential: {},
      approveBuild,
    }),
  );
  expect(confirmed.status).toBe(201);
  const state = await get("/api/setup");
  expect(state.step).toBe("goal");
  return { agentId, connectionId: state.setup.connectionId };
}

const buildApprovals = (agentId: string) =>
  [...store.buildApprovals.values()].filter((row) => row.agentId === agentId);
const openAsks = async () => (await get("/api/pending-actions")).pendingActions;
const stepEvents = () =>
  captured
    .filter((event) => event.event === "setup_step_completed" && event.distinctId === person)
    .map((event) => event.properties?.step);

/** An MCP session as the agent, once a token is on its row (GRA-208 mints it at the finish step). */
async function connectAs(agentId: string) {
  const token = `grft_setup_build_${agentId}_0000000000000000000000`;
  const row = store.agents.get(agentId);
  if (!row) throw new Error(`no agent ${agentId}`);
  store.agents.set(agentId, { ...row, tokenHash: hashAgentToken(token), tokenPrefix: "grft_set" });
  const notifier = createToolListChangedNotifier();
  const session = await openAgentSession(mcp, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const first = result.content[0];
      if (first?.type !== "text") throw new Error("no text content");
      return JSON.parse(first.text) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

describe("Setup's goal and build steps", () => {
  it("walks harness, connect, goal and build to a pass: no ask, a build approval, the tool on the record", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    // The connection card's build choice left unticked, so the grant is Build's alone.
    const { agentId, connectionId } = await onGoal(false);
    expect(buildApprovals(agentId)).toEqual([]);

    const goal = await get("/api/setup/goal");
    expect(goal).toEqual({
      connection: { id: connectionId, vendor: "open-meteo", displayName: expect.any(String) },
      starterId: "open-meteo",
      goal: OPEN_METEO.goal,
      build: { available: true },
    });

    const built = await app.request("/api/setup/build", post({ goal: goal.goal }));
    expect(built.status).toBe(200);
    const building = await read(built);
    expect(building).toMatchObject({ step: "building", setup: { toolId: null } });
    const jobId: string = building.setup.acquireJobId;
    expect(jobId).toEqual(expect.any(String));

    // Build is the build approval: the row for the pair, and no pending action opened for it.
    expect(buildApprovals(agentId)).toEqual([expect.objectContaining({ agentId, connectionId })]);
    expect(await openAsks()).toEqual([]);
    const job = store.acquireJobs.get(jobId);
    expect(job).toMatchObject({
      agentId,
      connectionId,
      goal: goal.goal,
      // The curated goal unchanged carries the starter's detail for the model, then the docs.
      hints: `${OPEN_METEO.hints} The vendor's documentation starts at https://open-meteo.com/en/docs.`,
    });

    // The job route, polled to the end, in acquire_status's shape.
    await runner.idle();
    const status = await get(`/api/agents/${agentId}/acquire-jobs/${jobId}`);
    expect(status).toMatchObject({
      jobId,
      status: "succeeded",
      attempts: 1,
      result: {
        tool: "open-meteo__current-weather",
        vendor: "open-meteo",
        name: "current-weather",
      },
    });
    expect(status.progress[0]).toBe(SETUP_FIRST_PROGRESS_LINE);
    expect(status.progress.at(-1)).toMatch(/the dry run passed/);

    // The next read names the tool and moves on to the result.
    const result = await get("/api/setup");
    expect(result).toMatchObject({
      step: "result",
      setup: { step: "result", acquireJobId: jobId, toolId: status.result.toolId },
    });
    await get("/api/setup");
    expect(stepEvents()).toEqual(["vendor", "connect", "goal", "building"]);

    // A later acquire over MCP for the same pair asks nothing: the job starts.
    const harness = await connectAs(agentId);
    try {
      const again = await harness.call("acquire", {
        connectionId,
        goal: "Read tomorrow's forecast for a city. Read only.",
        ignoreExisting: true,
      });
      expect(again).toMatchObject({ jobId: expect.any(String) });
      expect(again).not.toHaveProperty("url");
      expect(await openAsks()).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("grants nothing new when the connection card already granted the build approval", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    const { agentId } = await onGoal(true);
    const granted = buildApprovals(agentId);
    expect(granted).toHaveLength(1);
    const own = await read(
      await app.request("/api/setup/build", post({ goal: "Read the current weather. Read only." })),
    );
    expect(buildApprovals(agentId)).toEqual(granted);
    // A goal of the person's own carries the docs and not the curated goal's detail.
    expect(store.acquireJobs.get(own.setup.acquireJobId)?.hints).toBe(
      "The vendor's documentation starts at https://open-meteo.com/en/docs.",
    );
    // A second Build from a tab that did not move on opens no second job.
    const second = await app.request("/api/setup/build", post({ goal: "Again." }));
    expect(second.status).toBe(409);
    expect((await read(second)).details).toMatchObject({ reason: "setup_step", step: "building" });
  }, 60_000);

  it("stays on building with the failure, and Change the goal goes back for a new job", async () => {
    mcp.model = createScriptedModel(GIVING_UP);
    const { agentId } = await onGoal(true);
    const building = await read(
      await app.request("/api/setup/build", post({ goal: "Read something unreadable." })),
    );
    const jobId: string = building.setup.acquireJobId;

    // Change the goal is refused while the job may still pass.
    const early = await app.request("/api/setup/goal", post());
    if (store.acquireJobs.get(jobId)?.status !== "failed") expect(early.status).toBe(409);

    await runner.idle();
    const status = await get(`/api/agents/${agentId}/acquire-jobs/${jobId}`);
    expect(status).toMatchObject({
      status: "failed",
      result: { failure: "model_gave_up", message: expect.stringContaining("no such read") },
    });
    // A failed job leaves the record on building, where the step shows the failure.
    expect(await get("/api/setup")).toMatchObject({ step: "building", setup: { toolId: null } });

    const back = await read(await app.request("/api/setup/goal", post()));
    expect(back).toMatchObject({ step: "goal", setup: { acquireJobId: null } });
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    const retry = await read(
      await app.request("/api/setup/build", post({ goal: "Read the current weather. Read only." })),
    );
    expect(retry.step).toBe("building");
    expect(retry.setup.acquireJobId).not.toBe(jobId);
  }, 60_000);

  it("continues to the finish while it builds, and notes the tool there once it lands", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    await onGoal(true);
    // Held queued: no kick reaches the runner until the continue has landed.
    const kick = runner.kick;
    runner.kick = () => {};
    let jobId: string;
    try {
      const building = await read(
        await app.request(
          "/api/setup/build",
          post({ goal: "Read the current weather. Read only." }),
        ),
      );
      jobId = building.setup.acquireJobId;
      const finish = await read(await app.request("/api/setup/continue", post()));
      expect(finish).toMatchObject({
        step: "finish",
        setup: { acquireJobId: jobId, toolId: null },
      });
    } finally {
      runner.kick = kick;
    }
    runner.kick();
    await runner.idle();
    const landed = await get("/api/setup");
    expect(landed).toMatchObject({ step: "finish", setup: { toolId: expect.any(String) } });
  }, 60_000);

  it("counts the building step once when two reads learn the same pass", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    await onGoal(true);
    await app.request("/api/setup/build", post({ goal: "Read the current weather. Read only." }));
    await runner.idle();
    serialise = true;
    // Both reads find the job passed before either moves; the lock lets one name the tool.
    const answers = await Promise.all([app.request("/api/setup"), app.request("/api/setup")]);
    const states = await Promise.all(answers.map(read));
    expect(states.map((state) => state.step)).toEqual(["result", "result"]);
    expect(stepEvents()).toEqual(["vendor", "connect", "goal", "building"]);
  }, 60_000);

  it("refuses Build on a revoked connection before any grant or job, and the read goes back", async () => {
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    const { agentId, connectionId } = await onGoal(false);
    const revoked = await app.request(`/api/connections/${connectionId}/revoke`, post());
    expect(revoked.status).toBe(200);
    // Build posted before the next read: the row is revoked though still in the resolved scope.
    const refused = await app.request("/api/setup/build", post({ goal: "Read the weather." }));
    expect(refused.status).toBe(409);
    expect((await read(refused)).details).toMatchObject({
      reason: "connection_revoked",
      connectionId,
    });
    expect(buildApprovals(agentId)).toEqual([]);
    expect([...store.acquireJobs.values()].filter((job) => job.agentId === agentId)).toEqual([]);
    expect(await get("/api/setup")).toMatchObject({
      step: "vendor",
      setup: { connectionId: null },
    });
  });

  it("with no model, says what the operator sets and refuses Build with the door's reason", async () => {
    mcp.model = null;
    await onGoal(true);
    expect((await get("/api/setup/goal")).build).toEqual({
      available: false,
      reason: "acquire_unconfigured",
      message: SETUP_BUILD_UNCONFIGURED_MESSAGE,
    });
    const refused = await app.request("/api/setup/build", post({ goal: "Read the weather." }));
    expect(refused.status).toBe(409);
    expect(await read(refused)).toMatchObject({
      message: SETUP_BUILD_UNCONFIGURED_MESSAGE,
      details: { reason: "acquire_unconfigured" },
    });
    expect((await get("/api/setup")).step).toBe("goal");
    expect(stepEvents()).not.toContain("goal");
  });

  it("refuses a goal that is empty, and a Build before the goal step", async () => {
    people += 1;
    person = `person_${people}`;
    mcp.model = createScriptedModel(PASSING_SCRIPT);
    await app.request("/api/setup/start", post({ harness: "hermes" }));
    const early = await app.request("/api/setup/build", post({ goal: "Read the weather." }));
    expect(early.status).toBe(409);
    await onGoal(true);
    expect((await app.request("/api/setup/build", post({ goal: "   " }))).status).toBe(400);
  });
});

describe("GET /api/setup/goal/suggestions", () => {
  const suggestions = async () => {
    const res = await app.request("/api/setup/goal/suggestions");
    expect(res.status).toBe(200);
    return read(res);
  };

  it("answers the scripted model's fixed set, asked with the connection and the curated goal", async () => {
    const scripted = createScriptedModel(PASSING_SCRIPT);
    mcp.model = scripted;
    const { connectionId } = await onGoal(true);
    const connection = store.connections.get(connectionId);
    if (!connection) throw new Error("the keyless confirmation made the row");

    expect(await suggestions()).toEqual({ suggestions: scriptedGoals(connection.displayName) });
    expect(scripted.proposals).toEqual([
      {
        personId: person,
        traceId: `setup:${person}`,
        vendor: "open-meteo",
        displayName: connection.displayName,
        primaryHost: OPEN_METEO.primaryHost,
        docsUrl: OPEN_METEO.docsUrl,
        curatedGoal: OPEN_METEO.goal,
      },
    ]);
  });

  it("answers none with no model, and asks nothing", async () => {
    mcp.model = null;
    await onGoal(true);
    expect(await suggestions()).toEqual({ suggestions: [] });
  });

  it("answers none, asking nothing, before the record names a connection", async () => {
    const scripted = createScriptedModel(PASSING_SCRIPT);
    mcp.model = scripted;
    people += 1;
    person = `person_${people}`;
    await app.request("/api/setup/start", post({ harness: "hermes" }));
    expect(await suggestions()).toEqual({ suggestions: [] });
    expect(scripted.proposals).toEqual([]);
  });

  it("answers none when the proposal answers none, or throws, and never more than three", async () => {
    await onGoal(true);
    const model = (proposeGoals: ModelAdapter["proposeGoals"]): ModelAdapter => ({
      name: "stand-in",
      open: () => {
        throw new Error("no job here");
      },
      proposeGoals,
    });
    const usage = { inputTokens: 0, outputTokens: 0 };
    mcp.model = model(async () => ({ goals: [], outcome: "timeout", usage }));
    expect(await suggestions()).toEqual({ suggestions: [] });
    mcp.model = model(async () => {
      throw new Error("the person's key would not decrypt");
    });
    expect(await suggestions()).toEqual({ suggestions: [] });
    mcp.model = model(async () => ({
      goals: ["one", "two", "three", "four"],
      outcome: "proposed",
      usage,
    }));
    expect(await suggestions()).toEqual({ suggestions: ["one", "two", "three"] });
    // An adapter that cannot propose answers none rather than failing the step.
    mcp.model = model(undefined);
    expect(await suggestions()).toEqual({ suggestions: [] });
  });
});

describe("GET /api/agents/:id/acquire-jobs/:jobId", () => {
  it("answers another person's agent or job as not found", async () => {
    mcp.model = createScriptedModel(GIVING_UP);
    const { agentId } = await onGoal(true);
    const building = await read(
      await app.request("/api/setup/build", post({ goal: "Read the weather. Read only." })),
    );
    const jobId: string = building.setup.acquireJobId;
    await runner.idle();
    expect((await app.request(`/api/agents/${agentId}/acquire-jobs/${jobId}`)).status).toBe(200);

    // Another person, with an agent of their own.
    const owner = person;
    const other = await onGoal(true);
    expect(person).not.toBe(owner);
    expect((await app.request(`/api/agents/${agentId}/acquire-jobs/${jobId}`)).status).toBe(404);
    expect((await app.request(`/api/agents/${other.agentId}/acquire-jobs/${jobId}`)).status).toBe(
      404,
    );
  }, 60_000);
});
