import type { StockToolView } from "@graft/core";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox/fake";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CopyStockDeps, copyStockVersion } from "./copy-stock";
import type { MirrorEvent } from "./publish.service";
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
    // One process, no concurrent transactions; the race test brings a lock that holds.
    lockToolName: async () => {},
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
      path: "tools/open-meteo/current-weather/v1",
      stockToolId: "stock_weather",
      stockVersionId: "stock_weather_v3",
      writesInvolved: false,
    });
    const files = await deps.store.readTree(PERSON, "tools/open-meteo/current-weather/v1");
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
    const racing = { ...deps, db, lockToolName };
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
    const files = await deps.store.readTree(PERSON, "tools/open-meteo/current-weather/v1");
    expect(files.find((file) => file.path === "index.ts")?.content).toBe(winner.files[0]?.content);
  });

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
    expect(mirror.calls).toEqual([
      { toolboxId: PERSON, versionPath: "tools/open-meteo/current-weather/v1" },
    ]);
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

/**
 * A database whose transactions hold the advisory locks they take until they end, as Postgres's
 * `pg_advisory_xact_lock` does: what serialises two copies in the race test.
 */
function lockingDb(): { db: typeof fakeDb; lockToolName: CopyStockDeps["lockToolName"] } {
  const held = new Map<string, Promise<void>>();
  type Tx = { releases: (() => void)[] };
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // A nested transaction (a savepoint) runs on the same handle and holds the same locks.
      const tx: Tx & { transaction?: unknown } = { releases: [] };
      tx.transaction = async <U>(inner: (handle: unknown) => Promise<U>) => inner(tx);
      try {
        return await fn(tx);
      } finally {
        for (const release of tx.releases) release();
      }
    },
  } as unknown as typeof fakeDb;
  const lockToolName: CopyStockDeps["lockToolName"] = async (tx, personId, key) => {
    const name = `${personId}:${key.vendor}:${key.name}`;
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
    (tx as unknown as Tx).releases.push(release);
  };
  return { db, lockToolName };
}
