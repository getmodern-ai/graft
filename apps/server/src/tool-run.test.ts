import { join } from "node:path";

import { loadStockCatalogue, ServiceError } from "@graft/core";
import { createFakeStockCatalogue } from "@graft/core/stock/testing/fake-stock-deps";
import {
  createInFlightRegistry,
  createMcpDeps,
  createStockToolSource,
  type McpDeps,
  promoteToolForAgent,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { checkStockTool, readStockWorkspace } from "@graft/stock";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AgentToolRunDeps, runAgentTool } from "./tool-run";

/**
 * The console's run of a stock tool the person has not copied yet (GRA-238, Greptile on #184):
 * `runAgentTool` as `POST /api/agents/:id/tools/:vendor/:name/run` calls it, over `@graft/mcp`'s
 * fakes, the real catalogue load of `@graft/stock`'s workspace, the real copy into a toolbox on
 * the fake sandbox's disk and the real Open-Meteo module run through the real proxy to a fake
 * Open-Meteo. The console reaches stock by the road `run_tool` takes (`ensureToolForAgent`) and
 * keeps its own two rules, read-only and in the working set.
 */

const KEY = { vendor: "open-meteo", name: "current-weather" };
const PEOPLE = {
  connected: { person: "p_console", agent: "a_console", connection: "conn_meteo_console" },
  unconnected: { person: "p_bare", agent: "a_bare", connection: null },
} as const;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let mcp: McpDeps;
let deps: AgentToolRunDeps;

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: PEOPLE.connected.connection,
        personId: PEOPLE.connected.person,
        authScheme: "none",
        primaryHost: "https://api.open-meteo.com/v1",
        hosts: ["geocoding-api.open-meteo.com"],
        schemeConfig: {},
        credential: {},
      },
    ],
    respond: (request) =>
      new URL(request.url).hostname === "geocoding-api.open-meteo.com"
        ? Response.json({
            results: [
              { name: "Hobart", country: "Australia", latitude: -42.88, longitude: 147.33 },
            ],
          })
        : Response.json({
            current: {
              time: "2026-10-10T09:00",
              temperature_2m: 11.5,
              wind_speed_10m: 20.2,
              weather_code: 3,
            },
            current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
          }),
  });
  sandbox = createFakeSandboxBackend();
  store = createFakeStore();
  store.addConnection({
    id: PEOPLE.connected.connection,
    personId: PEOPLE.connected.person,
    vendor: "open-meteo",
    displayName: "Open-Meteo",
    scheme: "none",
    primaryHost: "https://api.open-meteo.com/v1",
    hosts: ["geocoding-api.open-meteo.com"],
  });
  for (const entry of Object.values(PEOPLE)) {
    store.addAgent({
      scopeMode: "listed",
      id: entry.agent,
      personId: entry.person,
      token: `grft_token_${entry.agent}`.padEnd(46, "0"),
      connectionIds: entry.connection ? [entry.connection] : [],
    });
  }

  const fake = createFakeDeps(store);
  const catalogue = createFakeStockCatalogue();
  const report = await loadStockCatalogue(
    { db: fake.db },
    await readStockWorkspace(),
    checkStockTool,
    catalogue.deps,
  );
  expect(report.refused).toEqual([]);
  const toolbox = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
  mcp = createMcpDeps({
    ...fake,
    inFlight: createInFlightRegistry(),
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-tool-run-test-handoff-secret-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
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
        lockToolName: async () => {},
      },
      stock: catalogue.deps,
    }),
  });
  deps = { agent: fake.agent, tool: fake.tool, workingSet: fake.workingSet, mcp };
}, 60_000);

afterAll(async () => {
  mcp.inFlight?.close();
  mcp.notifier?.close();
  await sandbox.close();
  await vendor.close();
});

const ctx = () => ({ db: mcp.db });

function copyOf(person: string) {
  return [...store.tools.values()].find(
    (row) => row.personId === person && row.vendor === KEY.vendor && row.name === KEY.name,
  );
}

async function refusalOf(run: Promise<unknown>): Promise<ServiceError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ServiceError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("the console's run of a stock tool not yet in the toolbox", () => {
  it("copies it in as run_tool does, then keeps the console's working-set rule until it is promoted", async () => {
    const { person, agent, connection } = PEOPLE.connected;
    expect(copyOf(person)).toBeUndefined();
    const first = await refusalOf(
      runAgentTool(
        ctx(),
        { personId: person },
        { agentId: agent, ...KEY },
        { city: "Hobart" },
        deps,
      ),
    );
    expect(first.code).toBe("CONFLICT");
    expect(first.details?.reason).toBe("tool_not_in_working_set");
    expect(copyOf(person)).toMatchObject({ readOnly: true, defaultConnectionId: connection });

    expect(await promoteToolForAgent(mcp, { personId: person, agentId: agent }, KEY)).toMatchObject(
      { ok: true, changed: true },
    );
    const run = await runAgentTool(
      ctx(),
      { personId: person },
      { agentId: agent, ...KEY },
      { city: "Hobart" },
      deps,
    );
    expect(run).toMatchObject({
      ok: true,
      result: { found: true, city: "Hobart", temperature: 11.5 },
    });
  });

  it("answers connection_needed with the connect step, not not-found, for an agent without the integration", async () => {
    const { person, agent } = PEOPLE.unconnected;
    const refused = await refusalOf(
      runAgentTool(
        ctx(),
        { personId: person },
        { agentId: agent, ...KEY },
        { city: "Hobart" },
        deps,
      ),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.details).toMatchObject({
      reason: "connection_needed",
      connect: { vendor: "open-meteo", scheme: "none" },
    });
    expect(copyOf(person)).toBeUndefined();
  });

  it("is still not found for a name neither the toolbox nor stock holds", async () => {
    const { person, agent } = PEOPLE.connected;
    const refused = await refusalOf(
      runAgentTool(
        ctx(),
        { personId: person },
        { agentId: agent, vendor: "open-meteo", name: "nothing" },
        {},
        deps,
      ),
    );
    expect(refused.code).toBe("NOT_FOUND");
  });
});
