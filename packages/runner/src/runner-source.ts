import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** A file as it is seeded onto a sandbox: a path relative to the destination, and its text. */
export type RunnerFile = { path: string; content: string };

/**
 * Where the runner is seeded inside a sandbox, and where its source is read from on this side.
 *
 * `runner.mjs` beside this file is the whole runner; its header is the module contract. It is seeded
 * onto every sandbox with the skills as one tree under a directory named by the content hash of both,
 * `/graft/<hash>/` (`runnerSeedDir`), and run from there (`runnerPath`), so each server version runs
 * exactly the runner it seeded and two versions sharing a sandbox through a rolling deploy never
 * write one path (GRA-193). A command is handed the path as `GRAFT_RUNNER` (`RUNNER_PATH_VARIABLE`)
 * and runs a module as `node "$GRAFT_RUNNER" <module>`; nothing spells the path by hand.
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

/** The directory one seed occupies: `/graft/<hash>`, the hash the seeding side's digest of the whole tree. */
export function runnerSeedDir(hash: string): string {
  return `${RUNNER_DIR}/${hash}`;
}

/** Where the runner of one seed is: `/graft/<hash>/runner.mjs`. The one way that path is spelt. */
export function runnerPath(hash: string): string {
  return `${runnerSeedDir(hash)}/${RUNNER_FILE}`;
}

/**
 * The per-exec variable carrying `runnerPath` into a command, so a script — the server's or one the
 * model types — runs `node "$GRAFT_RUNNER" <module>` without knowing the hash. Deleted with every
 * other `GRAFT_*` variable before the module loads (`runner.mjs`).
 */
export const RUNNER_PATH_VARIABLE = "GRAFT_RUNNER";

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

/**
 * The proxy's mark on every refusal it makes, with its reason (`PROXY_REFUSED_HEADER` in
 * `@graft/proxy`'s `failure.ts`): a response bearing it is the proxy's answer and never a vendor
 * error status on a stock tool's failure signal (GRA-244). Asserted equal to `runner.mjs`'s in
 * `runner.test.ts`.
 */
export const PROXY_REFUSED_HEADER = "x-graft-refused";

/** What stdout carries in place of the result when `GRAFT_RESULT_PATH` sent it to a file. */
export const RESULT_MARKER = "__GRAFT_RESULT__:";

/**
 * The last line of stderr on every failure the runner words (GRA-244; `runner.mjs`): the marker,
 * then the last error status a vendor answered `ctx.fetch` with, or nothing. `@graft/mcp`'s
 * `run.ts` reads it onto a stock tool's failure signal and strips it from the tail it hands back.
 * Asserted equal to `runner.mjs`'s in `runner.test.ts`.
 */
export const VENDOR_STATUS_MARKER = "__GRAFT_VENDOR_STATUS__:";

/**
 * The first line of the runner's envelope, on stdout and in the detached result file (GRA-186; the
 * header of `runner.mjs`): the marker, a newline, one line of JSON `{ result, blobs }`. In the
 * family of `RESULT_MARKER`, and for the same reason: only the runner writes it, after the module
 * has settled, so `readRunnerEnvelope` unwraps what follows the marker and nothing else, and a
 * module's own `{ result, blobs }` is the module's result. The `:1` is the envelope's version.
 */
export const ENVELOPE_MARKER = "__GRAFT_ENVELOPE__:1";

/**
 * The ref a module carries for a blob, `blob://<id>` (ADR 0023; GRA-186): the scheme, the cap the
 * runner refuses a write at as `blob_too_large`, how long a blob lives from its write, and the
 * bounds on a blob's `name` and `contentType` (`blob_invalid_name`, `blob_invalid_content_type`),
 * which keep the ledger the result carries bounded by construction. Each is spelt again in
 * `runner.mjs`, which ships to the sandbox alone, and `runner.test.ts` pins the pairs. All are
 * constants and not knobs (ADR 0023: knobs when someone hits them).
 *
 * `BLOB_QUOTA_BYTES` is the third number ADR 0023 fixes and lives beside the other two so all three
 * are read from one file: how many live bytes one agent may hold across every blob, which the door
 * refuses at as `blob_quota` before a run (`packages/mcp/src/blob-door.ts`, GRA-187). The runner
 * never reads it: the rows are the server's, and the sandbox has no route to the database.
 */
export const BLOB_REF_SCHEME = "blob://";
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const BLOB_TTL_MS = 24 * 60 * 60 * 1000;
/** The same life in hours, for every sentence that names it; derived here and spelt nowhere else (GRA-199). */
export const BLOB_TTL_HOURS = BLOB_TTL_MS / (60 * 60 * 1000);
export const BLOB_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MAX_BLOB_NAME_CHARS = 255;
export const MAX_BLOB_CONTENT_TYPE_CHARS = 128;

/**
 * What a blob's `name` may not hold: a C0 control character, DEL, a slash or a backslash (a name is
 * shown to the agent and never read as a path). The characters are spelt as escapes and never as
 * the bytes themselves, so this file stays text to a diff and to grep (GRA-199). `runner.mjs`
 * carries the same pattern and refuses a write that matches it as `blob_invalid_name`;
 * `runner.test.ts` pins the two.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is refused.
export const BLOB_NAME_REFUSED = /[\x00-\x1f\x7f/\\]/;

/**
 * What a blob's `contentType` may be: `type/subtype` in RFC 9110's token characters, anything after
 * a `;` admitted as parameters, case-insensitive. The one rule (GRA-199): `runner.mjs` carries the
 * same pattern and refuses a write that fails it as `blob_invalid_content_type`, `runner.test.ts`
 * pins the two, and `@graft/core`'s sweep decision builds its adoption rule from this pattern's
 * source, so a sidecar the runner wrote is never refused on adoption.
 */
export const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;.*)?$/i;

/** The id the runner mints, and the only shape a ledger line's ref may take: a UUID. */
const LEDGER_REF_PATTERN =
  /^blob:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/**
 * The runner's stdout contract since GRA-186 — the header of `runner.mjs`: the module's result
 * beside the ledger, and how many ledger lines the reader dropped as ones the runner could not
 * have written (a ref that is not a UUID, a size that is not a whole number, a name or a media
 * type past its bound). Zero from a runner of this repository; anything else is counted on the
 * wide event rather than recorded as a row.
 */
export type RunnerEnvelope = { result: unknown; blobs: BlobLedgerEntry[]; dropped: number };

/**
 * The envelope, read off what the runner printed or wrote: the text after the **last**
 * `ENVELOPE_MARKER` line, one line of JSON holding `result` and `blobs`. Only what follows the
 * marker is ever unwrapped, so a module's result of any shape — `{ result, blobs }` included — is
 * never mistaken for the runner's. Text with no marker answers null and is the caller's to word:
 * `run.ts` reads it as a bare result from a sandbox seeded with a runner older than the envelope,
 * which is the one other thing a runner has ever printed. The last marker rather than the first
 * because a command's stdout may carry the runner's output after the module's own.
 */
export function readRunnerEnvelope(text: string): RunnerEnvelope | null {
  const at = text.lastIndexOf(ENVELOPE_MARKER);
  if (at === -1) return null;
  const after = text.slice(at + ENVELOPE_MARKER.length);
  if (!after.startsWith("\n")) return null;
  const line = after.slice(1);
  const end = line.indexOf("\n");
  let value: unknown;
  try {
    value = JSON.parse(end === -1 ? line : line.slice(0, end));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { result, blobs } = value as { result?: unknown; blobs?: unknown };
  if (!("result" in value) || !Array.isArray(blobs)) return null;
  const ledger: BlobLedgerEntry[] = [];
  let dropped = 0;
  for (const line of blobs) {
    const entry = readLedgerEntry(line);
    if (entry) ledger.push(entry);
    else dropped += 1;
  }
  return { result, blobs: ledger, dropped };
}

/** One ledger line as the runner writes it, or null for one it could not have. */
function readLedgerEntry(value: unknown): BlobLedgerEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const { ref, bytes, contentType, name, expiresAt } = value as Record<string, unknown>;
  if (typeof ref !== "string" || !LEDGER_REF_PATTERN.test(ref)) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;
  if (
    typeof contentType !== "string" ||
    contentType === "" ||
    contentType.length > MAX_BLOB_CONTENT_TYPE_CHARS
  ) {
    return null;
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (name !== undefined) {
    if (typeof name !== "string" || name.length > MAX_BLOB_NAME_CHARS) return null;
    if (BLOB_NAME_REFUSED.test(name)) return null;
  }
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

/** The runner's part of the seeded tree, relative to `runnerSeedDir`. Empty when the source could not be read. */
export async function runnerFiles(): Promise<RunnerFile[]> {
  const source = await loadRunnerSource();
  return source === null ? [] : [{ path: RUNNER_FILE, content: source }];
}
