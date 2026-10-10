import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModuleCheck } from "@graft/check";
import { loadStockCatalogue } from "@graft/core";
import { createFakeStockCatalogue } from "@graft/core/stock/testing/fake-stock-deps";
import {
  createScriptedModel,
  type ModuleDraft,
  type ScriptedModel,
  type ScriptedStep,
} from "@graft/model";
import { renderSituation } from "@graft/model/prompt";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
  publishToolVersion,
} from "@graft/publish";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { checkStockTool, readStockWorkspace } from "@graft/stock";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type AcquireRunner, createAcquireRunner } from "./acquire/runner";
import type { AcquireStatus } from "./acquire/shapes";
import type { McpDeps } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { createStockToolSource } from "./tool-source";

/**
 * `acquire` meets stock end to end over the MCP server's fakes (ADR 0025; GRA-243): the real
 * catalogue loaded from `@graft/stock`'s workspace, the real copy into a toolbox on the fake
 * sandbox's disk, the real publish, the job's dry run through the real proxy to a fake Open-Meteo,
 * and a scripted model in Graft's model's seat. What is asserted is what the agent sees, what the
 * scripted model was told, and the tool rows the person's console reads.
 */

const STOCK_WIRE = "open-meteo__current-weather";
const STOCK_KEY = { vendor: "open-meteo", name: "current-weather" };
const WEATHER_GOAL = "Get the current weather in a city";

/** One person per path, so a copy one test makes is not another's starting state. */
const PEOPLE = {
  similar: { person: "p_similar", agent: "a_similar", connection: "conn_meteo_similar" },
  remix: { person: "p_remix", agent: "a_remix", connection: "conn_meteo_remix" },
  copied: { person: "p_copied", agent: "a_copied", connection: "conn_meteo_copied" },
  installed: { person: "p_installed", agent: "a_installed", connection: "conn_meteo_installed" },
  raced: { person: "p_raced", agent: "a_raced", connection: "conn_meteo_raced" },
} as const;
const tokenOf = (agent: string) => `grft_token_${agent}`.padEnd(46, "0");
const CONN_OTHER = "conn_other_remix";

/** A `$` for module source: `${D}{x}` reads as `${x}` inside the module. */
const D = "$";

/** The remix's module: the stock module's two reads, answering a sentence beside the numbers. */
const REMIX_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  `  const geo = await ctx.fetch(\`/v1/search?name=${D}{encodeURIComponent(input.city)}&count=1\`, { host: "geocoding-api.open-meteo.com" });`,
  `  if (!geo.ok) throw new Error(\`GET /v1/search ${D}{geo.status}\`);`,
  "  const place = ((await geo.json()) as { results?: { name: string; latitude: number; longitude: number }[] }).results?.[0];",
  "  if (!place) return { found: false, city: input.city };",
  `  const res = await ctx.fetch(\`/v1/forecast?latitude=${D}{place.latitude}&longitude=${D}{place.longitude}&current=temperature_2m\`, { host: "api.open-meteo.com" });`,
  `  if (!res.ok) throw new Error(\`GET /v1/forecast ${D}{res.status}\`);`,
  "  const forecast = (await res.json()) as { current: { temperature_2m: number } };",
  `  return { found: true, city: place.name, summary: \`${D}{forecast.current.temperature_2m} degrees in ${D}{place.name}\` };`,
  "};",
  "",
].join("\n");

const CITY_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};

function remixDraft(name: string): ModuleDraft {
  return {
    name,
    description: "Says the current temperature in a city as one sentence.",
    inputSchema: CITY_SCHEMA,
    files: [{ path: "index.ts", content: REMIX_MODULE }],
    testInput: { city: "Melbourne" },
    proofReads: [],
  };
}

const write = (module: ModuleDraft, note: string): ScriptedStep => ({
  on: "goal",
  answer: { kind: "write_module", draft: module, note },
});

/** The check every draft here passes: the module's reads are what the dry run proves. */
const FAKE_CHECK: ModuleCheck = async (input) => ({
  entry: input.entry,
  refusals: [],
  advice: [],
  annotations: { readOnly: true, destructive: false },
  contextMembersUsed: [],
  blobReadFields: [],
});

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let runner: AcquireRunner;

beforeAll(async () => {
  const keys = await generateTestKeys();
  const people = Object.values(PEOPLE);
  vendor = await startFakeVendor({
    keys,
    connections: people.map((entry) => ({
      id: entry.connection,
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
          results: [{ name: url.searchParams.get("name"), latitude: -37.81, longitude: 144.96 }],
        });
      }
      return Response.json({
        current: { time: "2026-10-09T19:00", temperature_2m: 17.5 },
        current_units: { temperature_2m: "°C" },
      });
    },
  });
  sandbox = createFakeSandboxBackend();

  store = createFakeStore();
  for (const entry of people) {
    store.addConnection({
      id: entry.connection,
      personId: entry.person,
      vendor: "open-meteo",
      displayName: "Open-Meteo",
      scheme: "none",
      primaryHost: "https://api.open-meteo.com/v1",
      hosts: ["geocoding-api.open-meteo.com"],
    });
    store.addAgent({
      scopeMode: "listed",
      id: entry.agent,
      personId: entry.person,
      token: tokenOf(entry.agent),
      connectionIds: entry === PEOPLE.remix ? [entry.connection, CONN_OTHER] : [entry.connection],
    });
    store.grantBuild(entry.agent, entry.connection);
  }
  store.addConnection({
    id: CONN_OTHER,
    personId: PEOPLE.remix.person,
    vendor: "other",
    primaryHost: "https://api.other.example",
  });
  store.grantBuild(PEOPLE.remix.agent, CONN_OTHER);

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
  const publish = createPublishDeps({
    db: fake.db,
    store: toolbox,
    mirror: createNoopToolboxMirror(),
    sandbox,
    metadata: createFakeMetadataSource({}),
    policy: DEFAULT_PACKAGE_POLICY,
    tool: fake.tool,
    check: FAKE_CHECK,
  });
  deps = {
    ...fake,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: FAKE_CHECK,
    runnerFiles,
    skills: loadSkills,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    listChangedWindowMs: 50,
    toolbox,
    publishTool: (args) => publishToolVersion(publish, args),
    toolSource: createStockToolSource({
      db: fake.db,
      publish,
      stock: catalogue.deps,
    }),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-acquire-stock-test-handoff-secret-long-32",
      waitMs: 0,
      ttlMs: 60_000,
    },
    notifier: createToolListChangedNotifier({ windowMs: 50 }),
    inFlight: createInFlightRegistry(),
    model: null,
    acquire: { maxAttempts: 4, tokenCeiling: 400_000 },
  };
  runner = createAcquireRunner(deps, {
    concurrency: 1,
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 60,
    heartbeatMs: 200,
  });
  deps.acquireRunner = runner;
}, 60_000);

afterAll(async () => {
  runner.stop();
  deps.notifier?.close();
  deps.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

afterEach(() => {
  deps.model = null;
});

async function connect(agent: string) {
  const notifier = deps.notifier;
  if (!notifier) throw new Error("the fixture has no notifier");
  const session = await openAgentSession(deps, tokenOf(agent), notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await session.close();
    },
  };
}

function body<T = Record<string, unknown>>(result: CallToolResult): T {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text) as T;
}

/** Start a job through the meta-tool and run it to its end. */
async function acquireAndFinish(
  harness: Awaited<ReturnType<typeof connect>>,
  args: Record<string, unknown>,
) {
  const started = body(await harness.call("acquire", args));
  expect(started.jobId, JSON.stringify(started)).toEqual(expect.any(String));
  await runner.idle();
  const status = body<AcquireStatus>(
    await harness.call("acquire_status", { jobId: started.jobId }),
  );
  return { started, status, jobId: started.jobId as string };
}

/** The person's tool of a name, if they hold one, and its versions oldest first. */
function toolOf(person: string, key: { vendor: string; name: string }) {
  const tool = [...store.tools.values()].find(
    (row) => row.personId === person && row.vendor === key.vendor && row.name === key.name,
  );
  const versions = [...store.versions.values()]
    .filter((row) => row.toolId === tool?.id)
    .sort((a, b) => a.versionNumber - b.versionNumber);
  return { tool, versions };
}

/** What the scripted model was shown first: the goal situation as the provider renders it. */
function goalPrompt(model: ScriptedModel): string {
  const record = model.conversations.at(-1);
  if (!record) throw new Error("the model opened no conversation");
  return renderSituation(record.context, { kind: "goal" });
}

describe("acquire against a goal a stock tool covers", () => {
  it("answers similar_tools_exist with the stock hit flagged stock and the nudge, and starts no job", async () => {
    deps.model = createScriptedModel([]);
    const harness = await connect(PEOPLE.similar.agent);
    try {
      const jobsBefore = store.acquireJobs.size;
      const result = await harness.call("acquire", {
        connectionId: PEOPLE.similar.connection,
        goal: WEATHER_GOAL,
      });
      expect(result.isError).toBe(true);
      const answer = body(result);
      expect(answer).toMatchObject({ error: "refused", reason: "similar_tools_exist" });
      expect(answer.tools).toEqual([
        expect.objectContaining({
          vendor: "open-meteo",
          name: "current-weather",
          tool: STOCK_WIRE,
          stock: true,
          inputSchema: expect.objectContaining({ required: ["city"] }),
          annotations: { readOnlyHint: true, destructiveHint: false },
        }),
      ]);
      const message = String(answer.message);
      expect(message).toContain("A ready-made tool covers this goal");
      expect(message).toContain("run_tool");
      expect(message).toContain(`from: "${STOCK_WIRE}"`);
      expect(message).toContain("ignoreExisting: true");
      expect(store.acquireJobs.size).toBe(jobsBefore);
      // Nothing was copied by the answer: a copy is a run's, a promote's or a remix's.
      expect(toolOf(PEOPLE.similar.person, STOCK_KEY).tool).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("starts a job for a new tool with ignoreExisting: true, and tells the model the vendor's stock tools", async () => {
    const model = createScriptedModel([
      write(
        { ...remixDraft("temperature-sentence"), description: "The temperature as a sentence." },
        "A sentence, not the numbers.",
      ),
    ]);
    deps.model = model;
    const harness = await connect(PEOPLE.similar.agent);
    try {
      const { status } = await acquireAndFinish(harness, {
        connectionId: PEOPLE.similar.connection,
        goal: WEATHER_GOAL,
        ignoreExisting: true,
      });
      expect(status).toMatchObject({
        status: "succeeded",
        result: { tool: "open-meteo__temperature-sentence", version: 1 },
      });
      const [record] = model.conversations;
      expect(record?.context.stockTools).toEqual([
        expect.objectContaining({ tool: STOCK_WIRE, inputSchema: expect.any(Object) }),
      ]);
      expect(record?.context.startingPoint ?? null).toBeNull();
      const prompt = goalPrompt(model);
      expect(prompt).toContain("## Ready-made tools this vendor already has");
      expect(prompt).toContain(`\`${STOCK_WIRE}\`: Get the current weather in a city`);
      expect(prompt).toContain("Inputs: city (string, required).");
      expect(prompt).not.toContain("## Starting point");
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe("a remix with from", () => {
  it("copies the stock tool in first, hands its module to the model, and publishes v2 of the copy with no stock origin", async () => {
    const model = createScriptedModel([
      // The draft names itself otherwise; a remix is published under the tool's name regardless.
      write(remixDraft("weather-sentence"), "Answer a sentence beside the numbers."),
    ]);
    deps.model = model;
    const harness = await connect(PEOPLE.remix.agent);
    try {
      expect(toolOf(PEOPLE.remix.person, STOCK_KEY).tool).toBeUndefined();
      const { status } = await acquireAndFinish(harness, {
        connectionId: PEOPLE.remix.connection,
        goal: "Answer the weather as one sentence",
        from: STOCK_WIRE,
      });
      expect(status).toMatchObject({
        status: "succeeded",
        result: { tool: STOCK_WIRE, name: "current-weather", version: 2 },
      });

      const { tool, versions } = toolOf(PEOPLE.remix.person, STOCK_KEY);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.stockToolId).toMatch(/^stock_/);
      expect(versions[0]?.stockVersionId).toMatch(/^stock_/);
      expect(versions[1]).toMatchObject({ stockToolId: null, stockVersionId: null });
      expect(tool?.currentVersionId).toBe(versions[1]?.id);
      expect(tool?.description).toBe("Says the current temperature in a city as one sentence.");
      expect(
        [...store.tools.values()].some(
          (row) => row.personId === PEOPLE.remix.person && row.name === "weather-sentence",
        ),
      ).toBe(false);

      // The model was handed the stock module as its starting point, and the vendor's stock.
      const [record] = model.conversations;
      expect(record?.context.startingPoint).toMatchObject({
        tool: STOCK_WIRE,
        name: "current-weather",
        version: 1,
        stock: true,
        files: [expect.objectContaining({ path: "index.ts" })],
      });
      const prompt = goalPrompt(model);
      expect(prompt).toContain(`## Starting point: \`${STOCK_WIRE}\` v1`);
      expect(prompt).toContain('{ host: "geocoding-api.open-meteo.com" }');
      expect(prompt).toContain("`name` is `current-weather`");

      // The remix runs as the person's tool.
      const run = body(await harness.call("run_tool", { ...STOCK_KEY, input: { city: "Hobart" } }));
      expect(run).toMatchObject({ found: true, summary: "17.5 degrees in Hobart" });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("remixes a copy the person already holds without copying again, and a toolbox tool of their own", async () => {
    const harness = await connect(PEOPLE.copied.agent);
    try {
      // The first run copies the stock tool in (GRA-238).
      await harness.call("run_tool", { ...STOCK_KEY, input: { city: "Perth" } });
      expect(toolOf(PEOPLE.copied.person, STOCK_KEY).versions).toHaveLength(1);

      deps.model = createScriptedModel([write(remixDraft("current-weather"), "A sentence.")]);
      const { status } = await acquireAndFinish(harness, {
        connectionId: PEOPLE.copied.connection,
        goal: "Answer the weather as one sentence",
        from: STOCK_WIRE,
      });
      expect(status).toMatchObject({ status: "succeeded", result: { version: 2 } });
      const { versions } = toolOf(PEOPLE.copied.person, STOCK_KEY);
      expect(versions.map((row) => row.stockVersionId === null)).toEqual([false, true]);

      // A remix of a remix is simply a new version, as a repair is.
      const model = createScriptedModel([write(remixDraft("current-weather"), "Again.")]);
      deps.model = model;
      const again = await acquireAndFinish(harness, {
        connectionId: PEOPLE.copied.connection,
        goal: "Answer the weather as one sentence, again",
        from: STOCK_WIRE,
      });
      expect(again.status).toMatchObject({ status: "succeeded", result: { version: 3 } });
      expect(model.conversations[0]?.context.startingPoint).toMatchObject({
        version: 2,
        stock: false,
      });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("hands the model the authored module alone, never what the install wrote into the version", async () => {
    const harness = await connect(PEOPLE.installed.agent);
    try {
      await harness.call("run_tool", { ...STOCK_KEY, input: { city: "Perth" } });
      const [copied] = toolOf(PEOPLE.installed.person, STOCK_KEY).versions;
      if (!copied) throw new Error("no copy");
      const root = join(sandbox.toolboxRoot(PEOPLE.installed.person), copied.path);
      await mkdir(join(root, "node_modules", "some-sdk"), { recursive: true });
      await writeFile(join(root, "node_modules", "some-sdk", "index.js"), "module.exports = {};\n");
      await writeFile(join(root, "package-lock.json"), "{}\n");

      const model = createScriptedModel([write(remixDraft("current-weather"), "A sentence.")]);
      deps.model = model;
      const { status } = await acquireAndFinish(harness, {
        connectionId: PEOPLE.installed.connection,
        goal: "Answer the weather as one sentence",
        from: STOCK_WIRE,
      });
      expect(status).toMatchObject({ status: "succeeded" });
      const paths = (model.conversations[0]?.context.startingPoint?.files ?? []).map(
        (file) => file.path,
      );
      expect(paths).toContain("index.ts");
      expect(paths.some((path) => path.startsWith("node_modules/"))).toBe(false);
      expect(paths).not.toContain("package-lock.json");
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("ends remix_superseded when the tool moved off the version the remix started from", async () => {
    const harness = await connect(PEOPLE.raced.agent);
    try {
      await harness.call("run_tool", { ...STOCK_KEY, input: { city: "Perth" } });
      const { tool, versions } = toolOf(PEOPLE.raced.person, STOCK_KEY);
      const [first] = versions;
      if (!tool || !first) throw new Error("no copy");

      // Another remix lands while this one drafts: the model's first turn moves the pointer.
      const scripted = createScriptedModel([write(remixDraft("current-weather"), "A sentence.")]);
      deps.model = {
        name: scripted.name,
        open: (context) => {
          const conversation = scripted.open(context);
          return {
            turn: async (situation) => {
              if (situation.kind === "goal") {
                const landed = { ...first, id: "ver_raced_landed", versionNumber: 99 };
                store.versions.set(landed.id, landed);
                const row = store.tools.get(tool.id);
                if (row) row.currentVersionId = landed.id;
              }
              return conversation.turn(situation);
            },
          };
        },
      };
      const { status } = await acquireAndFinish(harness, {
        connectionId: PEOPLE.raced.connection,
        goal: "Answer the weather as one sentence",
        from: STOCK_WIRE,
      });
      expect(status).toMatchObject({
        status: "failed",
        result: { failure: "remix_superseded" },
      });
      expect(store.tools.get(tool.id)?.currentVersionId).toBe("ver_raced_landed");
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("refuses a from that names nothing, another vendor's tool, or no tool at all, and starts no job", async () => {
    deps.model = createScriptedModel([]);
    const harness = await connect(PEOPLE.remix.agent);
    try {
      const jobsBefore = store.acquireJobs.size;
      const unknown = body(
        await harness.call("acquire", {
          connectionId: PEOPLE.remix.connection,
          goal: "Anything",
          from: "open-meteo__no-such-tool",
        }),
      );
      expect(unknown).toMatchObject({ error: "refused", reason: "tool_not_found" });

      const otherVendor = body(
        await harness.call("acquire", {
          connectionId: CONN_OTHER,
          goal: "Anything",
          from: STOCK_WIRE,
        }),
      );
      expect(otherVendor).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(String(otherVendor.message)).toContain("open-meteo");

      const malformed = body(
        await harness.call("acquire", {
          connectionId: PEOPLE.remix.connection,
          goal: "Anything",
          from: "current-weather",
        }),
      );
      expect(malformed).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(store.acquireJobs.size).toBe(jobsBefore);
    } finally {
      await harness.close();
    }
  });
});
