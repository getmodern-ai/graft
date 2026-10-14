import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isKebabCase, STARTER_VENDORS, starterVendorFor } from "@graft/core";
import { describe, expect, it } from "vitest";

import { readStockWorkspace, STOCK_DIR } from "./workspace";

/**
 * The stock workspace's shape (ADR 0025; GRA-238): a tool's integration is a starter (whose
 * proposal is its `connect`), its hosts are among the starter's, and it declares no package. The
 * check, the test input and the recording's replay are the harness's (`harness.test.ts`, GRA-240).
 */

const sources = await readStockWorkspace();

describe("the stock workspace", () => {
  it("holds the Open-Meteo tool", () => {
    expect(sources.map((source) => `${source.vendor}__${source.name}`)).toContain(
      "open-meteo__current-weather",
    );
  });

  describe.each(sources.map((source) => [`${source.vendor}__${source.name}`, source] as const))(
    "%s",
    (_wire, source) => {
      it("is of a starter integration, and calls only hosts the integration's connection reaches", () => {
        expect(isKebabCase(source.vendor)).toBe(true);
        expect(isKebabCase(source.name)).toBe(true);
        const starter = starterVendorFor(source.vendor);
        expect(starter, "a stock vendor is a starter integration").not.toBeNull();
        expect(source.hosts.length).toBeGreaterThan(0);
        for (const host of source.hosts) expect(starter?.hosts).toContain(host);
      });

      it("declares no package: a stock module calls through ctx.fetch alone", () => {
        expect(source.files.map((file) => file.path)).not.toContain("package.json");
      });
    },
  );
});

/**
 * Setup's ready-made tools (GRA-276): each starter's curated `readyMade` names a stock tool here
 * that the manifest says is read-only, and that runs with nothing the person has to look up
 * (GRA-217): every required input has a default, or is the starter's own run input, which the
 * result step pre-fills (Open-Meteo's city); and no input starts at an example, which the result
 * step would send unchanged as if the person had chosen it (Outlook's 2020 dates, Greptile on #218).
 * The catalogue's annotations are the check's, which the harness holds to the manifest's.
 */
describe.each(
  STARTER_VENDORS.flatMap((starter) =>
    starter.readyMade.map((curated) => [`${starter.vendor}__${curated.tool}`, starter] as const),
  ),
)("Setup's ready-made %s", (wire, starter) => {
  const source = sources.find((candidate) => `${candidate.vendor}__${candidate.name}` === wire);

  it("is in the workspace, read-only, and needs nothing looked up", async () => {
    expect(source, `${wire} is not a stock tool`).toBeDefined();
    const manifest = JSON.parse(
      await readFile(join(STOCK_DIR, starter.vendor, source?.name ?? "", "manifest.json"), "utf8"),
    ) as {
      annotations?: { readOnly?: boolean };
      inputSchema: {
        required?: string[];
        properties?: Record<string, { default?: unknown; examples?: unknown[] }>;
      };
    };
    expect(manifest.annotations?.readOnly).toBe(true);
    const looked = (manifest.inputSchema.required ?? []).filter(
      (field) =>
        manifest.inputSchema.properties?.[field]?.default === undefined &&
        field !== starter.runInput?.field,
    );
    expect(looked).toEqual([]);
    const exampled = Object.entries(manifest.inputSchema.properties ?? {})
      .filter(([, property]) => property.default === undefined && property.examples?.length)
      .filter(([field]) => field !== starter.runInput?.field)
      .map(([field]) => field);
    expect(exampled).toEqual([]);
  });
});

describe("readStockWorkspace", () => {
  it("reads <vendor>/<name>/ with its manifest, the module files apart from the manifest and the test input, and one hash", async () => {
    const [source] = sources.filter((s) => s.name === "current-weather");
    expect(source?.files.map((file) => file.path)).toEqual(["index.ts"]);
    expect(source?.testInput).toEqual({ city: "Melbourne" });
    expect(source?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the whole directory: a changed manifest is a new hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "graft-stock-"));
    const dir = join(root, "open-meteo", "echo");
    await mkdir(dir, { recursive: true });
    const manifest = {
      name: "echo",
      description: "Echo.",
      inputSchema: { type: "object" },
      hosts: ["api.open-meteo.com"],
      annotations: { readOnly: true, destructive: false },
    };
    await writeFile(join(dir, "index.ts"), "export default async () => ({});\n");
    await writeFile(join(dir, "test-input.json"), "{}");
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    const [first] = await readStockWorkspace(root);
    // The recording is the harness's: no module file, and no new hash (GRA-240).
    await writeFile(join(dir, "recording.json"), "{}");
    const [recorded] = await readStockWorkspace(root);
    expect(recorded?.sourceHash).toBe(first?.sourceHash);
    expect(recorded?.files.map((file) => file.path)).toEqual(["index.ts"]);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest, description: "E." }));
    const [second] = await readStockWorkspace(root);
    expect(first?.sourceHash).not.toBe(second?.sourceHash);
    expect(STOCK_DIR).toMatch(/tools$/);
  });

  it("refuses a manifest whose name is not its directory's, with a sentence naming the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "graft-stock-"));
    const dir = join(root, "open-meteo", "echo");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), "export default async () => ({});\n");
    await writeFile(join(dir, "test-input.json"), "{}");
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        name: "other",
        description: "x",
        inputSchema: { type: "object" },
        hosts: [],
      }),
    );
    await expect(readStockWorkspace(root)).rejects.toThrow(/open-meteo\/echo\/manifest\.json/);
  });
});
