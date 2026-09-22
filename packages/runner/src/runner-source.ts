import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** A file as it is seeded onto a sandbox: a path relative to the destination, and its text. */
export type RunnerFile = { path: string; content: string };

/**
 * Where the runner is seeded inside a sandbox, and where its source is read from on this side.
 *
 * `runner.mjs` beside this file is the whole runner; its header is the module contract. It is seeded
 * onto every sandbox by the same provisioning step that writes the skills, so authored code has one
 * known way to be run in whichever sandbox is calling it: `node /graft/runner.mjs <module>`.
 *
 * A plain `.mjs` file rather than a string in a `.ts` module, because it is executed by Node inside
 * the sandbox and tested by spawning Node against it here (`runner.test.ts`) — one artefact, read the
 * same way in both places. It is read from disk at a path resolved off `import.meta.url`, which holds
 * because this package ships source (AGENTS.md: no build step). Should a bundler ever fold this
 * package into an app, that bundler has to carry `runner.mjs` beside the bundle, and this constant is
 * the one place to change.
 */
export const RUNNER_DIR = "/graft";
export const RUNNER_FILE = "runner.mjs";
export const RUNNER_PATH = `${RUNNER_DIR}/${RUNNER_FILE}`;

export const RUNNER_SOURCE_PATH = fileURLToPath(new URL(`./${RUNNER_FILE}`, import.meta.url));

/**
 * The entry a module directory is run through, in the runner's order: `index.ts` first, `index.mjs`
 * second. The runner ships to the sandbox alone and carries its own copy (`ENTRIES` in `runner.mjs`);
 * `runner.test.ts` asserts the two agree.
 */
export const MODULE_ENTRIES = ["index.ts", "index.mjs"] as const;
export type ModuleEntry = (typeof MODULE_ENTRIES)[number];

/** The preferred entry — what the skill teaches and what a single `.ts` file is published as. */
export const MODULE_ENTRY: ModuleEntry = MODULE_ENTRIES[0];

/** Which entry name a single-file module is published under: `.ts` (or `.mts`) keeps TypeScript. */
export function moduleEntryFor(sourcePath: string): ModuleEntry {
  return /\.m?ts$/.test(sourcePath) ? "index.ts" : "index.mjs";
}

/** The entry a directory listing holds, in the runner's order — or null, when it holds neither. */
export function moduleEntryOf(names: readonly string[]): ModuleEntry | null {
  const plain = names.map((name) => name.replace(/^\.\//, ""));
  return MODULE_ENTRIES.find((entry) => plain.includes(entry)) ?? null;
}

/**
 * The proxy's marker on a dry-run answer, and the value it carries on a stopped write. The runner
 * reads it off every non-read response in a dry run (`DRY_RUN_HEADER` in `runner.mjs`, asserted equal
 * in `runner.test.ts`); the proxy writes it. The proxy package is the other holder of this name.
 */
export const DRY_RUN_HEADER = "x-graft-dry-run";
export const DRY_RUN_INTERCEPTED = "intercepted";

/**
 * The proxy's mark on a refusal made because no response came from the vendor (`REFUSAL_HEADER` in
 * `@graft/proxy`'s `failure.ts`, GRA-79), carrying the refusal's reason. In a dry run the runner
 * records a read bearing it with `reason`, and with the `code` and `host` the proxy's body names,
 * beside `method`, `path` and `status`; a read without it is recorded as those three alone, so a
 * report's shape is unchanged for every read the vendor answered. `acquire`'s probe module reads
 * the same header off a proof read. Asserted equal to `runner.mjs`'s in `runner.test.ts`.
 */
export const REFUSAL_HEADER = "x-graft-refusal";

/** What stdout carries in place of the result when `GRAFT_RESULT_PATH` sent it to a file. */
export const RESULT_MARKER = "__GRAFT_RESULT__:";

/**
 * The ref a module carries for a blob, `blob://<id>` (ADR 0023; GRA-186): the scheme, the cap the
 * runner refuses a write at as `blob_too_large`, and how long a blob lives from its write. Each is
 * spelt again in `runner.mjs`, which ships to the sandbox alone, and `runner.test.ts` pins the
 * pairs. The cap and the life are constants and not knobs (ADR 0023: knobs when someone hits them).
 */
export const BLOB_REF_SCHEME = "blob://";
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const BLOB_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What a blob id may be — `@graft/toolbox`'s segment rule (`assertBlobId`), which is what makes an
 * id a directory name and never a path; the runner holds the same pattern (`BLOB_ID_PATTERN`).
 * Spelt here rather than imported because this package depends on nothing (the runner is a plain
 * file), and `packages/mcp/src/run.test.ts` pins it to the layout's rule.
 */
const BLOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The ref for a blob id. */
export function blobRefOf(blobId: string): string {
  return `${BLOB_REF_SCHEME}${blobId}`;
}

/** The id inside a ref, or null when the string is not a ref or its id could not name a directory. */
export function blobIdOf(ref: string): string | null {
  if (!ref.startsWith(BLOB_REF_SCHEME)) return null;
  const id = ref.slice(BLOB_REF_SCHEME.length);
  return BLOB_ID_PATTERN.test(id) && id !== "." && id !== ".." ? id : null;
}

/**
 * One line of the runner's blob ledger, as the envelope carries it: the ref, the size, the media
 * type the module declared, the name it gave (absent when it gave none) and when the blob expires.
 * Never the bytes, never a path. The server writes one `blob` row per line and hands the same list
 * to the agent beside the result (`packages/mcp/src/run.ts`).
 */
export type BlobLedgerEntry = {
  ref: string;
  bytes: number;
  contentType: string;
  name?: string;
  expiresAt: string;
};

/** The runner's stdout contract since GRA-186 — the header of `runner.mjs`: the module's result beside the ledger. */
export type RunnerEnvelope = { result: unknown; blobs: BlobLedgerEntry[] };

/**
 * The envelope, read strictly off the parsed JSON the runner printed or wrote: a plain object of
 * exactly `result` and `blobs`, every ledger line whole and its ref a well-formed one. Anything else
 * answers null and is the caller's to word — `run.ts` reads it as a bare result from a sandbox
 * seeded with a runner older than the envelope, which is the one other thing a runner has ever
 * printed.
 */
export function readRunnerEnvelope(value: unknown): RunnerEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "blobs" || keys[1] !== "result") return null;
  const { result, blobs } = value as { result: unknown; blobs: unknown };
  if (!Array.isArray(blobs)) return null;
  const ledger: BlobLedgerEntry[] = [];
  for (const line of blobs) {
    const entry = readLedgerEntry(line);
    if (!entry) return null;
    ledger.push(entry);
  }
  return { result, blobs: ledger };
}

function readLedgerEntry(value: unknown): BlobLedgerEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const { ref, bytes, contentType, name, expiresAt } = value as Record<string, unknown>;
  if (typeof ref !== "string" || blobIdOf(ref) === null) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;
  if (typeof contentType !== "string" || contentType === "") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (name !== undefined && typeof name !== "string") return null;
  return { ref, bytes, contentType, ...(name !== undefined ? { name } : {}), expiresAt };
}

/**
 * The exit codes the runner's header promises, so a caller reads the code by name. `64` is EX_USAGE
 * from sysexits, kept for the same meaning.
 */
export const EXIT_OK = 0;
export const EXIT_THREW = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_USAGE = 64;

let cached: Promise<string | null> | undefined;

/**
 * The runner's source, read once per process. Null — logged — when the file is not beside this
 * module, so provisioning seeds the skills and no runner rather than failing the sandbox: a sandbox
 * without a runner has lost one capability, not its filesystem.
 */
export function loadRunnerSource(): Promise<string | null> {
  cached ??= readFile(RUNNER_SOURCE_PATH, "utf8").catch((error: unknown) => {
    console.error(`runner: could not read ${RUNNER_SOURCE_PATH}; sandboxes get no runner:`, error);
    return null;
  });
  return cached;
}

/** The tree `writeTree` seeds under `RUNNER_DIR`. Empty when the source could not be read. */
export async function runnerFiles(): Promise<RunnerFile[]> {
  const source = await loadRunnerSource();
  return source === null ? [] : [{ path: RUNNER_FILE, content: source }];
}
