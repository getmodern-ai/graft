import type { StockToolView, ToolDeps } from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox/fake";
import { createFilesystemToolboxStore, createNoopToolboxMirror, toolboxIdOf } from "@graft/toolbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { advanceStockCopy, type CopyStockDeps, copyStockVersion } from "./copy-stock";
import { createFakeMetadataSource } from "./metadata";
import { DEFAULT_PACKAGE_POLICY } from "./policy";
import { type MirrorEvent, publishToolVersion } from "./publish.service";
import { createInMemoryToolDeps, fakeDb, type InMemoryToolDeps } from "./testing";

/**
 * The copy of a stock version into a person's toolbox (ADR 0025; GRA-238): the version directory
 * written from the catalogue's files, an ordinary tool and version recording the stock origin, the
 * pointer on it. What is asserted is the toolbox and the rows a run then reads.
 */

const PERSON = "person1";

const STOCK: StockToolView = {
  stockToolId: "stock_weather",
  stockVersionId: "stock_weather_v3",
  versionNumber: 3,
  vendor: "open-meteo",
  name: "current-weather",
  description: "The weather right now in a named city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  annotations: { readOnly: true, destructive: false },
  hosts: ["api.open-meteo.com"],
  files: [{ path: "index.ts", content: "export default async () => ({ ok: true });\n" }],
  checkOutput: { refusals: [], advice: [], annotations: { readOnly: true, destructive: false } },
  connect: null,
};

let sandbox: FakeSandboxBackend;
let tool: InMemoryToolDeps;
let deps: CopyStockDeps;

beforeEach(() => {
  sandbox = createFakeSandboxBackend();
  tool = createInMemoryToolDeps();
  deps = {
    db: fakeDb,
    store: createFilesystemToolboxStore({ root: `${sandbox.root}/toolboxes` }),
    mirror: createNoopToolboxMirror(),
    tool,
    now: () => new Date(),
    onMirror: () => {},
  };
});

afterEach(async () => {
  await sandbox.close();
});

describe("copyStockVersion", () => {
  it("writes the stock version as version 1 of an ordinary tool, recording its stock origin", async () => {
    const copied = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    expect(copied).toMatchObject({
      personId: PERSON,
      vendor: "open-meteo",
      name: "current-weather",
      description: STOCK.description,
      inputSchema: STOCK.inputSchema,
      readOnly: true,
      destructive: false,
    });
    const [version] = tool.versions;
    expect(copied.currentVersionId).toBe(version?.id);
    expect(version).toMatchObject({
      versionNumber: 1,
      path: expect.stringMatching(/^tools\/open-meteo\/current-weather\/w-/),
      stockToolId: "stock_weather",
      stockVersionId: "stock_weather_v3",
      writesInvolved: false,
    });
    const files = await deps.store.readTree(PERSON, version?.path ?? "");
    expect(files.map((file) => file.path).sort()).toEqual(["index.ts"]);
  });

  it("answers the person's tool and writes nothing when they already hold one of that name", async () => {
    const first = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    const second = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    expect(second.id).toBe(first.id);
    expect(tool.versions).toHaveLength(1);
  });

  it("serialises two first copies racing: one tool, one version, and the files are the version's own", async () => {
    const { db, lockToolName } = lockingDb();
    tool.lockToolName = lockToolName;
    const racing = { ...deps, db };
    const newer: StockToolView = {
      ...STOCK,
      stockVersionId: "stock_weather_v4",
      files: [{ path: "index.ts", content: "export default async () => ({ v: 4 });\n" }],
    };
    const [first, second] = await Promise.all([
      copyStockVersion(racing, { personId: PERSON, stock: STOCK, defaultConnectionId: null }),
      copyStockVersion(racing, { personId: PERSON, stock: newer, defaultConnectionId: null }),
    ]);
    expect(second.id).toBe(first.id);
    expect(tool.tools).toHaveLength(1);
    expect(tool.versions).toHaveLength(1);
    const winner = tool.versions[0]?.stockVersionId === newer.stockVersionId ? newer : STOCK;
    const files = await deps.store.readTree(PERSON, tool.versions[0]?.path ?? "");
    expect(files.find((file) => file.path === "index.ts")?.content).toBe(winner.files[0]?.content);
  });

  it.each([
    ["the two started together", false],
    ["the copy arriving while the publish writes its directory", true],
  ])(
    "serialises a publish and a first copy of the same name, %s: neither writes another's directory",
    async (_case, midPublish) => {
      const { db, lockToolName } = lockingDb();
      tool.lockToolName = lockToolName;
      const published = "export default async () => ({ authored: true });" + "\n";
      const toolboxId = toolboxIdOf(PERSON);
      // Every write under tools/, by whose module it carried: a directory two writers wrote is a collision.
      const writers = new Map<string, Set<string | undefined>>();
      const store = deps.store;
      let copying: Promise<unknown> | null = null;
      const startCopy = () => {
        copying ??= copyStockVersion(
          { ...deps, store: recording, db },
          { personId: PERSON, stock: STOCK, defaultConnectionId: null },
        );
        return copying;
      };
      const recording: typeof store = Object.create(store);
      recording.writeTree = async (id, path, files) => {
        const module = files.find((file) => file.path === "index.ts")?.content;
        if (path.startsWith("tools/")) {
          const seen = writers.get(path) ?? new Set();
          seen.add(module);
          writers.set(path, seen);
          if (midPublish && module === published) await startCopy();
        }
        return store.writeTree(id, path, files);
      };
      await store.writeTree(toolboxId, ".drafts/job1", [{ path: "index.ts", content: published }]);
      const publishing = publishToolVersion(
        {
          ...deps,
          store: recording,
          db,
          sandbox,
          metadata: createFakeMetadataSource({}),
          policy: DEFAULT_PACKAGE_POLICY,
          check: async (input) => ({
            entry: input.entry,
            refusals: [],
            advice: [],
            annotations: { readOnly: true, destructive: false },
            contextMembersUsed: [],
            blobReadFields: [],
          }),
        },
        {
          personId: PERSON,
          toolboxId,
          vendor: STOCK.vendor,
          name: STOCK.name,
          description: "My own weather tool.",
          inputSchema: { type: "object" },
          draftPath: ".drafts/job1",
          activate: false,
        },
      );
      if (!midPublish) startCopy();
      const outcome = await publishing;
      await copying;
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

      for (const [path, modules] of writers) expect(modules.size, path).toBe(1);
      expect(tool.tools).toHaveLength(1);
      const paths = tool.versions.map((version) => version.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const version of tool.versions) {
        const files = await store.readTree(toolboxId, version.path);
        const expected = version.stockVersionId ? STOCK.files[0]?.content : published;
        expect(files.find((file) => file.path === "index.ts")?.content).toBe(expected);
      }
    },
  );

  it("answers the winner's row when the losing insert is refused by the unique constraint", async () => {
    const insert = tool.insertAuthoredTool;
    // Another writer of the same name commits between the existence check and this insert.
    tool.insertAuthoredTool = async (db, input) => {
      await insert(db, { ...input, id: "tool_winner" });
      throw Object.assign(new Error("duplicate key value"), { code: "23505" });
    };
    const copied = await copyStockVersion(deps, {
      personId: PERSON,
      stock: STOCK,
      defaultConnectionId: null,
    });
    expect(copied.id).toBe("tool_winner");
  });

  it("asks the off-site mirror for the copied version, as a publish does, and not for a tool it answers as it is", async () => {
    const events: MirrorEvent[] = [];
    const mirror = createNoopToolboxMirror();
    const mirrored = { ...deps, mirror, onMirror: (event: MirrorEvent) => events.push(event) };
    const copied = await copyStockVersion(mirrored, {
      personId: PERSON,
      agentId: "agent1",
      stock: STOCK,
      defaultConnectionId: null,
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(mirror.calls).toEqual([{ toolboxId: PERSON, versionPath: tool.versions[0]?.path }]);
    expect(events[0]).toMatchObject({
      outcome: "mirrored",
      personId: PERSON,
      agentId: "agent1",
      toolId: copied.id,
      versionId: tool.versions[0]?.id,
    });

    await copyStockVersion(mirrored, { personId: PERSON, stock: STOCK, defaultConnectionId: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mirror.calls).toHaveLength(1);
  });
});

describe("advanceStockCopy", () => {
  const V4: StockToolView = {
    ...STOCK,
    stockVersionId: "stock_weather_v4",
    versionNumber: 4,
    description: "The weather right now in a named city, with the wind.",
    files: [{ path: "index.ts", content: "export default async () => ({ ok: 4 });\n" }],
  };
  const copy = () =>
    copyStockVersion(deps, { personId: PERSON, stock: STOCK, defaultConnectionId: null });

  it("writes the catalogue's newer version as the copy's next version and moves the pointer", async () => {
    const copied = await copy();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    expect(advance).toMatchObject({
      advanced: true,
      stockVersionNumber: 4,
      previous: { readOnly: true, destructive: false },
      version: {
        versionNumber: 2,
        path: expect.stringMatching(/^tools\/open-meteo\/current-weather\/w-/),
        stockToolId: "stock_weather",
        stockVersionId: "stock_weather_v4",
      },
    });
    if (!advance.advanced) throw new Error("the advance wrote nothing");
    expect(advance.tool.currentVersionId).toBe(advance.version.id);
    expect(advance.tool.description).toBe(V4.description);
    // A directory of the advance's own, beside the copy's: no writer writes over another's files.
    expect(advance.version.path).not.toBe(tool.versions[0]?.path);
    const files = await deps.store.readTree(PERSON, advance.version.path);
    expect(files.find((file) => file.path === "index.ts")?.content).toContain("ok: 4");
  });

  it("stays on a copy already at the catalogue's current version", async () => {
    const copied = await copy();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: STOCK,
    });
    expect(advance.advanced).toBe(false);
    expect(tool.versions).toHaveLength(1);
  });

  it("never advances a remix: a version the agent published stops the copy following", async () => {
    const copied = await copy();
    const [first] = tool.versions;
    if (!first) throw new Error("the copy wrote no version");
    tool.versions.push({
      ...first,
      id: "remix_v2",
      versionNumber: 2,
      stockToolId: null,
      stockVersionId: null,
    });
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    expect(advance.advanced).toBe(false);
    expect(tool.versions).toHaveLength(2);
  });

  it("answers the tool untouched when a racing publish took the version number first", async () => {
    const copied = await copy();
    const insert = tool.insertToolVersion;
    tool.insertToolVersion = async () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    };
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: V4,
    });
    tool.insertToolVersion = insert;
    expect(advance).toMatchObject({ advanced: false, tool: { id: copied.id } });
  });
});

/**
 * ADR 0008 as amended 2026-10-09 (GRA-245): a new stock version keeps the approval unless its
 * annotations widen. What is asserted is the version each agent's answer stands for afterwards.
 */
describe("advanceStockCopy and the approvals given for the copy", () => {
  const WRITE: StockToolView = {
    ...STOCK,
    name: "save-place",
    annotations: { readOnly: false, destructive: false },
    checkOutput: { refusals: [], advice: [], annotations: { readOnly: false, destructive: false } },
  };
  const next = (annotations: StockToolView["annotations"]): StockToolView => ({
    ...WRITE,
    stockVersionId: "stock_place_v4",
    versionNumber: 4,
    annotations,
    checkOutput: { ...WRITE.checkOutput, annotations },
  });
  const approved = async () => {
    const copied = await copyStockVersion(deps, {
      personId: PERSON,
      stock: WRITE,
      defaultConnectionId: null,
    });
    tool.approvals.push(
      { agentId: "agent_a", toolId: copied.id, toolVersionId: copied.currentVersionId },
      // An answer already given for an older version stays stale: the carry is not a grant.
      { agentId: "agent_b", toolId: copied.id, toolVersionId: "older_version" },
    );
    // The fake's tool row is the object the advance moves, so its version is read now.
    return { copied, before: copied.currentVersionId };
  };

  it("carries the answers given for the version before onto the new one when the annotations hold", async () => {
    const { copied } = await approved();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: next({ readOnly: false, destructive: false }),
    });
    if (!advance.advanced) throw new Error("the copy did not advance");
    expect(tool.approvals).toEqual([
      { agentId: "agent_a", toolId: copied.id, toolVersionId: advance.version.id },
      { agentId: "agent_b", toolId: copied.id, toolVersionId: "older_version" },
    ]);
  });

  it("leaves every answer on the version before when the new version turns destructive", async () => {
    const { copied, before } = await approved();
    const advance = await advanceStockCopy(deps, {
      personId: PERSON,
      toolId: copied.id,
      stock: next({ readOnly: false, destructive: true }),
    });
    expect(advance.advanced).toBe(true);
    expect(tool.approvals.map((row) => row.toolVersionId)).toEqual([before, "older_version"]);
  });
});

/**
 * A database whose transactions hold the advisory locks they take until they end, as Postgres's
 * `pg_advisory_xact_lock` does: what serialises two copies in the race test. A lock the
 * transaction already holds is taken again at once, as Postgres's is by the same session.
 */
function lockingDb(): { db: typeof fakeDb; lockToolName: ToolDeps["lockToolName"] } {
  const held = new Map<string, Promise<void>>();
  type Tx = { releases: (() => void)[]; names: Set<string> };
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // A nested transaction (a savepoint) runs on the same handle and holds the same locks.
      const tx: Tx & { transaction?: unknown } = { releases: [], names: new Set() };
      tx.transaction = async <U>(inner: (handle: unknown) => Promise<U>) => inner(tx);
      try {
        return await fn(tx);
      } finally {
        for (const release of tx.releases) release();
      }
    },
  } as unknown as typeof fakeDb;
  const lockToolName: ToolDeps["lockToolName"] = async (tx, personId, key) => {
    const name = `${personId}:${key.vendor}:${key.name}`;
    if ((tx as unknown as Tx).names.has(name)) return;
    const before = held.get(name) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    held.set(
      name,
      before.then(() => mine),
    );
    await before;
    (tx as unknown as Tx).names.add(name);
    (tx as unknown as Tx).releases.push(release);
  };
  return { db, lockToolName };
}
