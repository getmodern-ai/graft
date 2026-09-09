import {
  createAgent,
  DAY_MS,
  listWorkingSet,
  promoteTool,
  type ServiceContext,
  touchToolUsed,
  updateAgentLimits,
} from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McpDeps } from "./deps";
import { createInFlightRegistry, type InFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier, type ToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { runSweep, type SweepReport, startSweep } from "./sweep";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { authoredToolName } from "./tool-names";

/**
 * The sweep through the MCP client (GRA-1's primary seam): what a harness observes when the rule
 * contracts its agent's working set — the list, the notification, `find_tool` still finding the tool
 * — and what the record says. The services are the real ones over the in-memory fakes with one
 * controllable clock; the sandbox is the fake backing, because holding an agent in flight takes a
 * real process. No vendor and no proxy: nothing here runs an authored tool, and the in-flight hold is
 * the same wrapper (`heldInFlight`) whichever call path takes it.
 */

const PERSON = "person_1";
const T0 = new Date("2026-09-01T09:00:00Z");
let clock = T0;
const advance = (days: number) => {
  clock = new Date(clock.getTime() + days * DAY_MS);
};

let store: FakeStore;
let deps: McpDeps;
let ctx: ServiceContext;
let sandbox: FakeSandboxBackend;
let notifier: ToolListChangedNotifier;
let inFlight: InFlightRegistry;
let counter = 0;

beforeAll(() => {
  store = createFakeStore({ now: () => clock });
  sandbox = createFakeSandboxBackend();
  notifier = createToolListChangedNotifier({ windowMs: 50 });
  inFlight = createInFlightRegistry();
  const fake = createFakeDeps(store);
  ctx = { db: fake.db };
  deps = {
    ...fake,
    sandbox,
    keys: null,
    proxyPublicUrl: "http://localhost:3000/api/proxy",
    checkModule: async () => ({
      entry: null,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    }),
    runnerFiles: async () => [],
    skills: async () => [],
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    listChangedWindowMs: 50,
    notifier,
    inFlight,
    now: () => clock,
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-sweep-test-handoff-secret-that-is-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
});

afterAll(async () => {
  notifier.close();
  inFlight.close();
  await sandbox.close();
});

const principal = { personId: PERSON };
const scopeOf = (agentId: string) => ({ personId: PERSON, agentId });

/** A fresh agent with its own token, so each case's list is its own. */
function addAgent(name: string) {
  const id = `agent_${name}_${++counter}`;
  const token = `grft_${id}_${"0".repeat(32)}`;
  store.addAgent({ id, personId: PERSON, token, name });
  return { id, token, scope: scopeOf(id) };
}

/** A tool in the toolbox, with a version and no connection: it is listed, never run. */
function addTool(name: string) {
  const id = `tool_${name}_${++counter}`;
  store.addTool({
    id,
    personId: PERSON,
    vendor: "demo",
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    destructive: false,
    defaultConnectionId: null,
    path: `tools/demo/${name}/v1`,
  });
  return { id, wire: authoredToolName("demo", name) };
}

const promote = (agentId: string, toolId: string) =>
  promoteTool(ctx, scopeOf(agentId), toolId, "agent", deps.workingSet);
const touch = (agentId: string, toolId: string) =>
  touchToolUsed(ctx, scopeOf(agentId), toolId, deps.workingSet);
const workingSetIds = async (agentId: string) =>
  (await listWorkingSet(ctx, scopeOf(agentId), deps.workingSet)).map((e) => e.toolId).sort();

/** The clock moves forward for every test, so a report may carry earlier agents' tools too. */
const demotedFor = (report: SweepReport, agentId: string) =>
  report.demoted.filter((d) => d.agentId === agentId);

/** A harness: the SDK's client over the in-memory pair, on the process's shared notifier. */
async function connect(token: string) {
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  const notifications: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notifications.push(Date.now());
  });
  await client.connect(clientTransport);
  return {
    notifications,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await session.close();
    },
  };
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe("the idle window", () => {
  it("a promoted tool unused past the window disappears from the list after a sweep, the client is notified, and find_tool still returns it", async () => {
    const agent = addAgent("idle");
    const tool = addTool("list-orders");
    await promote(agent.id, tool.id);
    const a = await connect(agent.token);
    try {
      expect(await a.names()).toContain(tool.wire);

      advance(22);
      const report = await runSweep(ctx, deps, clock);
      expect(demotedFor(report, agent.id)).toEqual([
        { agentId: agent.id, toolId: tool.id, cause: "idle" },
      ]);

      expect(await a.names()).not.toContain(tool.wire);
      await until(() => a.notifications.length >= 1);
      expect(a.notifications.length).toBeGreaterThanOrEqual(1);

      // Demoted, not deleted (ADR 0009): the toolbox still has it, one promote away.
      const found = body(await a.call("find_tool", { query: "list-orders" }));
      expect(found.tools).toEqual([
        expect.objectContaining({ vendor: "demo", name: "list-orders", promoted: false }),
      ]);
      expect(store.tools.has(tool.id)).toBe(true);

      // The record carries the cause (ADR 0012), and a second sweep has nothing more to say.
      expect(store.changes.at(-1)).toMatchObject({
        agentId: agent.id,
        toolId: tool.id,
        change: "demote",
        cause: "idle",
      });
      expect(demotedFor(await runSweep(ctx, deps, clock), agent.id)).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("applies the schema's defaults to a new agent and lets the row's own fields override them", async () => {
    const plain = await createAgent(ctx, principal, { name: "defaults" }, deps.agent);
    expect(plain.agent).toMatchObject({ workingSetCap: 20, idleWindowDays: 21 });
    const tuned = await createAgent(
      ctx,
      principal,
      { name: "tuned", idleWindowDays: 30 },
      deps.agent,
    );
    const plainTool = addTool("plain-tool");
    const tunedTool = addTool("tuned-tool");
    await promote(plain.agent.id, plainTool.id);
    await promote(tuned.agent.id, tunedTool.id);

    advance(22);
    const first = await runSweep(ctx, deps, clock);
    expect(demotedFor(first, plain.agent.id)).toEqual([
      { agentId: plain.agent.id, toolId: plainTool.id, cause: "idle" },
    ]);
    expect(demotedFor(first, tuned.agent.id)).toEqual([]);

    advance(9);
    const second = await runSweep(ctx, deps, clock);
    expect(demotedFor(second, tuned.agent.id)).toEqual([
      { agentId: tuned.agent.id, toolId: tunedTool.id, cause: "idle" },
    ]);
  });
});

describe("the cap", () => {
  it("with cap 2 and three tools promoted, the least recently used one is demoted and the two used remain", async () => {
    const agent = addAgent("capped");
    await updateAgentLimits(ctx, principal, agent.id, { workingSetCap: 2 }, deps.agent);
    const [unused, usedA, usedB] = [addTool("unused"), addTool("used-a"), addTool("used-b")];
    for (const tool of [unused, usedA, usedB]) await promote(agent.id, tool.id);

    advance(1);
    await touch(agent.id, usedA.id);
    await touch(agent.id, usedB.id);
    advance(1);

    const report = await runSweep(ctx, deps, clock);
    expect(demotedFor(report, agent.id)).toEqual([
      { agentId: agent.id, toolId: unused.id, cause: "cap" },
    ]);
    expect(await workingSetIds(agent.id)).toEqual([usedA.id, usedB.id].sort());
    expect(store.changes.at(-1)).toMatchObject({ toolId: unused.id, cause: "cap" });
  });

  /** ADR 0009: the cap is a backstop, not a hard limit. */
  it("never demotes a tool used inside the window by the cap rule, so a set of fresh tools may exceed the cap", async () => {
    const agent = addAgent("fresh");
    await updateAgentLimits(ctx, principal, agent.id, { workingSetCap: 1 }, deps.agent);
    const tools = [addTool("fresh-a"), addTool("fresh-b"), addTool("fresh-c")];
    for (const tool of tools) {
      await promote(agent.id, tool.id);
      await touch(agent.id, tool.id);
    }
    advance(1);

    const report = await runSweep(ctx, deps, clock);
    expect(demotedFor(report, agent.id)).toEqual([]);
    expect(await workingSetIds(agent.id)).toHaveLength(3);
  });
});

describe("a run in flight", () => {
  it("skips the agent while a command runs, and demotes on the next sweep", async () => {
    const agent = addAgent("busy");
    const tool = addTool("busy-tool");
    await promote(agent.id, tool.id);
    advance(30);
    const a = await connect(agent.token);
    try {
      const pending = a.call("run_command", { command: "sleep 1" });
      await until(() => inFlight.has(agent.id));

      const during = await runSweep(ctx, deps, clock);
      expect(during.skipped).toContain(agent.id);
      expect(demotedFor(during, agent.id)).toEqual([]);
      expect(await a.names()).toContain(tool.wire);

      expect(body(await pending)).toMatchObject({ exitCode: 0 });
      expect(inFlight.has(agent.id)).toBe(false);

      const after = await runSweep(ctx, deps, clock);
      expect(after.skipped).not.toContain(agent.id);
      expect(demotedFor(after, agent.id)).toEqual([
        { agentId: agent.id, toolId: tool.id, cause: "idle" },
      ]);
      expect(await a.names()).not.toContain(tool.wire);
    } finally {
      await a.close();
    }
  });

  it("holds a detached run by its process name until wait_for_process reports it finished", async () => {
    const agent = addAgent("detached");
    const tool = addTool("detached-tool");
    await promote(agent.id, tool.id);
    advance(30);
    const a = await connect(agent.token);
    try {
      const started = body(await a.call("run_command", { command: "sleep 1", detached: true }));
      expect(started.status).toBe("running");
      const processName = started.processName as string;
      expect(inFlight.has(agent.id)).toBe(true);

      const during = await runSweep(ctx, deps, clock);
      expect(during.skipped).toContain(agent.id);
      expect(await a.names()).toContain(tool.wire);

      const waited = body(await a.call("wait_for_process", { processName, maxWaitSeconds: 10 }));
      expect(waited.status).toBe("completed");
      expect(inFlight.has(agent.id)).toBe(false);

      const after = await runSweep(ctx, deps, clock);
      expect(demotedFor(after, agent.id)).toEqual([
        { agentId: agent.id, toolId: tool.id, cause: "idle" },
      ]);
    } finally {
      await a.close();
    }
  });
});

describe("the report", () => {
  it("counts only agents whose token resolves, and under apply: false decides without demoting or notifying", async () => {
    const revoked = addAgent("revoked");
    const revokedTool = addTool("revoked-tool");
    await promote(revoked.id, revokedTool.id);
    const row = store.agents.get(revoked.id);
    if (!row) throw new Error("no row");
    store.agents.set(revoked.id, { ...row, revokedAt: clock });

    const planned = addAgent("planned");
    const plannedTool = addTool("planned-tool");
    await promote(planned.id, plannedTool.id);
    advance(30);

    const changesBefore = store.changes.length;
    const plan = await runSweep(ctx, deps, clock, { apply: false });
    expect(plan.at).toBe(clock.toISOString());
    expect(plan.agents).toBe([...store.agents.values()].filter((a) => !a.revokedAt).length);
    expect(demotedFor(plan, revoked.id)).toEqual([]);
    expect(demotedFor(plan, planned.id)).toEqual([
      { agentId: planned.id, toolId: plannedTool.id, cause: "idle" },
    ]);
    expect(await workingSetIds(planned.id)).toEqual([plannedTool.id]);
    expect(store.changes.length).toBe(changesBefore);
    expect(plan.failed).toEqual([]);

    // The revoked agent's working set is left as its history left it.
    expect(store.isPromoted(revoked.id, revokedTool.id)).toBe(true);
  });

  it("names an agent whose sweep threw and sweeps the others regardless", async () => {
    const broken = addAgent("broken");
    const fine = addAgent("fine");
    const fineTool = addTool("fine-tool");
    await promote(fine.id, fineTool.id);
    advance(30);

    const failing: McpDeps = {
      ...deps,
      ledger: {
        ...deps.ledger,
        lastUsedAtByTool: async (_db, scope) => {
          if (scope.agentId === broken.id) throw new Error("ledger unavailable");
          return deps.ledger.lastUsedAtByTool(_db, scope);
        },
      },
    };
    const report = await runSweep(ctx, failing, clock);
    expect(report.failed).toEqual([{ agentId: broken.id, error: "ledger unavailable" }]);
    expect(demotedFor(report, fine.id)).toEqual([
      { agentId: fine.id, toolId: fineTool.id, cause: "idle" },
    ]);
  });
});

describe("the scheduler", () => {
  it("sweeps on its interval with the clock it is given, and stops", async () => {
    const agent = addAgent("scheduled");
    const tool = addTool("scheduled-tool");
    await promote(agent.id, tool.id);
    advance(30);

    const reports: SweepReport[] = [];
    const handle = startSweep(deps, {
      intervalSeconds: 0.05,
      now: () => clock,
      onReport: (report) => reports.push(report),
    });
    try {
      await until(() => reports.some((report) => demotedFor(report, agent.id).length > 0));
    } finally {
      handle.stop();
    }
    expect(reports.some((report) => demotedFor(report, agent.id).length > 0)).toBe(true);
    expect(await workingSetIds(agent.id)).toEqual([]);

    const count = reports.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(reports.length).toBe(count);
  });
});
