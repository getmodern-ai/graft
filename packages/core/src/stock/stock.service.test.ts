import type { DbOrTx } from "@graft/db";
import { describe, expect, it } from "vitest";

import {
  describeStockTool,
  listStockCatalogue,
  listStockToolsForVendor,
  loadStockCatalogue,
  type StockCheck,
  type StockToolSource,
} from "./stock.service";
import { createFakeStockCatalogue } from "./testing/fake-stock-deps";

/**
 * The stock catalogue's load and reads (ADR 0025; GRA-238), over the in-memory catalogue. The load
 * is what the boot runs: idempotent over an unchanged workspace, a version appended by number when
 * a tool's source hash changes, the check's annotations on the version and never the manifest's.
 */

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb as unknown as DbOrTx };

const WEATHER: StockToolSource = {
  vendor: "open-meteo",
  name: "current-weather",
  description: "The weather right now in a named city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
  files: [{ path: "index.ts", content: "export default async () => ({});\n" }],
  testInput: { city: "Melbourne" },
  sourceHash: "hash-1",
};

const passes: StockCheck = async () => ({
  ok: true,
  annotations: { readOnly: true, destructive: false },
  checkOutput: { refusals: [], advice: [] },
});

describe("loadStockCatalogue", () => {
  it("appends version 1 of a new tool, then nothing on a second load of the same workspace", async () => {
    const catalogue = createFakeStockCatalogue();
    const first = await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    expect(first).toEqual({
      tools: 1,
      appended: [{ vendor: "open-meteo", name: "current-weather", versionNumber: 1 }],
      refused: [],
    });
    const second = await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    expect(second).toEqual({ tools: 1, appended: [], refused: [] });
    expect(catalogue.versions.size).toBe(1);
  });

  it("appends version 2 when the source hash changes, and keeps version 1", async () => {
    const catalogue = createFakeStockCatalogue();
    await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    const fixed = { ...WEATHER, sourceHash: "hash-2", description: "Fixed." };
    const report = await loadStockCatalogue(ctx, [fixed], passes, catalogue.deps);
    expect(report.appended).toEqual([
      { vendor: "open-meteo", name: "current-weather", versionNumber: 2 },
    ]);
    expect(catalogue.versions.size).toBe(2);
    const [current] = await listStockCatalogue(ctx, catalogue.deps);
    expect(current?.versionNumber).toBe(2);
    expect(current?.description).toBe("Fixed.");
  });

  it("never appends a source hash the tool already has, so an older release's replica cannot make its stock current again", async () => {
    const catalogue = createFakeStockCatalogue();
    await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    const fixed = { ...WEATHER, sourceHash: "hash-2", description: "Fixed." };
    await loadStockCatalogue(ctx, [fixed], passes, catalogue.deps);
    // A replica of the older release boots during the rolling deploy, then one of the newer again.
    const older = await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    expect(older.appended).toEqual([]);
    const newer = await loadStockCatalogue(ctx, [fixed], passes, catalogue.deps);
    expect(newer.appended).toEqual([]);
    expect(catalogue.versions.size).toBe(2);
    const [current] = await listStockCatalogue(ctx, catalogue.deps);
    expect(current?.versionNumber).toBe(2);
    expect(current?.description).toBe("Fixed.");
  });

  it("records the check's annotations, and refuses a tool the check refuses without failing the rest", async () => {
    const catalogue = createFakeStockCatalogue();
    const writes: StockCheck = async () => ({
      ok: true,
      annotations: { readOnly: false, destructive: false },
      checkOutput: {},
    });
    await loadStockCatalogue(ctx, [WEATHER], writes, catalogue.deps);
    expect((await listStockCatalogue(ctx, catalogue.deps))[0]?.annotations.readOnly).toBe(false);

    const refuses: StockCheck = async () => ({ ok: false, problems: ["global-fetch"] });
    const other = { ...WEATHER, name: "forecast", sourceHash: "h" };
    const report = await loadStockCatalogue(ctx, [other], refuses, catalogue.deps);
    expect(report.refused).toEqual([
      { vendor: "open-meteo", name: "forecast", problems: ["global-fetch"] },
    ]);
    expect((await listStockCatalogue(ctx, catalogue.deps)).map((tool) => tool.name)).toEqual([
      "current-weather",
    ]);
  });
});

describe("the catalogue's reads", () => {
  it("describes a stock tool with the starter integration's connection proposal as connect", async () => {
    const catalogue = createFakeStockCatalogue();
    await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    const tool = await describeStockTool(
      ctx,
      { vendor: "open-meteo", name: "current-weather" },
      catalogue.deps,
    );
    expect(tool).toMatchObject({
      vendor: "open-meteo",
      name: "current-weather",
      versionNumber: 1,
      hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
      connect: {
        vendor: "open-meteo",
        displayName: "Open-Meteo",
        primaryHost: "https://api.open-meteo.com/v1",
        hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
        scheme: "none",
        schemeConfig: {},
        docsUrl: "https://open-meteo.com/en/docs",
      },
    });
    expect(
      await describeStockTool(ctx, { vendor: "open-meteo", name: "nope" }, catalogue.deps),
    ).toBeNull();
  });

  it("lists one integration's stock tools for the console: name, wire name, description, annotations, schema", async () => {
    const catalogue = createFakeStockCatalogue();
    await loadStockCatalogue(ctx, [WEATHER], passes, catalogue.deps);
    expect(await listStockToolsForVendor(ctx, "open-meteo", catalogue.deps)).toEqual([
      {
        name: "current-weather",
        tool: "open-meteo__current-weather",
        description: "The weather right now in a named city.",
        annotations: { readOnly: true, destructive: false },
        inputSchema: WEATHER.inputSchema,
      },
    ]);
    expect(await listStockToolsForVendor(ctx, "hubspot", catalogue.deps)).toEqual([]);
  });
});
