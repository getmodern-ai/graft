import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { StockToolSource, ToolAnnotations } from "@graft/core";

/**
 * The stock workspace (ADR 0025; GRA-238): one directory per stock tool, `tools/<vendor>/<name>/`,
 * holding the module (`index.ts` and anything beside it), `manifest.json` (name, description,
 * input schema, the hosts it calls, the annotations the check must agree with) and
 * `test-input.json`, and beside them the harness's `recording.json` (`packages/stock/RECORDING.md`). The
 * boot reads it with `readStockWorkspace` and loads it into the global catalogue (`@graft/core`'s
 * `loadStockCatalogue`); `harness.test.ts` is the harness every tool passes on every pull request.
 *
 * Resolved off `import.meta.url`, as `@graft/ask-card`'s page is: in this repository that is
 * `packages/stock/tools`; in the server's bundle `import.meta.url` is `apps/server/dist/index.mjs`,
 * so `../tools` is `apps/server/tools`, where `apps/server/tsdown.config.ts` copies the workspace
 * and the Dockerfile copies it into the image.
 */
export const STOCK_DIR = fileURLToPath(new URL("../tools", import.meta.url));

const MANIFEST = "manifest.json";
const TEST_INPUT = "test-input.json";
/**
 * The tool's recorded proof (`recording.ts`; GRA-240): the harness's, not the tool's. Left out of
 * the module's files and out of the hash, so re-recording a tool appends no catalogue version and
 * the recording is never copied into a person's toolbox.
 */
const RECORDING = "recording.json";

/** A stock tool as the workspace holds it: the catalogue's source and the annotations its manifest declares. */
export type StockWorkspaceTool = StockToolSource & { annotations: ToolAnnotations };

async function filesUnder(dir: string): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: { path: string; content: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    files.push({
      path: relative(dir, absolute).split(sep).join("/"),
      content: await readFile(absolute, "utf8"),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One hash over every file of the directory, each framed by its path and length. */
function hashOf(files: readonly { path: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\n${Buffer.byteLength(file.content, "utf8")}\n`, "utf8");
    hash.update(file.content, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function subdirectories(dir: string): Promise<string[]> {
  return (
    (await readdir(dir, { withFileTypes: true }))
      // A dot-directory is not a vendor or a tool: the build command proves a tool in one before it
      // moves it into place (`@graft/stock-build`'s `build.ts`).
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
  );
}

/**
 * Every stock tool under `dir`, sorted by vendor then name. A directory whose manifest or test input
 * is missing or malformed throws with a sentence naming the file: the workspace ships in the image,
 * so a broken one is a build that should not have passed its tests, not something to skip quietly.
 */
export async function readStockWorkspace(dir: string = STOCK_DIR): Promise<StockWorkspaceTool[]> {
  const tools: StockWorkspaceTool[] = [];
  for (const vendor of await subdirectories(dir)) {
    for (const name of await subdirectories(join(dir, vendor))) {
      const where = `${vendor}/${name}`;
      const all = (await filesUnder(join(dir, vendor, name))).filter(
        (file) => file.path !== RECORDING,
      );
      const problem = (file: string, text: string) =>
        new Error(`stock tool ${where}: ${where}/${file} ${text}`);
      const manifestFile = all.find((file) => file.path === MANIFEST);
      const testInputFile = all.find((file) => file.path === TEST_INPUT);
      if (!manifestFile) throw problem(MANIFEST, "is missing");
      if (!testInputFile) throw problem(TEST_INPUT, "is missing");
      let manifest: unknown;
      let testInput: unknown;
      try {
        manifest = JSON.parse(manifestFile.content);
        testInput = JSON.parse(testInputFile.content);
      } catch (error) {
        throw problem(MANIFEST, `or ${TEST_INPUT} is not JSON: ${String(error)}`);
      }
      if (
        !isRecord(manifest) ||
        manifest.name !== name ||
        typeof manifest.description !== "string" ||
        !isRecord(manifest.inputSchema) ||
        !Array.isArray(manifest.hosts) ||
        !manifest.hosts.every((host) => typeof host === "string") ||
        !isRecord(manifest.annotations) ||
        typeof manifest.annotations.readOnly !== "boolean" ||
        typeof manifest.annotations.destructive !== "boolean"
      ) {
        throw problem(
          MANIFEST,
          `must carry name (${name}, the directory's), description, inputSchema, hosts and annotations { readOnly, destructive }`,
        );
      }
      if (!isRecord(testInput)) throw problem(TEST_INPUT, "must be a JSON object");
      tools.push({
        vendor,
        name,
        description: manifest.description,
        inputSchema: manifest.inputSchema,
        hosts: manifest.hosts as string[],
        annotations: {
          readOnly: manifest.annotations.readOnly,
          destructive: manifest.annotations.destructive,
        },
        files: all.filter((file) => file.path !== MANIFEST && file.path !== TEST_INPUT),
        testInput,
        sourceHash: hashOf(all),
      });
    }
  }
  return tools;
}
