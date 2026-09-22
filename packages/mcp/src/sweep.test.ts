import {
  BLOB_SWEEP_TMP_SUFFIX,
  BLOB_SWEEP_TTL_MS,
  createAgent,
  DAY_MS,
  listWorkingSet,
  promoteTool,
  recordBlobsWritten,
  revokeAgent,
  type ServiceContext,
  touchToolUsed,
  updateAgentLimits,
} from "@graft/core";
import { BLOB_TTL_MS } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { BLOB_TMP_SUFFIX, type BlobStore } from "@graft/toolbox";
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
import { type BlobSweptEvent, runSweep, type SweepReport, startSweep } from "./sweep";
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
      contextMembersUsed: [],
      blobReadFields: [],
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
  store.addAgent({ scopeMode: "listed", id, personId: PERSON, token, name });
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

/**
 * The blob pass (ADR 0023, "the sweep deletes"; GRA-189) over an in-memory `BlobStore` and the fake
 * rows: what the store and the record look like after a sweep, and what the hook was told. The
 * decision's clauses are `@graft/core`'s `blob-sweep.decision.test.ts`; this is the applier.
 */
describe("the blob pass", () => {
  const HOUR = 60 * 60 * 1000;
  const ABANDONED_AFTER_MS = HOUR;
  const EMPTY_COUNTS = {
    agents: 0,
    kept: 0,
    removed: 0,
    marked: 0,
    adopted: 0,
    orphansRemoved: 0,
    tmpRemoved: 0,
    deferred: 0,
    bytesRemoved: 0,
  };

  type Dir = { data?: string; meta?: string; lastWrittenAt: Date };

  /** An agent's blobs directory as a map of names to what each holds, with the six verbs over it. */
  function fakeBlobStore() {
    const dirs = new Map<string, Map<string, Dir>>();
    const removed: { agentId: string; name: string }[] = [];
    /** Every agent `list` was asked about, in order: who the pass walked. */
    const listed: string[] = [];
    const agentDirs = (agentId: string) => {
      const existing = dirs.get(agentId);
      if (existing) return existing;
      const made = new Map<string, Dir>();
      dirs.set(agentId, made);
      return made;
    };
    const store: BlobStore = {
      listAgents: async () => [...dirs.keys()].sort(),
      list: async (agentId) => {
        listed.push(agentId);
        return [...(dirs.get(agentId)?.keys() ?? [])].sort();
      },
      // Null is the store's own not-found signal (`BlobStore.readMeta`), for a directory or a sidecar that is not there.
      readMeta: async (agentId, blobId) => dirs.get(agentId)?.get(blobId)?.meta ?? null,
      exists: async (agentId, blobId) => dirs.get(agentId)?.has(blobId) ?? false,
      remove: async (agentId, name) => {
        if (dirs.get(agentId)?.delete(name)) removed.push({ agentId, name });
      },
      stat: async (agentId, name) => {
        const dir = dirs.get(agentId)?.get(name);
        if (!dir) return null;
        return { lastWrittenAt: dir.lastWrittenAt, bytes: dir.data?.length ?? null };
      },
    };
    return {
      store,
      removed,
      listed,
      put: (agentId: string, name: string, dir: Dir) => agentDirs(agentId).set(name, dir),
      has: (agentId: string, name: string) => dirs.get(agentId)?.has(name) ?? false,
    };
  }

  const sidecarOf = (
    agentId: string,
    bytes: number,
    writtenAt: Date,
    overrides: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      bytes,
      contentType: "application/pdf",
      name: "invoice.pdf",
      writtenAt: writtenAt.toISOString(),
      expiresAt: new Date(writtenAt.getTime() + 24 * HOUR).toISOString(),
      agentId,
      toolVersion: null,
      ...overrides,
    });

  /** A blob as a run would leave it: the row, and the directory with data and sidecar. */
  async function writeBlob(
    fake: ReturnType<typeof fakeBlobStore>,
    agentId: string,
    id: string,
    writtenAt: Date,
    bytes = 10,
  ) {
    const data = "x".repeat(bytes);
    fake.put(agentId, id, {
      data,
      meta: sidecarOf(agentId, bytes, writtenAt),
      lastWrittenAt: writtenAt,
    });
    await recordBlobsWritten(
      ctx,
      scopeOf(agentId),
      {
        versionId: null,
        blobs: [
          {
            id,
            bytes,
            contentType: "application/pdf",
            name: "invoice.pdf",
            expiresAt: new Date(writtenAt.getTime() + 24 * HOUR),
          },
        ],
      },
      deps.blob,
    );
  }

  const rowOf = (id: string) => store.blobs.find((row) => row.id === id);
  const sweepWith = (
    fake: ReturnType<typeof fakeBlobStore>,
    events: BlobSweptEvent[],
    apply = true,
  ) =>
    runSweep(
      ctx,
      { ...deps, blobStore: fake.store, onBlobSwept: (event) => events.push(event) },
      clock,
      { apply, abandonedWriteMs: ABANDONED_AFTER_MS },
    );

  it("removes an expired blob's directory and marks its row, marks a row whose directory is already gone, keeps a live one, and fires blob_swept per removal with the bytes", async () => {
    const agent = addAgent("blobs-expired");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "old-here", new Date(clock.getTime() - 30 * HOUR), 1_024);
    await writeBlob(fake, agent.id, "old-gone", new Date(clock.getTime() - 30 * HOUR), 512);
    await fake.store.remove(agent.id, "old-gone");
    fake.removed.length = 0;
    await writeBlob(fake, agent.id, "fresh", new Date(clock.getTime() - HOUR), 7);

    const report = await sweepWith(fake, events);

    expect(fake.has(agent.id, "old-here")).toBe(false);
    expect(fake.has(agent.id, "fresh")).toBe(true);
    expect(fake.removed).toEqual([{ agentId: agent.id, name: "old-here" }]);
    expect(rowOf("old-here")?.removedAt).toEqual(clock);
    expect(rowOf("old-gone")?.removedAt).toEqual(clock);
    expect(rowOf("fresh")?.removedAt).toBeNull();
    // The rows stay: the door reads `removed_at` as expired, never not found (GRA-187).
    expect(rowOf("old-here")).toBeDefined();
    expect(events).toEqual([
      { agentId: agent.id, personId: PERSON, blobId: "old-here", bytes: 1_024, cause: "expired" },
    ]);
    expect(report.blobs).toMatchObject({
      kept: 1,
      removed: 1,
      marked: 1,
      adopted: 0,
      orphansRemoved: 0,
      tmpRemoved: 0,
      bytesRemoved: 1_024,
    });
    // Soonest to expire first, then by id, as the repo orders them.
    expect(report.blobs.actions).toEqual([
      { agentId: agent.id, action: "mark", blobId: "old-gone", bytes: 512 },
      { agentId: agent.id, action: "remove", blobId: "old-here", bytes: 1_024, mark: true },
    ]);

    // A second sweep has nothing to say about them.
    const again = await sweepWith(fake, events);
    expect(again.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("adopts a committed directory with a sidecar and no row, with the sidecar's expiry, and removes it once that passes", async () => {
    const agent = addAgent("blobs-orphan");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    const writtenAt = new Date(clock.getTime() - 2 * HOUR);
    fake.put(agent.id, "orphan", {
      data: "y".repeat(33),
      meta: sidecarOf(agent.id, 33, writtenAt, { toolVersion: "ver_9", name: "rows.csv" }),
      lastWrittenAt: writtenAt,
    });

    const report = await sweepWith(fake, events);
    expect(report.blobs.actions).toEqual([
      expect.objectContaining({ agentId: agent.id, action: "adopt", blobId: "orphan" }),
    ]);
    expect(rowOf("orphan")).toMatchObject({
      personId: PERSON,
      agentId: agent.id,
      versionId: "ver_9",
      bytes: 33,
      contentType: "application/pdf",
      name: "rows.csv",
      expiresAt: new Date(writtenAt.getTime() + 24 * HOUR),
      createdAt: writtenAt,
      removedAt: null,
    });
    expect(fake.has(agent.id, "orphan")).toBe(true);
    expect(events).toEqual([]);

    // Past the sidecar's expiry it is a row like any other.
    advance(1);
    const later = await sweepWith(fake, events);
    expect(later.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([
      { agentId: agent.id, action: "remove", blobId: "orphan", bytes: 33, mark: true },
    ]);
    expect(fake.has(agent.id, "orphan")).toBe(false);
    expect(rowOf("orphan")?.removedAt).toEqual(clock);
    expect(events).toEqual([
      { agentId: agent.id, personId: PERSON, blobId: "orphan", bytes: 33, cause: "expired" },
    ]);
  });

  it("removes a committed directory with no row and no readable sidecar as junk, telling the hook the bytes the store saw", async () => {
    const agent = addAgent("blobs-junk");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    fake.put(agent.id, "no-sidecar", { data: "z".repeat(5), lastWrittenAt: clock });
    fake.put(agent.id, "bad-sidecar", { data: "z", meta: "{oops", lastWrittenAt: clock });
    fake.put(agent.id, "theirs", {
      data: "zz",
      meta: sidecarOf("someone_else", 2, clock),
      lastWrittenAt: clock,
    });

    const report = await sweepWith(fake, events);
    expect(fake.removed.map((r) => r.name).sort()).toEqual(["bad-sidecar", "no-sidecar", "theirs"]);
    expect(report.blobs).toMatchObject({ orphansRemoved: 3, adopted: 0, bytesRemoved: 8 });
    expect(events.map((e) => [e.blobId, e.bytes, e.cause])).toEqual([
      ["bad-sidecar", 1, "orphan"],
      ["no-sidecar", 5, "orphan"],
      ["theirs", 2, "orphan"],
    ]);
    expect(store.blobs.some((row) => row.agentId === agent.id)).toBe(false);
  });

  it("keeps a .tmp written to inside the bound and clears one older than it, with no blob_swept for either", async () => {
    const agent = addAgent("blobs-tmp");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    const writing = `writing${BLOB_TMP_SUFFIX}`;
    const abandoned = `abandoned${BLOB_TMP_SUFFIX}`;
    fake.put(agent.id, writing, {
      data: "half",
      lastWrittenAt: new Date(clock.getTime() - HOUR / 2),
    });
    fake.put(agent.id, abandoned, {
      data: "half",
      lastWrittenAt: new Date(clock.getTime() - 2 * HOUR),
    });

    const report = await sweepWith(fake, events);
    expect(fake.has(agent.id, writing)).toBe(true);
    expect(fake.has(agent.id, abandoned)).toBe(false);
    expect(report.blobs).toMatchObject({ kept: 1, tmpRemoved: 1, bytesRemoved: 4 });
    expect(report.blobs.actions).toEqual([
      { agentId: agent.id, action: "remove_tmp", name: abandoned, bytes: 4 },
    ]);
    expect(events).toEqual([]);
    expect(store.blobs.some((row) => row.agentId === agent.id)).toBe(false);

    // Once the write has stopped for longer than a run may live, it goes too.
    advance(1);
    await sweepWith(fake, events);
    expect(fake.has(agent.id, writing)).toBe(false);
  });

  it("skips an agent with a run in flight, blobs included, and sweeps them on the next pass", async () => {
    const agent = addAgent("blobs-busy");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "busy-old", new Date(clock.getTime() - 30 * HOUR));
    const a = await connect(agent.token);
    try {
      const pending = a.call("run_command", { command: "sleep 1" });
      await until(() => inFlight.has(agent.id));

      const during = await sweepWith(fake, events);
      expect(during.skipped).toContain(agent.id);
      expect(fake.has(agent.id, "busy-old")).toBe(true);
      expect(rowOf("busy-old")?.removedAt).toBeNull();

      expect(body(await pending)).toMatchObject({ exitCode: 0 });
      const after = await sweepWith(fake, events);
      expect(after.skipped).not.toContain(agent.id);
      expect(fake.has(agent.id, "busy-old")).toBe(false);
      expect(rowOf("busy-old")?.removedAt).toEqual(clock);
    } finally {
      await a.close();
    }
  });

  it("under apply: false plans every blob action and touches neither the store nor a row, and with no blob store judges nothing", async () => {
    const agent = addAgent("blobs-planned");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "plan-old", new Date(clock.getTime() - 30 * HOUR), 9);
    fake.put(agent.id, "plan-orphan", {
      data: "q",
      meta: sidecarOf(agent.id, 1, clock),
      lastWrittenAt: clock,
    });
    fake.put(agent.id, `plan${BLOB_TMP_SUFFIX}`, {
      lastWrittenAt: new Date(clock.getTime() - 9 * HOUR),
    });

    const plan = await sweepWith(fake, events, false);
    expect(plan.blobs.actions.filter((a) => a.agentId === agent.id).map((a) => a.action)).toEqual([
      "remove",
      "adopt",
      "remove_tmp",
    ]);
    expect(plan.blobs).toMatchObject({ removed: 1, adopted: 1, tmpRemoved: 1, bytesRemoved: 0 });
    expect(fake.removed).toEqual([]);
    expect(rowOf("plan-old")?.removedAt).toBeNull();
    expect(rowOf("plan-orphan")).toBeUndefined();
    expect(events).toEqual([]);

    const none = await runSweep(ctx, { ...deps, blobStore: null }, clock);
    expect(none.blobs).toEqual({ ...EMPTY_COUNTS, actions: [] });
    expect(fake.has(agent.id, "plan-old")).toBe(true);
  });

  it("names an agent whose blob pass threw and sweeps the others regardless", async () => {
    const broken = addAgent("blobs-broken");
    const fine = addAgent("blobs-fine");
    const fake = fakeBlobStore();
    await writeBlob(fake, broken.id, "broken-old", new Date(clock.getTime() - 30 * HOUR));
    await writeBlob(fake, fine.id, "fine-old", new Date(clock.getTime() - 30 * HOUR));
    const failing: BlobStore = {
      ...fake.store,
      remove: async (agentId, name) => {
        if (agentId === broken.id) throw new Error("volume read-only");
        return fake.store.remove(agentId, name);
      },
    };

    const report = await runSweep(ctx, { ...deps, blobStore: failing }, clock, {
      abandonedWriteMs: ABANDONED_AFTER_MS,
    });
    expect(report.failed).toEqual([{ agentId: broken.id, error: "volume read-only" }]);
    // The directory first, then the row: a throw between the two leaves a `mark` for next time.
    expect(rowOf("broken-old")?.removedAt).toBeNull();
    expect(fake.has(fine.id, "fine-old")).toBe(false);
    expect(rowOf("fine-old")?.removedAt).toEqual(clock);
  });

  it("reads an adoption whose id is taken as a row that exists now, keeps the blob and removes nothing (a run landed its row between the read and the adopt)", async () => {
    const agent = addAgent("blobs-race-adopt");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    const writtenAt = new Date(clock.getTime() - HOUR);
    fake.put(agent.id, "landed", {
      data: "live",
      meta: sidecarOf(agent.id, 4, writtenAt),
      lastWrittenAt: writtenAt,
    });
    // The run's row lands after the sweep read the rows and before it adopts: the fake's `stat`
    // is where the pass is mid-read, so the row is written from there.
    const racing: BlobStore = {
      ...fake.store,
      stat: async (agentId, name) => {
        if (name === "landed" && !rowOf("landed")) {
          await recordBlobsWritten(
            ctx,
            scopeOf(agentId),
            {
              versionId: "ver_live",
              blobs: [
                {
                  id: "landed",
                  bytes: 4,
                  contentType: "application/pdf",
                  expiresAt: new Date(writtenAt.getTime() + 24 * HOUR),
                },
              ],
            },
            deps.blob,
          );
        }
        return fake.store.stat(agentId, name);
      },
    };

    const report = await runSweep(
      ctx,
      { ...deps, blobStore: racing, onBlobSwept: (event) => events.push(event) },
      clock,
      { abandonedWriteMs: ABANDONED_AFTER_MS },
    );
    expect(report.failed).toEqual([]);
    expect(report.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([]);
    expect(report.blobs.adopted).toBe(0);
    expect(fake.has(agent.id, "landed")).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(rowOf("landed")).toMatchObject({ versionId: "ver_live", removedAt: null });
    expect(events).toEqual([]);
  });

  it("defers the rest of an agent's pass when a run starts after the pass began, says so on the report, and finishes next tick", async () => {
    const agent = addAgent("blobs-race-run");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "expired-a", new Date(clock.getTime() - 30 * HOUR), 3);
    await writeBlob(fake, agent.id, "expired-b", new Date(clock.getTime() - 30 * HOUR), 5);
    fake.put(agent.id, "junk", { data: "j", lastWrittenAt: clock });
    // A run begins while the pass is reading the directories, after the in-flight check that let it start.
    let release: (() => void) | null = null;
    const racing: BlobStore = {
      ...fake.store,
      list: async (agentId) => {
        if (agentId === agent.id && release === null) release = inFlight.begin(agent.id);
        return fake.store.list(agentId);
      },
    };
    const sweeping = {
      ...deps,
      blobStore: racing,
      onBlobSwept: (event: BlobSweptEvent) => events.push(event),
    };

    const during = await runSweep(ctx, sweeping, clock, { abandonedWriteMs: ABANDONED_AFTER_MS });
    expect(during.skipped).not.toContain(agent.id);
    expect(during.deferred).toEqual([agent.id]);
    // Three actions (two removes, one orphan) were decided and none applied.
    expect(during.blobs.deferred).toBe(3);
    expect(during.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([]);
    expect(fake.removed).toEqual([]);
    expect(rowOf("expired-a")?.removedAt).toBeNull();
    expect(events).toEqual([]);

    // The run ends; the next tick applies what was deferred.
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    expect(inFlight.has(agent.id)).toBe(false);
    const after = await runSweep(ctx, sweeping, clock, { abandonedWriteMs: ABANDONED_AFTER_MS });
    expect(after.deferred).toEqual([]);
    expect(fake.removed.map((r) => r.name).sort()).toEqual(["expired-a", "expired-b", "junk"]);
    expect(rowOf("expired-a")?.removedAt).toEqual(clock);
    expect(rowOf("expired-b")?.removedAt).toEqual(clock);
    expect(events).toHaveLength(3);
  });

  it("treats a failed sidecar read as the agent's failure, never as an absent sidecar: the directory stays and is judged next tick", async () => {
    const agent = addAgent("blobs-unreadable");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    const writtenAt = new Date(clock.getTime() - HOUR);
    fake.put(agent.id, "flaky", {
      data: "ok",
      meta: sidecarOf(agent.id, 2, writtenAt),
      lastWrittenAt: writtenAt,
    });
    let failReads = true;
    const flaky: BlobStore = {
      ...fake.store,
      readMeta: async (agentId, blobId) => {
        if (failReads && agentId === agent.id) throw new Error("EIO: backing unavailable");
        return fake.store.readMeta(agentId, blobId);
      },
    };
    const sweeping = {
      ...deps,
      blobStore: flaky,
      onBlobSwept: (event: BlobSweptEvent) => events.push(event),
    };

    const failed = await runSweep(ctx, sweeping, clock, { abandonedWriteMs: ABANDONED_AFTER_MS });
    expect(failed.failed).toEqual([{ agentId: agent.id, error: "EIO: backing unavailable" }]);
    expect(fake.has(agent.id, "flaky")).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(rowOf("flaky")).toBeUndefined();
    expect(events).toEqual([]);

    // Once the read works, the same directory is adopted, not removed.
    failReads = false;
    const recovered = await runSweep(ctx, sweeping, clock, {
      abandonedWriteMs: ABANDONED_AFTER_MS,
    });
    expect(recovered.failed).toEqual([]);
    expect(rowOf("flaky")).toMatchObject({ bytes: 2, removedAt: null });
    expect(fake.has(agent.id, "flaky")).toBe(true);
  });

  it("adopts from what the store measured, not from the sidecar: the real size, and an expiry clamped to the last write plus the TTL", async () => {
    const agent = addAgent("blobs-forged");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    const lastWrittenAt = new Date(clock.getTime() - HOUR);
    fake.put(agent.id, "forged", {
      data: "x".repeat(900),
      meta: sidecarOf(agent.id, 1, lastWrittenAt, {
        expiresAt: new Date(clock.getTime() + 365 * 24 * HOUR).toISOString(),
        writtenAt: new Date(clock.getTime() + 10 * 24 * HOUR).toISOString(),
      }),
      lastWrittenAt,
    });

    await sweepWith(fake, events);
    expect(rowOf("forged")).toMatchObject({
      bytes: 900,
      createdAt: lastWrittenAt,
      expiresAt: new Date(lastWrittenAt.getTime() + 24 * HOUR),
    });
  });

  it("sweeps a revoked agent's blobs on the same rule (GRA-195): an expired one is removed and marked and its junk cleared on the next pass, a live one stays until its expiry, and the roster is whoever has rows or a directory", async () => {
    const agent = addAgent("blobs-revoked");
    const idle = addAgent("blobs-idle");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "revoked-old", new Date(clock.getTime() - 30 * HOUR), 64);
    await writeBlob(fake, agent.id, "revoked-live", new Date(clock.getTime() - HOUR), 16);
    fake.put(agent.id, "revoked-junk", {
      data: "?",
      lastWrittenAt: new Date(clock.getTime() - 2 * HOUR),
    });
    expect(await revokeAgent(ctx, principal, agent.id, deps.agent)).toMatchObject({
      id: agent.id,
      revokedAt: clock,
    });

    const report = await sweepWith(fake, events);

    // Out of the working-set roster (its token resolves to nothing), in the blob pass's.
    expect(fake.listed).toContain(agent.id);
    expect(report.blobs.agents).toBe(new Set(fake.listed).size);
    // An agent with neither a row nor a directory is nobody's business this pass.
    expect(fake.listed).not.toContain(idle.id);
    expect(report.skipped).not.toContain(agent.id);
    expect(report.failed).toEqual([]);
    expect(fake.has(agent.id, "revoked-old")).toBe(false);
    expect(rowOf("revoked-old")?.removedAt).toEqual(clock);
    expect(fake.has(agent.id, "revoked-junk")).toBe(false);
    expect(fake.has(agent.id, "revoked-live")).toBe(true);
    expect(rowOf("revoked-live")?.removedAt).toBeNull();
    expect(events).toEqual([
      { agentId: agent.id, personId: PERSON, blobId: "revoked-old", bytes: 64, cause: "expired" },
      { agentId: agent.id, personId: PERSON, blobId: "revoked-junk", bytes: 1, cause: "orphan" },
    ]);
    expect(report.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([
      { agentId: agent.id, action: "remove", blobId: "revoked-old", bytes: 64, mark: true },
      { agentId: agent.id, action: "remove_orphan", blobId: "revoked-junk", bytes: 1 },
    ]);

    // Past its expiry the live one goes too: the same 24 hour rule as any agent's, revoked or not.
    const later = new Date(clock.getTime() + 25 * HOUR);
    const after = await runSweep(
      ctx,
      { ...deps, blobStore: fake.store, onBlobSwept: (event) => events.push(event) },
      later,
      { abandonedWriteMs: ABANDONED_AFTER_MS },
    );
    expect(after.blobs.actions).toContainEqual({
      agentId: agent.id,
      action: "remove",
      blobId: "revoked-live",
      bytes: 16,
      mark: true,
    });
    expect(fake.has(agent.id, "revoked-live")).toBe(false);
    // Marked at the service's clock, as every mark is; the row stays for the door.
    expect(rowOf("revoked-live")).toMatchObject({ id: "revoked-live", removedAt: clock });
    expect(events).toHaveLength(3);
  });

  it("walks an agent the database no longer holds off the store's listing alone (GRA-195): its directories are kept inside the TTL, then cleared as junk with no row written and no event, and a stale .tmp goes by the bound", async () => {
    const agent = addAgent("blobs-deleted");
    const fake = fakeBlobStore();
    const events: BlobSweptEvent[] = [];
    await writeBlob(fake, agent.id, "deleted-blob", new Date(clock.getTime() - 2 * HOUR), 32);
    fake.put(agent.id, `deleted${BLOB_TMP_SUFFIX}`, {
      data: "xx",
      lastWrittenAt: new Date(clock.getTime() - 9 * HOUR),
    });
    // Deleted by hand: the agent row goes and, by the schema's cascade, every blob row with it.
    store.agents.delete(agent.id);
    for (let index = store.blobs.length - 1; index >= 0; index -= 1) {
      if (store.blobs[index]?.agentId === agent.id) store.blobs.splice(index, 1);
    }

    const first = await sweepWith(fake, events);
    expect(fake.listed).toContain(agent.id);
    expect(first.failed).toEqual([]);
    expect(first.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([
      { agentId: agent.id, action: "remove_tmp", name: `deleted${BLOB_TMP_SUFFIX}`, bytes: 2 },
    ]);
    // Inside the TTL: kept, and never adopted, since there is no agent to adopt it into.
    expect(fake.has(agent.id, "deleted-blob")).toBe(true);
    expect(rowOf("deleted-blob")).toBeUndefined();

    const later = new Date(clock.getTime() + 25 * HOUR);
    const second = await runSweep(
      ctx,
      { ...deps, blobStore: fake.store, onBlobSwept: (event) => events.push(event) },
      later,
      { abandonedWriteMs: ABANDONED_AFTER_MS },
    );
    expect(second.failed).toEqual([]);
    expect(second.blobs.actions.filter((a) => a.agentId === agent.id)).toEqual([
      { agentId: agent.id, action: "remove_orphan", blobId: "deleted-blob", bytes: 32 },
    ]);
    expect(fake.has(agent.id, "deleted-blob")).toBe(false);
    expect(rowOf("deleted-blob")).toBeUndefined();
    // The bytes are counted; nobody is told, since the event names a person and there is none.
    expect(second.blobs.bytesRemoved).toBeGreaterThanOrEqual(32);
    expect(events.filter((event) => event.agentId === agent.id)).toEqual([]);
  });

  it("spells the .tmp suffix as the store does, and takes the TTL from the runner", () => {
    expect(BLOB_SWEEP_TMP_SUFFIX).toBe(BLOB_TMP_SUFFIX);
    expect(BLOB_SWEEP_TTL_MS).toBe(BLOB_TTL_MS);
  });
});
