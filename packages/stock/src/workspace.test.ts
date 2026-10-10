import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isKebabCase, starterVendorFor } from "@graft/core";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";

import { checkStockTool } from "./check";
import { readStockWorkspace, STOCK_DIR } from "./workspace";

/**
 * The stock workspace's harness (ADR 0025; GRA-238): every stock tool in `tools/` is proved here
 * on every pull request, with no vendor reached. A tool's integration is a starter (whose proposal
 * is its `connect`), its hosts are among the starter's, the check passes its module against its own
 * schema with the annotations its manifest declares, and its test input is valid input. The
 * recording replay and the live nightly run are GRA-231's later tickets.
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

      it("passes the check, with the annotations its manifest declares", async () => {
        const verdict = await checkStockTool(source);
        expect(verdict).toMatchObject({ ok: true, annotations: source.annotations });
      });

      // The validator a run uses (`@graft/mcp`'s `schema.ts`): the MCP SDK's Ajv provider.
      it("takes its test input", () => {
        const validate = new AjvJsonSchemaValidator().getValidator(
          source.inputSchema as JsonSchemaType,
        );
        expect(validate(source.testInput)).toMatchObject({ valid: true });
      });

      it("declares no package: a stock module calls through ctx.fetch alone", () => {
        expect(source.files.map((file) => file.path)).not.toContain("package.json");
      });
    },
  );
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
