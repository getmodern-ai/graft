import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkModule } from "@graft/check";
import { loadStockCatalogue, setApproval } from "@graft/core";
import { createFakeStockCatalogue } from "@graft/core/stock/testing/fake-stock-deps";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { checkStockTool, readStockWorkspace } from "@graft/stock";
import { createFilesystemToolboxStore } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NO_ELICITATION } from "./approval";
import type { McpDeps } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier } from "./notifier";
import { runAuthoredTool } from "./run";
import { openAgentSession } from "./session";
import { ensureToolForAgent, promoteToolForAgent } from "./stock-copy";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { createStockToolSource } from "./tool-source";
import { readWebPage } from "./web-page";

/**
 * Stock tools end to end over the MCP server's fakes (ADR 0025; GRA-238): the real catalogue load
 * over `@graft/stock`'s workspace into an in-memory catalogue, the real copy into a toolbox on the
 * fake sandbox's disk, the real Open-Meteo module run by the runner through the real proxy to a fake
 * Open-Meteo. What is asserted is what an agent observes: `find_tool`'s hits, the refusal naming the
 * connect step, the run's answer and the tool list, and what the copy left in the toolbox.
 */

const WIRE = "open-meteo__current-weather";
const KEY = { vendor: "open-meteo", name: "current-weather" };

/** Each person with an agent: one without the connection, one per path with it, one with their own tool. */
const AGENTS = {
  unconnected: { person: "p_unconnected", agent: "a_unconnected", connection: null },
  runner: { person: "p_runner", agent: "a_runner", connection: "conn_meteo_runner" },
  promoter: { person: "p_promoter", agent: "a_promoter", connection: "conn_meteo_promoter" },
  console: { person: "p_console", agent: "a_console", connection: "conn_meteo_console" },
  owner: { person: "p_owner", agent: "a_owner", connection: "conn_meteo_owner" },
  // GRA-242: copies made at stock v1, then the catalogue gains v2.
  follower: { person: "p_follower", agent: "a_follower", connection: "conn_meteo_follower" },
  idle: { person: "p_idle", agent: "a_idle", connection: "conn_meteo_idle" },
  remixer: { person: "p_remixer", agent: "a_remixer", connection: "conn_meteo_remixer" },
  racer: { person: "p_racer", agent: "a_racer", connection: "conn_meteo_racer" },
  finder: { person: "p_finder", agent: "a_finder", connection: "conn_meteo_finder" },
  lister: { person: "p_lister", agent: "a_lister", connection: "conn_meteo_lister" },
  // GRA-245: a stock write tool approved, then advanced; and a remix of one.
  approver: { person: "p_approver", agent: "a_approver", connection: "conn_meteo_approver" },
  remixWriter: {
    person: "p_remix_writer",
    agent: "a_remix_writer",
    connection: "conn_meteo_remix_writer",
  },
} as const;
/** The racer's second agent, over the same connection: two reaches of one copy at once. */
const RACER_TWO = "a_racer_two";
const tokenOf = (agent: string) => `grft_token_${agent}`.padEnd(46, "0");

const OWN_MODULE = "export default async () => ({ mine: true });\n";

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let catalogue: ReturnType<typeof createFakeStockCatalogue>;

beforeAll(async () => {
  const keys = await generateTestKeys();
  const connected = Object.values(AGENTS).filter((entry) => entry.connection !== null);
  vendor = await startFakeVendor({
    keys,
    connections: connected.map((entry) => ({
      id: entry.connection as string,
      personId: entry.person,
      authScheme: "none",
      primaryHost: "https://api.open-meteo.com/v1",
      hosts: ["geocoding-api.open-meteo.com"],
      schemeConfig: {},
      credential: {},
    })),
    respond: (request) => {
      const url = new URL(request.url);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return Response.json({
          results: [
            {
              name: url.searchParams.get("name"),
              country: "Australia",
              latitude: -37.81,
              longitude: 144.96,
            },
          ],
        });
      }
      return Response.json({
        current: {
          time: "2026-10-09T19:00",
          temperature_2m: 17.5,
          wind_speed_10m: 12.1,
          weather_code: 3,
        },
        current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
      });
    },
  });
  sandbox = createFakeSandboxBackend();

  store = createFakeStore();
  for (const entry of Object.values(AGENTS)) {
    if (entry.connection) {
      store.addConnection({
        id: entry.connection,
        personId: entry.person,
        vendor: "open-meteo",
        displayName: "Open-Meteo",
        scheme: "none",
        primaryHost: "https://api.open-meteo.com/v1",
        hosts: ["geocoding-api.open-meteo.com"],
      });
    }
    store.addAgent({
      scopeMode: "listed",
      id: entry.agent,
      personId: entry.person,
      token: tokenOf(entry.agent),
      connectionIds: entry.connection ? [entry.connection] : [],
    });
  }
  store.addAgent({
    scopeMode: "listed",
    id: RACER_TWO,
    personId: AGENTS.racer.person,
    token: tokenOf(RACER_TWO),
    connectionIds: [AGENTS.racer.connection],
  });
  // The owner authored a tool of the stock tool's name before stock existed: it shadows stock.
  const own = join(sandbox.toolboxRoot(AGENTS.owner.person), "tools/open-meteo/current-weather/v1");
  await mkdir(own, { recursive: true });
  await writeFile(join(own, "index.ts"), OWN_MODULE);
  store.addTool({
    id: "tool_owner_weather",
    personId: AGENTS.owner.person,
    vendor: "open-meteo",
    name: "current-weather",
    description: "My own weather tool, which reads the weather my way.",
    inputSchema: { type: "object" },
    readOnly: true,
    destructive: false,
    defaultConnectionId: AGENTS.owner.connection,
    path: "tools/open-meteo/current-weather/v1",
  });

  // The catalogue as the boot loads it: the workspace, the real check, an in-memory catalogue.
  catalogue = createFakeStockCatalogue();
  const fake = createFakeDeps(store);
  const report = await loadStockCatalogue(
    { db: fake.db },
    await readStockWorkspace(),
    checkStockTool,
    catalogue.deps,
  );
  expect(report.refused).toEqual([]);

  const toolbox = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
  deps = {
    ...fake,
    inFlight: createInFlightRegistry(),
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule,
    runnerFiles,
    skills: loadSkills,
    readWebPage: (args) => readWebPage(args),
    toolbox,
    toolSource: createStockToolSource({
      db: fake.db,
      publish: { db: fake.db, store: toolbox, tool: fake.tool },
      stock: catalogue.deps,
    }),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-mcp-test-handoff-secret-that-is-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
}, 60_000);

afterAll(async () => {
  deps.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

async function connect(agent: string) {
  const notifier = createToolListChangedNotifier({ windowMs: 300 });
  const session = await openAgentSession(deps, tokenOf(agent), notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

/** The person's copy, if they hold one: the tool row and its versions. */
function copyOf(person: string) {
  const tool = [...store.tools.values()].find(
    (row) => row.personId === person && row.vendor === KEY.vendor && row.name === KEY.name,
  );
  const versions = [...store.versions.values()].filter((row) => row.toolId === tool?.id);
  return { tool, versions };
}

describe("find_tool over stock", () => {
  it("answers the stock tool with connect, request_connection's arguments, for an agent without the connection", async () => {
    const harness = await connect(AGENTS.unconnected.agent);
    try {
      const answer = body(await harness.call("find_tool", { query: "weather in a city" }));
      const tools = answer.tools as Record<string, unknown>[];
      expect(tools.map((tool) => tool.tool)).toEqual([WIRE]);
      expect(tools[0]).toMatchObject({
        vendor: "open-meteo",
        name: "current-weather",
        stock: true,
        promoted: false,
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: { required: ["city"] },
        connect: {
          vendor: "open-meteo",
          displayName: "Open-Meteo",
          primaryHost: "https://api.open-meteo.com/v1",
          hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
          scheme: "none",
          docsUrl: "https://open-meteo.com/en/docs",
        },
      });
      expect(tools[0]).not.toHaveProperty("connectionIds");
    } finally {
      await harness.close();
    }
  });

  it("answers the stock tool with connectionIds, the connections in the agent's scope, for an agent with one", async () => {
    const harness = await connect(AGENTS.runner.agent);
    try {
      const answer = body(await harness.call("find_tool", { query: "current weather" }));
      const [hit] = answer.tools as Record<string, unknown>[];
      expect(hit).toMatchObject({
        tool: WIRE,
        stock: true,
        connectionIds: [AGENTS.runner.connection],
      });
      expect(hit).not.toHaveProperty("connect");
    } finally {
      await harness.close();
    }
  });
});

describe("the first run of a stock tool", () => {
  it("refuses connection_needed with connect for an agent without the connection, and copies nothing", async () => {
    const harness = await connect(AGENTS.unconnected.agent);
    try {
      const result = await harness.call("run_tool", { ...KEY, input: { city: "Melbourne" } });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        reason: "connection_needed",
        connect: { vendor: "open-meteo", scheme: "none" },
      });
      expect(copyOf(AGENTS.unconnected.person).tool).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("copies the stock tool into the person's toolbox, recording its stock origin, and runs it", async () => {
    const harness = await connect(AGENTS.runner.agent);
    try {
      const result = await harness.call("run_tool", { ...KEY, input: { city: "Melbourne" } });
      expect(result.isError ?? false).toBe(false);
      expect(body(result)).toMatchObject({
        found: true,
        city: "Melbourne",
        temperature: 17.5,
        temperatureUnit: "°C",
      });
      const hosts = vendor.requests.map((request) => new URL(request.url).hostname);
      expect(hosts).toEqual(
        expect.arrayContaining(["geocoding-api.open-meteo.com", "api.open-meteo.com"]),
      );

      const { tool, versions } = copyOf(AGENTS.runner.person);
      expect(tool).toMatchObject({
        readOnly: true,
        destructive: false,
        defaultConnectionId: AGENTS.runner.connection,
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.stockToolId).toMatch(/^stock_/);
      expect(versions[0]?.stockVersionId).toMatch(/^stock_/);
      expect(tool?.currentVersionId).toBe(versions[0]?.id);

      // A second run reuses the copy; find_tool now answers it as the person's tool, marked as
      // a copy that follows stock (GRA-242), with no connect step.
      await harness.call("run_tool", { ...KEY, input: { city: "Sydney" } });
      expect(copyOf(AGENTS.runner.person).versions).toHaveLength(1);
      const [hit] = body(await harness.call("find_tool", { query: "weather" })).tools as Record<
        string,
        unknown
      >[];
      expect(hit?.tool).toBe(WIRE);
      expect(hit).toMatchObject({ stock: true });
      expect(hit).not.toHaveProperty("remixed");
      expect(hit).not.toHaveProperty("connect");
    } finally {
      await harness.close();
    }
  });
});

describe("promote of a stock tool", () => {
  it("copies it and lists it as vendor__name with its schema", async () => {
    const harness = await connect(AGENTS.promoter.agent);
    try {
      expect(await harness.names()).not.toContain(WIRE);
      const answer = body(await harness.call("promote", KEY));
      expect(answer).toMatchObject({ tool: WIRE, promoted: true, changed: true });
      expect(await harness.names()).toContain(WIRE);
      expect(copyOf(AGENTS.promoter.person).versions[0]?.stockVersionId).toMatch(/^stock_/);
    } finally {
      await harness.close();
    }
  });

  it("is one function a console route calls as well: copy, promote, then run as the console runs", async () => {
    const scope = { personId: AGENTS.console.person, agentId: AGENTS.console.agent };
    const promoted = await promoteToolForAgent(deps, scope, KEY);
    expect(promoted).toMatchObject({ ok: true, tool: WIRE, changed: true, workingSetSize: 1 });
    const run = await runAuthoredTool(deps, scope, {
      ...KEY,
      input: { city: "Hobart" },
      mode: { detached: false, timeoutSeconds: 30, dryRun: false },
      channel: NO_ELICITATION,
    });
    expect(run).toMatchObject({ isError: false, answer: { found: true, city: "Hobart" } });
  });

  it("refuses connection_needed for an agent without the connection", async () => {
    const scope = { personId: AGENTS.unconnected.person, agentId: AGENTS.unconnected.agent };
    expect(await promoteToolForAgent(deps, scope, KEY)).toMatchObject({
      ok: false,
      reason: "connection_needed",
      details: { connect: { vendor: "open-meteo" } },
    });
  });
});

describe("a person's own tool of the same name", () => {
  it("shadows the stock tool in find_tool and run_tool", async () => {
    const harness = await connect(AGENTS.owner.agent);
    try {
      const tools = body(await harness.call("find_tool", { query: "weather" })).tools as Record<
        string,
        unknown
      >[];
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        tool: WIRE,
        description: "My own weather tool, which reads the weather my way.",
      });
      expect(tools[0]).not.toHaveProperty("stock");
      const result = await harness.call("run_tool", { ...KEY, input: {} });
      expect(body(result)).toEqual({ mine: true });
      expect(copyOf(AGENTS.owner.person).versions[0]?.stockVersionId).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

/**
 * GRA-242: an untouched copy follows stock's new versions when it is reached, a remix never does,
 * and two reaches at once advance it once. Each person here copied the tool at stock v1; then the
 * catalogue gains v2, a module that answers which version ran, as a release would append it.
 */
describe("an untouched copy follows stock's new versions", () => {
  const V2_MODULE = "export default async () => ({ stockVersion: 2 });\n";
  const V2_DESCRIPTION =
    "The weather right now in a named city, as stock's second version reads it.";
  let v2Id = "";

  const scopeOf = (entry: { person: string; agent: string }) => ({
    personId: entry.person,
    agentId: entry.agent,
  });
  const runAs = (scope: { personId: string; agentId: string }) =>
    runAuthoredTool(deps, scope, {
      ...KEY,
      input: { city: "Perth" },
      mode: { detached: false, timeoutSeconds: 30, dryRun: false },
      channel: NO_ELICITATION,
    });

  beforeAll(async () => {
    for (const entry of [
      AGENTS.follower,
      AGENTS.idle,
      AGENTS.remixer,
      AGENTS.racer,
      AGENTS.finder,
    ]) {
      expect(await ensureToolForAgent(deps, scopeOf(entry), KEY)).toMatchObject({
        ok: true,
        copied: true,
      });
    }
    expect(await promoteToolForAgent(deps, scopeOf(AGENTS.lister), KEY)).toMatchObject({
      ok: true,
      changed: true,
    });

    // The remixer's agent publishes its own version on the copy: v2, no stock origin.
    const remix = copyOf(AGENTS.remixer.person);
    const remixDir = join(
      sandbox.toolboxRoot(AGENTS.remixer.person),
      "tools/open-meteo/current-weather/v2",
    );
    await mkdir(remixDir, { recursive: true });
    await writeFile(join(remixDir, "index.ts"), OWN_MODULE);
    const [first] = remix.versions;
    if (!remix.tool || !first) throw new Error("the remixer holds no copy");
    store.versions.set("remix_v2", {
      ...first,
      id: "remix_v2",
      versionNumber: 2,
      path: "tools/open-meteo/current-weather/v2",
      stockToolId: null,
      stockVersionId: null,
    });
    store.tools.set(remix.tool.id, { ...remix.tool, currentVersionId: "remix_v2" });

    // The catalogue gains v2, as the boot appends a changed workspace's tool.
    const [stockTool] = [...catalogue.tools.values()];
    const v1 = [...catalogue.versions.values()].find((row) => row.versionNumber === 1);
    if (!stockTool || !v1) throw new Error("the catalogue holds no v1");
    v2Id = "stock_weather_v2";
    catalogue.versions.set(v2Id, {
      ...v1,
      id: v2Id,
      versionNumber: 2,
      sourceHash: "v2",
      description: V2_DESCRIPTION,
      files: [{ path: "index.ts", content: V2_MODULE }],
    });
    for (const row of catalogue.versions.values()) {
      store.stockVersionNumbers.set(row.id, row.versionNumber);
    }
  });

  it("the next run_tool runs v2, and the toolbox shows a new version naming stock v2", async () => {
    const harness = await connect(AGENTS.follower.agent);
    try {
      const result = await harness.call("run_tool", { ...KEY, input: { city: "Perth" } });
      expect(result.isError ?? false).toBe(false);
      expect(body(result)).toEqual({ stockVersion: 2 });
    } finally {
      await harness.close();
    }
    const { tool, versions } = copyOf(AGENTS.follower.person);
    expect(versions.map((row) => row.versionNumber).sort()).toEqual([1, 2]);
    const advanced = versions.find((row) => row.versionNumber === 2);
    expect(advanced).toMatchObject({
      stockVersionId: v2Id,
      path: "tools/open-meteo/current-weather/v2",
    });
    expect(tool).toMatchObject({ currentVersionId: advanced?.id, description: V2_DESCRIPTION });
    // The binding the copy was made with is kept.
    expect(tool?.defaultConnectionId).toBe(AGENTS.follower.connection);
    const origins = await deps.tool.listToolVersionOrigins(deps.db, AGENTS.follower.person);
    expect(origins.map((row) => [row.versionNumber, row.stockVersionNumber])).toEqual([
      [2, 2],
      [1, 1],
    ]);
  });

  it("does not touch a copy nobody reached", () => {
    const { tool, versions } = copyOf(AGENTS.idle.person);
    expect(versions).toHaveLength(1);
    expect(tool?.currentVersionId).toBe(versions[0]?.id);
    expect(versions[0]?.stockVersionId).not.toBe(v2Id);
  });

  it("leaves a remix where it is, and find_tool marks it remixed", async () => {
    const harness = await connect(AGENTS.remixer.agent);
    try {
      const result = await harness.call("run_tool", { ...KEY, input: { city: "Perth" } });
      expect(body(result)).toEqual({ mine: true });
      const [hit] = body(await harness.call("find_tool", { query: "weather" })).tools as Record<
        string,
        unknown
      >[];
      expect(hit).toMatchObject({ tool: WIRE, remixed: true });
      expect(hit).not.toHaveProperty("stock");
    } finally {
      await harness.close();
    }
    const { tool, versions } = copyOf(AGENTS.remixer.person);
    expect(versions).toHaveLength(2);
    expect(tool?.currentVersionId).toBe("remix_v2");
    expect(versions.some((row) => row.stockVersionId === v2Id)).toBe(false);
  });

  it("advances once under two reaches at once", async () => {
    const [one, two] = await Promise.all([
      runAs(scopeOf(AGENTS.racer)),
      runAs({ personId: AGENTS.racer.person, agentId: RACER_TWO }),
    ]);
    expect(one).toMatchObject({ isError: false, answer: { stockVersion: 2 } });
    expect(two).toMatchObject({ isError: false, answer: { stockVersion: 2 } });
    const { versions } = copyOf(AGENTS.racer.person);
    expect(versions.map((row) => row.versionNumber).sort()).toEqual([1, 2]);
    expect(versions.filter((row) => row.stockVersionId === v2Id)).toHaveLength(1);
  });

  it("advances a copy find_tool answers, and the hit names what a run will run", async () => {
    const harness = await connect(AGENTS.finder.agent);
    try {
      const [hit] = body(await harness.call("find_tool", { query: "weather" })).tools as Record<
        string,
        unknown
      >[];
      expect(hit).toMatchObject({ tool: WIRE, stock: true, description: V2_DESCRIPTION });
    } finally {
      await harness.close();
    }
    expect(copyOf(AGENTS.finder.person).versions.map((row) => row.stockVersionId)).toContain(v2Id);
  });

  it("advances a copy the working set lists, and lists v2's definition", async () => {
    const harness = await connect(AGENTS.lister.agent);
    try {
      expect(await harness.names()).toContain(WIRE);
    } finally {
      await harness.close();
    }
    const { tool, versions } = copyOf(AGENTS.lister.person);
    expect(versions).toHaveLength(2);
    expect(tool?.description).toBe(V2_DESCRIPTION);
  });
});

/**
 * GRA-245 (ADR 0008 as amended 2026-10-09): a stock write tool's approval across its updates. The
 * catalogue gains a write tool beside the weather one, at v1; the person approves it for the agent;
 * then stock appends a version with the same annotations, which runs without a new ask, and one
 * that turns destructive, which asks again. A remix of an approved write tool asks again once.
 */
describe("a stock tool's approval across its updates", () => {
  const PLACE = { vendor: "open-meteo", name: "save-place" };
  const PLACE_WIRE = "open-meteo__save-place";
  const PLACE_STOCK_ID = "stock_place";
  const WRITE = { readOnly: false, destructive: false };
  const moduleOf = (version: number) => `export default async () => ({ saved: ${version} });\n`;

  const scopeOf = (entry: { person: string; agent: string }) => ({
    personId: entry.person,
    agentId: entry.agent,
  });
  /** Stock appends a version of the write tool, as the boot appends a changed workspace's tool. */
  const appendStock = (versionNumber: number, annotations: typeof WRITE) => {
    const weatherV1 = [...catalogue.versions.values()].find(
      (row) => row.versionNumber === 1 && row.stockToolId !== PLACE_STOCK_ID,
    );
    if (!weatherV1) throw new Error("the catalogue holds no weather v1");
    const id = `stock_place_v${versionNumber}`;
    catalogue.versions.set(id, {
      ...weatherV1,
      id,
      stockToolId: PLACE_STOCK_ID,
      versionNumber,
      sourceHash: `place_v${versionNumber}`,
      description: "Saves a named place to the person's list, as stock writes it.",
      readOnly: annotations.readOnly,
      destructive: annotations.destructive,
      files: [{ path: "index.ts", content: moduleOf(versionNumber) }],
      checkOutput: { refusals: [], advice: [], annotations },
    });
    store.stockVersionNumbers.set(id, versionNumber);
  };
  /** The person's copy of the write tool. */
  const placeOf = (person: string) =>
    [...store.tools.values()].find(
      (row) => row.personId === person && row.vendor === PLACE.vendor && row.name === PLACE.name,
    );
  /** The tool asks opened for this agent, answered or not. */
  const asksOf = (agent: string) =>
    [...store.pendingActions.values()].filter(
      (row) => row.agentId === agent && row.kind === "tool",
    );
  /** The person answers yes, as the console's card records it. */
  const allow = async (entry: { person: string; agent: string }) => {
    const tool = placeOf(entry.person);
    if (!tool) throw new Error("no copy to approve");
    await setApproval({ db: deps.db }, scopeOf(entry), tool.id, "allow", deps.approval);
  };

  beforeAll(async () => {
    catalogue.tools.set(PLACE_STOCK_ID, {
      id: PLACE_STOCK_ID,
      vendor: PLACE.vendor,
      name: PLACE.name,
      createdAt: new Date(),
    });
    appendStock(1, WRITE);
    for (const entry of [AGENTS.approver, AGENTS.remixWriter]) {
      expect(await ensureToolForAgent(deps, scopeOf(entry), PLACE)).toMatchObject({
        ok: true,
        copied: true,
      });
      await allow(entry);
    }
  });

  it("runs an approved write tool after stock advances it with the same annotations, and asks again once it turns destructive", async () => {
    const harness = await connect(AGENTS.approver.agent);
    try {
      expect(body(await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } }))).toEqual({
        saved: 1,
      });

      appendStock(2, WRITE);
      const advanced = await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } });
      expect(advanced.isError ?? false).toBe(false);
      expect(body(advanced)).toEqual({ saved: 2 });
      expect(asksOf(AGENTS.approver.agent)).toEqual([]);

      appendStock(3, { readOnly: false, destructive: true });
      const widened = await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } });
      expect(body(widened)).toMatchObject({ reason: "awaiting_approval" });
      const [ask] = asksOf(AGENTS.approver.agent);
      expect(ask?.payload).toMatchObject({
        toolName: PLACE_WIRE,
        annotations: { readOnlyHint: false, destructiveHint: true },
        provenance: "stock",
        note: "Ready-made by Graft and reviewed before release.",
      });
      expect(widened.structuredContent).toMatchObject({
        card: {
          tool: {
            provenance: {
              badge: "Ready-made by Graft",
              note: "Ready-made by Graft and reviewed before release.",
            },
          },
        },
      });

      await allow(AGENTS.approver);
      expect(body(await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } }))).toEqual({
        saved: 3,
      });
    } finally {
      await harness.close();
    }
  });

  it("asks again once for a remix of an approved write tool, and the yes then holds", async () => {
    const entry = AGENTS.remixWriter;
    const tool = placeOf(entry.person);
    const [first] = [...store.versions.values()].filter((row) => row.toolId === tool?.id);
    if (!tool || !first) throw new Error("the remix writer holds no copy");
    // The agent publishes its own version on the copy: no stock origin, the same annotations.
    const remixDir = join(sandbox.toolboxRoot(entry.person), "tools/open-meteo/save-place/v2");
    await mkdir(remixDir, { recursive: true });
    await writeFile(join(remixDir, "index.ts"), "export default async () => ({ mine: 2 });\n");
    store.versions.set("place_remix_v2", {
      ...first,
      id: "place_remix_v2",
      versionNumber: 2,
      path: "tools/open-meteo/save-place/v2",
      stockToolId: null,
      stockVersionId: null,
    });
    store.tools.set(tool.id, { ...tool, currentVersionId: "place_remix_v2" });

    const harness = await connect(entry.agent);
    try {
      expect(
        body(await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } })),
      ).toMatchObject({
        reason: "awaiting_approval",
      });
      expect(asksOf(entry.agent)[0]?.payload).toMatchObject({
        provenance: "remix",
        note: "Your agent's version of a ready-made tool; its description was written by your agent's model.",
      });

      await allow(entry);
      expect(body(await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } }))).toEqual({
        mine: 2,
      });
      expect(body(await harness.call("run_tool", { ...PLACE, input: { city: "Perth" } }))).toEqual({
        mine: 2,
      });
      expect(asksOf(entry.agent)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
