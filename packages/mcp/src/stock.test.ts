import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkModule } from "@graft/check";
import { loadStockCatalogue } from "@graft/core";
import { createFakeStockCatalogue } from "@graft/core/stock/testing/fake-stock-deps";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { checkStockTool, readStockWorkspace } from "@graft/stock";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
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
import { promoteToolForAgent } from "./stock-copy";
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
} as const;
const tokenOf = (agent: string) => `grft_token_${agent}`.padEnd(46, "0");

const OWN_MODULE = "export default async () => ({ mine: true });\n";

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;

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
  const catalogue = createFakeStockCatalogue();
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
      publish: {
        db: fake.db,
        store: toolbox,
        tool: fake.tool,
        mirror: createNoopToolboxMirror(),
        onMirror: () => {},
        now: () => new Date(),
        // The fake store has no concurrent transactions; `copy-stock.test.ts` races two copies.
        lockToolName: async () => {},
      },
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

      // A second run reuses the copy; find_tool now answers it as the person's tool, not stock.
      await harness.call("run_tool", { ...KEY, input: { city: "Sydney" } });
      expect(copyOf(AGENTS.runner.person).versions).toHaveLength(1);
      const [hit] = body(await harness.call("find_tool", { query: "weather" })).tools as Record<
        string,
        unknown
      >[];
      expect(hit?.tool).toBe(WIRE);
      expect(hit).not.toHaveProperty("stock");
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
