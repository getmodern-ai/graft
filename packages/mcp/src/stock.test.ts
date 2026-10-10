import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkModule } from "@graft/check";
import {
  createGatewayProvider,
  keyringProvider,
  loadStockCatalogue,
  setApproval,
  toProxyConnection,
} from "@graft/core";
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
import type { McpDeps, ToolCallEvent } from "./deps";
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
  signal: { person: "p_signal", agent: "a_signal", connection: "conn_meteo_signal" },
} as const;
/** The racer's second agent, over the same connection: two reaches of one copy at once. */
const RACER_TWO = "a_racer_two";

/** A city the fake geocoder answers 503 for, with a body that must never reach an event (GRA-244). */
const FAILING_CITY = "Failing-City-Secret";
const VENDOR_BODY = "Vendor-Body-Secret";
const events: ToolCallEvent[] = [];
const tokenOf = (agent: string) => `grft_token_${agent}`.padEnd(46, "0");

/**
 * Connections matched by their hosts (GRA-241). One person holds a gateway connection under a slug
 * of their company's and two keyring connections of Open-Meteo, every one reaching both hosts the
 * manifest declares, with an agent per scope; another holds two keyring connections only, so their
 * first run finds two matches the slug cannot separate.
 */
const BOTH_HOSTS = ["geocoding-api.open-meteo.com", "api.open-meteo.com"];
const GATEWAY_URL = "https://gateway.corp.example/graft";
const MULTI = {
  person: "p_multi",
  gateway: "conn_multi_gateway",
  keyring: "conn_multi_keyring",
  keyring2: "conn_multi_keyring2",
  agents: {
    gateway: "a_multi_gateway",
    keyring: "a_multi_keyring",
    both: "a_multi_both",
  },
} as const;
const TIED = {
  person: "p_tied",
  first: "conn_tied_first",
  second: "conn_tied_second",
  agent: "a_tied",
} as const;
const gateway = createGatewayProvider({
  hosts: BOTH_HOSTS,
  upstreamUrl: GATEWAY_URL,
  headerName: "X-Deployment-Token",
  headerValue: "deployment-identity-secret-value",
});

const OWN_MODULE = "export default async () => ({ mine: true });\n";

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let catalogue: ReturnType<typeof createFakeStockCatalogue>;

/**
 * The Open-Meteo weather tool's catalogue rows, by key: the workspace holds every integration's
 * stock tools, so a suite that moves this tool's versions names it rather than taking the first.
 */
function weatherStock() {
  const tool = [...catalogue.tools.values()].find(
    (row) => row.vendor === KEY.vendor && row.name === KEY.name,
  );
  if (!tool) throw new Error("the catalogue holds no weather tool");
  const versions = [...catalogue.versions.values()].filter((row) => row.stockToolId === tool.id);
  return { tool, versions };
}

/** A person whose one connection reaches the hosts but cannot carry a call: its provider is gone. */
const UNUSABLE = {
  person: "p_unusable",
  connection: "conn_unusable",
  agent: "a_unusable",
} as const;

beforeAll(async () => {
  const keys = await generateTestKeys();
  const connected = Object.values(AGENTS).filter((entry) => entry.connection !== null);
  const keyringRows = [
    ...connected.map((entry) => ({ id: entry.connection as string, personId: entry.person })),
    { id: MULTI.keyring, personId: MULTI.person },
    { id: MULTI.keyring2, personId: MULTI.person },
    { id: TIED.first, personId: TIED.person },
    { id: TIED.second, personId: TIED.person },
  ];
  vendor = await startFakeVendor({
    keys,
    connections: keyringRows.map((row) => ({
      ...row,
      authScheme: "none",
      primaryHost: "https://api.open-meteo.com/v1",
      hosts: ["geocoding-api.open-meteo.com"],
      schemeConfig: {},
      credential: {},
    })),
    // The gateway row resolves through the deployment's providers, so its calls relay (ADR 0019).
    resolve: async (id) => {
      const row = store.connections.get(id);
      return row ? toProxyConnection(row, deps.connection.providers) : null;
    },
    respond: (request) => {
      const relayed = new URL(request.url);
      // A relayed call names the vendor's host as the gateway's first path segment.
      const url = request.url.startsWith(`${GATEWAY_URL}/`)
        ? new URL(
            `https://${relayed.pathname.slice(new URL(GATEWAY_URL).pathname.length + 1)}${relayed.search}`,
          )
        : relayed;
      if (url.hostname === "geocoding-api.open-meteo.com") {
        if (url.searchParams.get("name") === FAILING_CITY) {
          return new Response(VENDOR_BODY, { status: 503 });
        }
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
  const addMeteo = (id: string, personId: string, slug = "open-meteo") =>
    store.addConnection({
      id,
      personId,
      vendor: slug,
      displayName: id,
      scheme: "none",
      primaryHost: "https://api.open-meteo.com/v1",
      hosts: ["geocoding-api.open-meteo.com"],
    });
  const gatewayRow = addMeteo(MULTI.gateway, MULTI.person, "corp-weather");
  gatewayRow.provider = "gateway";
  gatewayRow.scheme = "gateway";
  gatewayRow.schemeConfig = {};
  gatewayRow.credentialSetAt = null;
  addMeteo(MULTI.keyring, MULTI.person);
  addMeteo(MULTI.keyring2, MULTI.person);
  addMeteo(TIED.first, TIED.person);
  addMeteo(TIED.second, TIED.person);
  addMeteo(UNUSABLE.connection, UNUSABLE.person).provider = "retired-provider";
  const scopes: [string, string, string[]][] = [
    [MULTI.agents.gateway, MULTI.person, [MULTI.gateway]],
    [MULTI.agents.keyring, MULTI.person, [MULTI.keyring]],
    [MULTI.agents.both, MULTI.person, [MULTI.keyring, MULTI.keyring2]],
    [TIED.agent, TIED.person, [TIED.first, TIED.second]],
    [UNUSABLE.agent, UNUSABLE.person, [UNUSABLE.connection]],
  ];
  for (const [agent, personId, connectionIds] of scopes) {
    store.addAgent({
      scopeMode: "listed",
      id: agent,
      personId,
      token: tokenOf(agent),
      connectionIds,
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
    connection: { ...fake.connection, providers: [gateway, keyringProvider] },
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
      },
      stock: catalogue.deps,
    }),
    onToolCall: (event) => events.push(event),
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
/**
 * GRA-244: what a hosted monitor of a stock version's failure rate reads. A run of the copy, or of
 * a remix of it, names the stock tool and version on the tool call's event; a failure adds its kind
 * and the vendor's status; nothing of the input, the output or the vendor's body is there.
 */
describe("the signal a stock tool's runs give", () => {
  const lastEventFor = (agentId: string, tool: string) =>
    events.filter((event) => event.agentId === agentId && event.tool === tool).at(-1);

  it("names the stock tool and version on a run of the copy, and its failure's shape alone", async () => {
    const harness = await connect(AGENTS.signal.agent);
    try {
      const ok = await harness.call("run_tool", { ...KEY, input: { city: "Perth" } });
      expect(ok.isError ?? false).toBe(false);
      const [version] = copyOf(AGENTS.signal.person).versions;
      const okEvent = lastEventFor(AGENTS.signal.agent, "run_tool");
      expect(okEvent).toMatchObject({
        outcome: "ok",
        stock: { toolId: version?.stockToolId, versionId: version?.stockVersionId, remix: false },
      });
      expect(okEvent?.stock).not.toHaveProperty("failureKind");
      expect(JSON.stringify(okEvent)).not.toContain("Perth");

      // The first-class name, once promoted, gives the same signal.
      await harness.call("promote", KEY);
      const failed = await harness.call(WIRE, { city: FAILING_CITY });
      expect(failed.isError).toBe(true);
      // The vendor's body reaches the model in the failure's stderr, as before; not the event.
      expect(JSON.stringify(body(failed))).toContain(VENDOR_BODY);
      const failedEvent = lastEventFor(AGENTS.signal.agent, WIRE);
      expect(failedEvent).toMatchObject({
        kind: "authored",
        outcome: "error",
        stock: {
          toolId: version?.stockToolId,
          versionId: version?.stockVersionId,
          remix: false,
          failureKind: "threw",
          vendorStatus: 503,
        },
      });
      const text = JSON.stringify(failedEvent);
      expect(text).not.toContain(FAILING_CITY);
      expect(text).not.toContain(VENDOR_BODY);
      expect(text).not.toContain("search");
    } finally {
      await harness.close();
    }
  });

  it("names the stock version a remix came from, as a remix", async () => {
    const { tool, versions } = copyOf(AGENTS.signal.person);
    const [copy] = versions;
    if (!tool || !copy) throw new Error("the copy is the previous case's");
    // The person's own version over the copy: same code, no stock origin.
    store.versions.set("ver_signal_remix", {
      ...copy,
      id: "ver_signal_remix",
      versionNumber: 2,
      stockToolId: null,
      stockVersionId: null,
    });
    store.tools.set(tool.id, { ...tool, currentVersionId: "ver_signal_remix" });
    const harness = await connect(AGENTS.signal.agent);
    try {
      await harness.call("run_tool", { ...KEY, input: { city: "Darwin" } });
      expect(lastEventFor(AGENTS.signal.agent, "run_tool")?.stock).toEqual({
        toolId: copy.stockToolId,
        versionId: copy.stockVersionId,
        remix: true,
      });
    } finally {
      await harness.close();
    }
  });

  it("gives none for a tool that never came from stock, or a call that ran nothing", async () => {
    const harness = await connect(AGENTS.owner.agent);
    try {
      await harness.call("run_tool", { ...KEY, input: {} });
      expect(lastEventFor(AGENTS.owner.agent, "run_tool")).not.toHaveProperty("stock");
      await harness.call("find_tool", { query: "weather" });
      expect(lastEventFor(AGENTS.owner.agent, "find_tool")).not.toHaveProperty("stock");
    } finally {
      await harness.close();
    }
  });
});

describe("a stock tool matches a connection by its hosts (GRA-241)", () => {
  const run = (harness: Awaited<ReturnType<typeof connect>>, extra: Record<string, unknown> = {}) =>
    harness.call("run_tool", { ...KEY, input: { city: "Perth" }, ...extra });
  const lastEventOf = (connectionId: string) =>
    vendor.events.filter((event) => event.connectionId === connectionId).at(-1);

  it("finds and runs over a gateway connection under another slug whose hosts cover the manifest", async () => {
    const harness = await connect(MULTI.agents.gateway);
    try {
      const [hit] = body(await harness.call("find_tool", { query: "current weather" }))
        .tools as Record<string, unknown>[];
      expect(hit).toMatchObject({ tool: WIRE, stock: true, connectionIds: [MULTI.gateway] });

      const result = await run(harness);
      expect(result.isError ?? false, JSON.stringify(body(result))).toBe(false);
      expect(body(result)).toMatchObject({ found: true, city: "Perth" });
      expect(lastEventOf(MULTI.gateway)).toMatchObject({ relay: "gateway", outcome: "forwarded" });
      expect(vendor.requests.at(-1)?.url).toMatch(`${GATEWAY_URL}/api.open-meteo.com/`);
      expect(copyOf(MULTI.person).tool?.defaultConnectionId).toBe(MULTI.gateway);
    } finally {
      await harness.close();
    }
  });

  it("runs the same copy over a keyring connection with the same hosts for an agent holding that one", async () => {
    const harness = await connect(MULTI.agents.keyring);
    try {
      const result = await run(harness);
      expect(result.isError ?? false, JSON.stringify(body(result))).toBe(false);
      expect(body(result)).toMatchObject({ found: true, city: "Perth" });
      expect(lastEventOf(MULTI.keyring)).toMatchObject({ outcome: "forwarded" });
      // Followed for this agent; the person's copy stays bound where it was.
      expect(copyOf(MULTI.person).tool?.defaultConnectionId).toBe(MULTI.gateway);
    } finally {
      await harness.close();
    }
  });

  it("refuses a connectionId outside the agent's scope with the scope refusal", async () => {
    const harness = await connect(MULTI.agents.keyring);
    try {
      const result = await run(harness, { connectionId: MULTI.gateway });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ reason: "connection_not_in_scope" });
      expect(body(result).message).toContain(MULTI.gateway);
    } finally {
      await harness.close();
    }
  });

  it("refuses with alternatives where two connections match and none is named, and runs over the one named", async () => {
    const harness = await connect(MULTI.agents.both);
    try {
      const refused = await run(harness);
      expect(refused.isError).toBe(true);
      expect(body(refused)).toMatchObject({
        reason: "connection_not_in_scope",
        alternatives: [{ connectionId: MULTI.keyring }, { connectionId: MULTI.keyring2 }],
      });

      const named = await run(harness, { connectionId: MULTI.keyring2 });
      expect(named.isError ?? false, JSON.stringify(body(named))).toBe(false);
      expect(body(named)).toMatchObject({ found: true, city: "Perth" });
      expect(lastEventOf(MULTI.keyring2)).toMatchObject({ outcome: "forwarded" });
    } finally {
      await harness.close();
    }
  });

  it("copies with no default on a first run that finds two matches, refuses with alternatives, and runs over the one named", async () => {
    const harness = await connect(TIED.agent);
    try {
      const [hit] = body(await harness.call("find_tool", { query: "current weather" }))
        .tools as Record<string, unknown>[];
      expect(hit).toMatchObject({ connectionIds: [TIED.first, TIED.second] });

      const refused = await run(harness);
      expect(refused.isError).toBe(true);
      expect(body(refused)).toMatchObject({
        reason: "connection_ambiguous",
        alternatives: [{ connectionId: TIED.first }, { connectionId: TIED.second }],
      });
      expect(copyOf(TIED.person).tool?.defaultConnectionId).toBeNull();

      const named = await run(harness, { connectionId: TIED.second });
      expect(named.isError ?? false, JSON.stringify(body(named))).toBe(false);
      expect(body(named)).toMatchObject({ found: true, city: "Perth" });
      expect(lastEventOf(TIED.second)).toMatchObject({ outcome: "forwarded" });
    } finally {
      await harness.close();
    }
  });
});

describe("a copy's connections are judged as the copy runs (Greptile on #185)", () => {
  const run = (harness: Awaited<ReturnType<typeof connect>>, extra: Record<string, unknown> = {}) =>
    harness.call("run_tool", { ...KEY, input: { city: "Perth" }, ...extra });

  it("refuses a named connection that cannot carry a call, and copies nothing", async () => {
    const harness = await connect(UNUSABLE.agent);
    try {
      const result = await run(harness, { connectionId: UNUSABLE.connection });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        reason: "connection_unusable",
        connectionId: UNUSABLE.connection,
      });
      expect(copyOf(UNUSABLE.person).tool).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("judges an older copy by its own stock version's hosts after the catalogue moves on", async () => {
    // Every version this file loaded is the one the copies above recorded; a later version calls a
    // host none of the person's connections reach.
    const current = weatherStock().versions.sort((a, b) => b.versionNumber - a.versionNumber)[0];
    if (!current) throw new Error("no catalogue version");
    catalogue.versions.set("stock_v_later", {
      ...current,
      id: "stock_v_later",
      versionNumber: current.versionNumber + 1,
      sourceHash: `${current.sourceHash}-later`,
      hosts: [...current.hosts, "extra.open-meteo.example"],
    });
    // A copy that has not followed (GRA-242 advances an untouched copy when it is reached; this
    // one's advance is held off, as a lost race leaves one) still runs its own version's code.
    const source = deps.toolSource;
    if (!source) throw new Error("no tool source");
    deps.toolSource = {
      ...source,
      advance: async ({ toolId, personId }) => {
        const tool = [...store.tools.values()].find(
          (row) => row.id === toolId && row.personId === personId,
        );
        if (!tool) throw new Error("no tool");
        return { advanced: false, tool };
      },
    };
    const harness = await connect(MULTI.agents.both);
    try {
      const named = await run(harness, { connectionId: MULTI.keyring2 });
      expect(named.isError ?? false, JSON.stringify(body(named))).toBe(false);
      expect(body(named)).toMatchObject({ found: true, city: "Perth" });
    } finally {
      deps.toolSource = source;
      catalogue.versions.delete("stock_v_later");
      await harness.close();
    }
  });
});

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
    const { tool: stockTool, versions: weatherVersions } = weatherStock();
    const v1 = weatherVersions.find((row) => row.versionNumber === 1);
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
    // Written to a directory of its own beside the copy's, never over it (GRA-265).
    expect(advanced).toMatchObject({
      stockVersionId: v2Id,
      path: expect.stringMatching(/^tools\/open-meteo\/current-weather\/w-/),
    });
    expect(advanced?.path).not.toBe(versions.find((row) => row.versionNumber === 1)?.path);
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
    const weatherV1 = weatherStock().versions.find((row) => row.versionNumber === 1);
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
    await setApproval({ db: deps.db }, scopeOf(entry), tool.id, "allow", deps.approval, {
      asked: {
        versionId: tool.currentVersionId,
        annotations: { readOnly: tool.readOnly, destructive: tool.destructive },
      },
    });
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
