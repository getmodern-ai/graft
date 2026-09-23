/**
 * The runner: how a module of authored code is executed inside a sandbox.
 *
 *   echo '{"orderId": 7}' | node "$GRAFT_RUNNER" /tools/unleashed/create-order/v3
 *
 * Seeded onto every sandbox with the skills, under `/graft/<hash>/` (`runner-source.ts` reads this file
 * from the package and names the directory by its content; `GRAFT_RUNNER` is the path, per exec).
 * Plain Node, no dependencies, because the sandbox image has nothing else at `/graft` — Node 24,
 * `fetch` built in. A published version carries its own `node_modules` beside the module (ADR 0013),
 * and that is the only place an import of a package resolves.
 *
 * ## The contract
 *
 *  - `argv[2]` is the module: a directory holding `index.ts` — or `index.mjs`, tried second — or the
 *    file itself. TypeScript runs by Node 24's own type stripping, so erasable syntax only: an `enum`
 *    or a `namespace` fails to load here, which is what the check refuses ahead of time. The module is
 *    an ES module whose default export is an async function of `(input, ctx)`; it may import siblings
 *    by relative path, extension included, and the packages vendored beside it.
 *  - The module imports Node's built-ins less the ten the check refuses before a version is published
 *    (`module-check.core.ts`, `BANNED_MODULES`): `child_process`, `net`, `dgram`, `fs`, `fs/promises`,
 *    `worker_threads`, `vm`, `module`, `cluster` and `inspector`. The runner does not re-check; a
 *    published version was checked. A file a tool writes for another is a blob, and the scope that
 *    holds it is the mount the sandbox is given, not the check's list (ADR 0023).
 *  - stdin is the JSON input. Empty stdin is `{}`.
 *  - stdout receives exactly the **envelope** and nothing else, exit code 0: the marker line
 *    `__GRAFT_ENVELOPE__:1`, a newline, then one line of JSON `{ result, blobs }` — the module's
 *    JSON result, and the ledger of every blob `ctx.blob.write` produced during the run as
 *    `[{ ref, bytes, contentType, name?, expiresAt }]`, in write order (GRA-186; ADR 0023). The
 *    marker is what makes the envelope the runner's: a reader unwraps only what follows it, so a
 *    module's own `{ result, blobs }` comes back as the module's result, untouched. A module that
 *    wrote nothing has `blobs: []`. In a dry run `result` is the report described below; on the
 *    detached path the same two lines go to the file.
 *  - A thrown error puts its message and the tail of its stack on stderr, then each `cause` in its
 *    chain on a line of its own — undici's `fetch failed` keeps the host and the errno there and
 *    nowhere in the stack; exit code 1.
 *  - A timeout — `GRAFT_TIMEOUT_MS`, default sixty seconds — is a distinct message on stderr; exit
 *    code 2. Distinct so the caller can tell "the module is slow" from "the module is wrong".
 *  - Anything wrong with the invocation itself (no path, unparseable stdin) is exit code 64.
 *
 * ## `ctx` is the module's whole route out, and it never sees `GRAFT_*`
 *
 * `ctx` is `{ fetch, proxyBase, proxyKey, connection, blob }`, frozen; the check declares the same
 * five and nothing else (`module-check.core.ts`, `CONTEXT_DECLARATION`).
 *
 *  - `ctx.fetch(path, init)` prepends `${GRAFT_PROXY_URL}/c/${GRAFT_CONNECTION}` to a vendor-relative
 *    path and adds `Authorization: Bearer ${GRAFT_TOKEN}`. An absolute `https://` URL is routed to
 *    the proxy's host form for its host, `…/c/${connection}/h/${host}${path}${query}`, the route
 *    `ctx.proxyBase(host)` names, so a URL a vendor hands back at run time on a second host of the
 *    connection (Slack's `files.slack.com` upload URL, GRA-197) reaches the proxy, which judges the
 *    host against the connection's set as it does an SDK's call (ADR 0010 as amended 2026-09-23).
 *    The runner adds nothing it does not have: no host list, so which hosts are allowed is the
 *    proxy's alone. Refused rather than bent, before any request leaves: a URL that is not `https:`,
 *    one carrying credentials (`user:pass@`), one whose host is not a host name; and a relative path
 *    that walks out of `/c/<connection>/`, so nothing can be sent for any connection but the one this
 *    run was minted for. The token travels to the proxy and nowhere else under either form. It
 *    never follows a redirect (`redirect: "manual"`): a vendor 3xx the proxy hands back reaches the
 *    module as that status with its `Location`. The proxy does not follow redirects (CONTEXT.md,
 *    *Proxy*), and a sandbox can reach nothing but the proxy, so following one here could only dial
 *    a host the egress refuses and die as an opaque `fetch failed` (GRA-64).
 *  - `ctx.proxyBase(host?)` is the base URL an SDK is pointed at: `${GRAFT_PROXY_URL}/c/${connection}`
 *    for the connection's primary host, `…/c/${connection}/h/${host}` for another host the connection
 *    declares (ADR 0010). The proxy pins the request to the connection's host set; this only builds
 *    the address, and refuses a `host` that is not a bare host name so it cannot become a path.
 *  - `ctx.proxyKey` is the capability token itself, for an SDK's credential option — the proxy reads
 *    it from `Authorization` and swaps in the connection's real credential (ADR 0010, amended). It is
 *    the one thing a module holds that is secret-shaped, and it is bounded to this exec, this
 *    connection and minutes. Empty when no connection is bound, as `ctx.fetch` is unavailable then.
 *  - `ctx.connection` is the connection id, or null when none is bound.
 *  - `ctx.blob` is `{ write, read, stat }`, the module's one route to a file (ADR 0023) — the
 *    section below.
 *
 * Every `GRAFT_*` variable is read out of the environment once, below, and then the whole `GRAFT_*`
 * set is deleted from `process.env` **before the module is imported** — so a module that prints its
 * environment prints none of them, and a module built from `process.env.GRAFT_TOKEN` sends no
 * credential at all. The check refuses such a module first (`execute-environment`); the two rules name
 * the same prefix and must change together.
 *
 * ## `ctx.blob`: a file moves between tools as a blob, never through the model
 *
 * A blob is a directory `<id>/` holding `data` and a `meta.json` sidecar under `/blobs`, where the
 * agent's sandbox mounts its own blobs directory alone (`@graft/toolbox`'s layout; ADR 0023). The
 * scope is that mount: there is no agent id in a path here, because the mount already is the
 * agent's, and a ref that does not resolve under `/blobs/<id>` is refused. The four names spelt
 * below (`/blobs`, `.tmp`, `data`, `meta.json`) are `@graft/toolbox`'s constants, copied because
 * this file ships to the sandbox alone; `packages/mcp/src/run.test.ts` pins the two spellings.
 *
 *  - `ctx.blob.write(data, { contentType, name? })` takes a `Uint8Array`, a `Blob` or a
 *    `ReadableStream<Uint8Array>`, a `contentType` shaped like a media type of at most 128
 *    characters (`blob_invalid_content_type` otherwise) and a `name` that is a file name of at most
 *    255 characters with no slash and no control character (`blob_invalid_name`), mints a UUID,
 *    streams the bytes into `/blobs/<id>.tmp/data`
 *    counting them — refused as `blob_too_large` the moment they pass 256 MiB, or as `blob_quota`
 *    the moment they would carry this run's committed total past `GRAFT_BLOB_BUDGET_BYTES`
 *    (whichever bound is the smaller; the `.tmp` directory removed before either throw) — writes
 *    `meta.json` (`bytes`, `contentType`, `name`, `writtenAt`,
 *    `expiresAt` 24 hours on, `agentId`, `toolVersion`) beside it, and renames the directory to
 *    `/blobs/<id>/` **once**. That rename is the one commit point: a reader or the sweep sees a whole
 *    blob or none, and a `.tmp` directory is a write in progress or an abandoned one. It answers the
 *    ref, `blob://<id>`, a plain string a module puts wherever it likes in its result. Every write
 *    goes onto the ledger the envelope carries, so the server writes one `blob` row per file
 *    without the sandbox ever reaching the database. Writing never asks (ADR 0008's grain is about
 *    vendor side effects), and a dry run writes too.
 *  - `ctx.blob.stat(ref)` answers the sidecar's `{ bytes, contentType, name?, expiresAt }`.
 *  - `ctx.blob.read(ref)` answers a `Blob` over `data`, opened lazily (`fs.openAsBlob`) and typed
 *    from the sidecar, so `.stream()` reads the file in chunks and it drops into a request body or
 *    a `FormData` without being held whole (GRA-187). Neither it nor `stat` checks the expiry: the
 *    server's door refuses a dead ref before a run (`packages/mcp/src/blob-door.ts`), and the
 *    runner has no clock the door does not have.
 *
 * Every ref a module hands `read` or `stat` is resolved to `/blobs/<id>` and refused as
 * `blob_not_found`, the ref in the sentence, when it does not resolve there: a string that is not
 * `blob://<id>`, an id that is not a directory name (a climb, a slash, an empty id), a `.tmp` name,
 * an id with no directory, and a directory or a file inside it that is a symlink (`lstat`, as the
 * server's blob store judges the same tree from outside; GRA-185). Another agent's blob is one of
 * these: its directory is on no path this sandbox can name (ADR 0023: the scope is the mount).
 *
 * `GRAFT_BLOB_BUDGET_BYTES` is what this run may still commit under the agent's quota, set per exec
 * by the server's door from the agent's live rows (`packages/mcp/src/blob-door.ts`; GRA-187, after
 * Greptile on #145): the door's check runs before the run, and without this a module could loop
 * `ctx.blob.write` and commit 256 MiB per call to the persistent mount with nothing bounding the
 * total inside one run. The runner reserves against the budget as each chunk lands, one shared
 * figure across every write in flight, and refuses the write that would pass it as `blob_quota`,
 * so one oversized write stops at the smaller of the cap and the budget and two writes at once
 * cannot both fit in a remainder only one of them fits; a refused write gives its reservation
 * back and is on no ledger. Unset, the cap alone bounds a write. `GRAFT_BLOB_QUOTA_BYTES` rides
 * beside it so the sentence can name the quota.
 *
 * ## A failed run's blobs
 *
 * A blob is committed when its write returns, before the module's outcome is known, so a module
 * that writes and then throws (or answers something JSON cannot carry) has bytes on the mount the
 * server would otherwise never hear of. Such a failure carries the ledger out ahead of it: on
 * stdout, `ENVELOPE_MARKER` on a line of its own and then `{ result: null, blobs }`, before the
 * error goes to stderr and the process exits 1; on the detached path, the same envelope in the
 * result file with `RESULT_MARKER` on stdout, as a result would be. The server records the rows
 * off it as it does off a success (`run.ts`, `wait_for_process`). A run that wrote nothing fails
 * with nothing on stdout, as before. A timeout (exit 2, or the sandbox's kill) prints nothing, and
 * a blob it committed is the sweep's to adopt from its sidecar (GRA-189).
 *
 * `GRAFT_AGENT` (the agent id) and `GRAFT_TOOL_VERSION` (the version id of the tool running) are set
 * per exec by the run and go into the sidecar and nowhere else — never into a path — and are deleted
 * with the rest before the module loads. `GRAFT_BLOBS_DIR` is the mount path, `/blobs`, set by the
 * run for the same reason `GRAFT_RESULT_PATH` is a variable and not a constant: a backing that maps
 * the sandbox's paths under a root maps the environment's values with them, and this file cannot
 * know the root. Unset, `/blobs` as it stands.
 *
 * ## `NODE_USE_ENV_PROXY=1` has to arrive in the environment, and this file cannot set it
 *
 * The hosted sandbox reaches the proxy only through its `HTTPS_PROXY`, which Node's built-in `fetch`
 * ignores unless `NODE_USE_ENV_PROXY=1` is set *at process start* (ADR 0002 has the two backings; the
 * Docker form routes to the proxy directly and needs neither). A warning below is all this file adds.
 *
 * ## `GRAFT_DRY_RUN=1` is a dry run, and the report replaces the result
 *
 * Set by a publish given a test input, or by a run asked for as a dry run. The token carries the
 * dry-run claim, so the proxy forwards `GET` and `HEAD` and stops every other method with a **preview**
 * of the request that would have left, marked `x-graft-dry-run: intercepted`. `ctx.fetch` records each
 * call — a read's path and status, an intercepted write's preview — and hands the module the proxy's
 * response unchanged, so the module runs its own code against the preview. A read the proxy refused
 * because **no response came from the vendor** arrives marked `x-graft-refusal: <reason>`, and its
 * record carries that `reason` with the `code` and `host` the proxy's body names (GRA-79); a vendor's
 * own status, a 5xx included, carries none of these and is recorded as status alone. What stdout (or the result
 * file) then carries is not the module's result but a **dry-run report** holding it: what was verified
 * — every read that reached the vendor and every write request that reached the proxy — apart from
 * what was not, which is anything the module did after an intercepted write, since no real response
 * existed. A dry run *passes* on the preview: every read `2xx`/`3xx`, every write request well-formed
 * up to the proxy, and the module not failing before it got that far. A throw after an intercepted
 * write is reported inside the report and does not fail it, and the process exits `0` with the report
 * either way; only a timeout keeps its own exit code. `passed` is the model's answer, never a person's
 * — a person is never shown a dry run (`CONTEXT.md`).
 *
 * An SDK's calls cross the proxy with the same token, so the dry-run claim is honoured for them too;
 * but they do not pass through `ctx.fetch`, so the report records only what did. A module that leans
 * on an SDK is proven by what it did with the answers, not by a list of its calls.
 *
 * ## `GRAFT_RESULT_PATH` is the detached path
 *
 * Set by a detached exec, for work past the synchronous cap: the envelope is written to that file,
 * whole, and stdout carries `__GRAFT_RESULT__:<path>` instead of the JSON, so the process record's
 * logs say where the result went and the caller reads the file back once the status says the process
 * has finished. Written beside and renamed into place, so a reader that races the write sees the whole
 * envelope or no file — never half of one. Unset, stdout carries the JSON as above.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_THREW = 1;
const EXIT_TIMEOUT = 2;
const EXIT_USAGE = 64;

const DEFAULT_TIMEOUT_MS = 60_000;
/** How much of a failure's text reaches stderr. The end is where the useful part is. */
const STDERR_TAIL_CHARS = 4_000;
/** What stdout carries in place of the result when the result went to a file — see the header. */
const RESULT_MARKER = "__GRAFT_RESULT__:";
/** The entry a directory is run through, first match wins — `MODULE_ENTRIES` in `runner-source.ts`. */
const ENTRIES = ["index.ts", "index.mjs"];

const modulePath = process.argv[2];
const proxyUrl = process.env.GRAFT_PROXY_URL;
const connection = process.env.GRAFT_CONNECTION;
const token = process.env.GRAFT_TOKEN;
const timeoutMs = Number(process.env.GRAFT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
const resultPath = process.env.GRAFT_RESULT_PATH;
const dryRun = process.env.GRAFT_DRY_RUN === "1";
/** The agent and the tool version this run is for — into a blob's sidecar and nowhere else (the header). */
const agentId = process.env.GRAFT_AGENT || null;
const toolVersion = process.env.GRAFT_TOOL_VERSION || null;

/**
 * Where the agent's blobs directory is mounted, the suffix of a blob still being written, and the two
 * files in a blob — `BLOBS_MOUNT_PATH`, `BLOB_TMP_SUFFIX`, `BLOB_DATA_FILE` and `BLOB_META_FILE` in
 * `@graft/toolbox`'s layout, spelt again here because this file ships to the sandbox alone;
 * `packages/mcp/src/run.test.ts` pins the two spellings together (GRA-186).
 */
const BLOBS_MOUNT_PATH = "/blobs";
const BLOB_TMP_SUFFIX = ".tmp";
const BLOB_DATA_FILE = "data";
const BLOB_META_FILE = "meta.json";
/** The ref's scheme, the per-blob cap and the life of a blob — `runner-source.ts` declares the same three; `runner.test.ts` pins them. */
const BLOB_REF_SCHEME = "blob://";
const MAX_BLOB_BYTES = 256 * 1024 * 1024;
const BLOB_TTL_MS = 24 * 60 * 60 * 1000;
/** What a blob id may be: `@graft/toolbox`'s segment rule (`assertBlobId`), so an id is a directory name and never a path. */
const BLOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * What a blob's `name` and `contentType` may be, so the sidecar and the ledger the result carries
 * are bounded by construction (`MAX_BLOB_NAME_CHARS`, `MAX_BLOB_CONTENT_TYPE_CHARS` in
 * `runner-source.ts`, pinned by `runner.test.ts`; the server drops a line past either): a name is a
 * file name, no slash and no control character; a content type is shaped like a media type, with
 * parameters allowed after a `;`.
 */
const MAX_BLOB_NAME_CHARS = 255;
const MAX_BLOB_CONTENT_TYPE_CHARS = 128;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is refused.
const BLOB_NAME_REFUSED = /[ -/\\]/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;.*)?$/i;
/**
 * The first line of the envelope on stdout and in the result file — `ENVELOPE_MARKER` in
 * `runner-source.ts`, in the family of `RESULT_MARKER`. Only the runner writes it, after the module
 * has settled, so a module's own JSON, whatever its shape, is never read as the envelope.
 */
const ENVELOPE_MARKER = "__GRAFT_ENVELOPE__:1";
/**
 * Where this run's blobs live: `GRAFT_BLOBS_DIR`, which the run sets to the mount path — a backing
 * that maps the sandbox's paths (the fake, `rewriteEnvPaths`) maps this value with them, as it maps
 * `GRAFT_RESULT_PATH` — or the mount path itself for a runner invoked by hand without it.
 */
const blobsDir = process.env.GRAFT_BLOBS_DIR || BLOBS_MOUNT_PATH;

/** The ledger the envelope carries: every blob this run wrote, in write order (the header). */
const blobLedger = [];
/**
 * What this run may still commit under the agent's quota (the header): `GRAFT_BLOB_BUDGET_BYTES`,
 * which the server's door sets per exec from the agent's live rows (GRA-187), since the sandbox has
 * no route to the database. Unset, or not a number, is no budget: a server older than the variable
 * (or a runner invoked by hand) bounds a write by the per-blob cap alone, as before the variable.
 * The quota itself rides beside it for the sentence, and is never a bound here.
 */
const blobBudgetBytes =
  readByteCount(process.env.GRAFT_BLOB_BUDGET_BYTES) ?? Number.POSITIVE_INFINITY;
const blobQuotaBytes =
  readByteCount(process.env.GRAFT_BLOB_QUOTA_BYTES) ?? Number.POSITIVE_INFINITY;
/**
 * Bytes this run holds against its budget: every committed blob's size plus every byte a write in
 * progress has landed so far. Reserved as the chunks land, not after the commit, so several writes
 * in flight at once (`Promise.all`) share one figure and cannot each see the whole remainder
 * (Greptile on #148); a refused or failed write gives its reservation back with its `.tmp`.
 */
let blobBytesReserved = 0;

function readByteCount(value) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** The proxy's marker on a dry-run answer and the value for a stopped write — `DRY_RUN_HEADER` in `runner-source.ts`. */
const DRY_RUN_HEADER = "x-graft-dry-run";
const DRY_RUN_INTERCEPTED = "intercepted";
/**
 * The proxy's mark on a refusal it made because no response came from the vendor, carrying the
 * reason — `REFUSAL_HEADER` in `runner-source.ts`. A read that bears it is recorded with the reason,
 * and with the `code` and `host` the proxy's body names, so the report can say the network stood in
 * the way and not the vendor (GRA-79).
 */
const REFUSAL_HEADER = "x-graft-refusal";
/** Methods the proxy forwards in a dry run; everything else it stops with a preview. */
const READ_METHODS = new Set(["GET", "HEAD"]);
/** How much of a previewed body the report carries — the head, since a body's shape is at its start. */
const MAX_RECORDED_BODY_CHARS = 4_000;
/** How many calls the report records in full. Past this it counts, so a loop cannot flood the model. */
const MAX_RECORDED_CALLS = 50;
/** What `ctx.proxyBase(host)` and an absolute URL's host must be: a host name, optionally with a port, and nothing that could be a path. */
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/**
 * What the dry run saw, in call order — see the header. `writesRefused` is a write that did *not* come
 * back as a preview: `ctx.fetch` refused it before any request was made, or the proxy answered a
 * refusal (a bad token, another connection) rather than intercepting it.
 */
const dryRunRecord = { reads: [], writesPreviewed: [], writesRefused: [], omitted: 0 };

function recordCall(list, entry) {
  const recorded =
    dryRunRecord.reads.length +
    dryRunRecord.writesPreviewed.length +
    dryRunRecord.writesRefused.length;
  if (recorded >= MAX_RECORDED_CALLS) {
    dryRunRecord.omitted += 1;
    return;
  }
  list.push(entry);
}

function boundBody(body) {
  if (body === undefined || body === null) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > MAX_RECORDED_BODY_CHARS
    ? `${text.slice(0, MAX_RECORDED_BODY_CHARS)}…`
    : text;
}

/**
 * The preview the proxy answered an intercepted write with, as the report carries it: what would have
 * left, from the proxy's own account (the header *names* it would have sent, never values) — falling
 * back to what the module sent where the preview cannot be read, so the report is never empty for a
 * call that was made. The response is cloned, so the module still reads the preview it was handed.
 */
async function recordPreview(method, path, headers, init, response) {
  let preview = null;
  try {
    preview = await response.clone().json();
  } catch {
    preview = null;
  }
  // The proxy's shape: `{ dryRun, intercepted, request: { method, path, headerNames, body, … } }`.
  const request =
    preview !== null && typeof preview === "object" && typeof preview.request === "object"
      ? preview.request
      : null;
  const headerNames =
    request !== null && Array.isArray(request.headerNames)
      ? request.headerNames
      : [...headers.keys()].filter((name) => name !== "authorization").sort();
  // The proxy's account names the vendor path alone, which loses the host a write on the host route
  // went to: two writes to one path on two declared hosts would read as one. So a write the module
  // addressed by an absolute URL is recorded by that URL, host and all, as a read on the same route
  // is (GRA-197; Greptile on #156); a relative one keeps the proxy's path as before.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
  recordCall(dryRunRecord.writesPreviewed, {
    method: request !== null && typeof request.method === "string" ? request.method : method,
    path: !absolute && request !== null && typeof request.path === "string" ? request.path : path,
    headerNames,
    body: boundBody(request !== null && "body" in request ? request.body : init.body),
  });
}

/**
 * What the proxy's own refusal body says of a read it could not make: `code` (the cause's errno or
 * name) and `host`, off a clone so the module still reads the body it was handed. Only ever called
 * for a response bearing `REFUSAL_HEADER`, whose body is the proxy's and not a vendor's; a body
 * that will not parse leaves both null rather than the record empty.
 */
async function recordRefusal(response) {
  let refusal = null;
  try {
    refusal = await response.clone().json();
  } catch {
    refusal = null;
  }
  const field = (name) =>
    refusal !== null && typeof refusal === "object" && typeof refusal[name] === "string"
      ? refusal[name]
      : null;
  return { code: field("code"), host: field("host") };
}

// Before anything the module wrote can run — see the header. Every variable the runner needs is in a
// constant above by now. The sweep is over the prefix rather than the six names so it matches the
// breadth of the check's `execute-environment` rule (`module-check.core.ts` refuses any `GRAFT_*`
// read), and so a variable added to the exec's environment later is hidden without a second edit here.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GRAFT_")) delete process.env[name];
}

if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== "1") {
  process.stderr.write(
    "runner: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not, so fetch will not go through the proxy and will time out behind the firewall\n",
  );
}

/**
 * Write to stderr and exit. Waits for the write to flush; `process.exit` alone can truncate a pipe.
 * The tail rather than the head, and marked as a tail, so a long stack still ends in the line that
 * matters.
 */
function fail(code, message) {
  const text =
    message.length > STDERR_TAIL_CHARS
      ? `…${message.slice(message.length - STDERR_TAIL_CHARS)}`
      : message;
  process.stderr.write(`${text}\n`, () => process.exit(code));
}

/**
 * A module's failure after it wrote a blob (the header, "A failed run's blobs"): the blob is
 * committed and the server must learn of it, so the ledger goes out ahead of the failure as an
 * envelope with `result: null`, behind the same `ENVELOPE_MARKER` line a result's envelope sits
 * behind, so the server has one reader for both. On stdout it is the two lines; on the detached
 * path it goes to the result file with `RESULT_MARKER` on stdout, as a result would. A run that
 * wrote nothing fails exactly as it always did, with nothing on stdout. A timeout cannot come
 * through here: the process is killed with nothing printed, and the sweep adopts the directory
 * from its sidecar (GRA-189).
 */
async function failWithLedger(code, message) {
  if (blobLedger.length === 0) {
    fail(code, message);
    return;
  }
  const json = `${ENVELOPE_MARKER}\n${JSON.stringify({ result: null, blobs: blobLedger })}`;
  try {
    if (resultPath) {
      await mkdir(dirname(resultPath), { recursive: true });
      await writeFile(`${resultPath}.tmp`, json, "utf8");
      await rename(`${resultPath}.tmp`, resultPath);
      await new Promise((resolve) =>
        process.stdout.write(`${RESULT_MARKER}${resultPath}\n`, resolve),
      );
    } else {
      await new Promise((resolve) => process.stdout.write(`${json}\n`, resolve));
    }
  } catch (error) {
    fail(
      code,
      `${message}\n(the ledger of ${blobLedger.length} blob(s) written could not be reported: ${describe(error)})`,
    );
    return;
  }
  fail(code, message);
}

function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const lines = [error.stack || `${error.name}: ${error.message}`];
  // The chain, bounded: `fetch failed` is all undici's TypeError says, and the host it could not
  // reach is in `cause`. Last, so `fail`'s tail keeps it.
  let cause = error.cause;
  for (
    let depth = 0;
    cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH;
    depth += 1
  ) {
    lines.push(`  caused by: ${describeCause(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

const MAX_CAUSE_DEPTH = 5;

function describeCause(cause) {
  if (cause instanceof Error) {
    const code = typeof cause.code === "string" ? ` [${cause.code}]` : "";
    return `${cause.name}${code}: ${cause.message}`;
  }
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** The file to import: the path itself when it is a file, else the first entry the directory holds. */
async function resolveModule(path) {
  const target = resolve(path);
  const info = await stat(target).catch(() => null);
  if (info?.isFile()) return target;
  if (info?.isDirectory()) {
    for (const entry of ENTRIES) {
      const candidate = join(target, entry);
      const entryInfo = await stat(candidate).catch(() => null);
      if (entryInfo?.isFile()) return candidate;
    }
  }
  return null;
}

async function readStdin() {
  // A TTY never closes on its own, and an interactive caller who forgot to pipe anything should get
  // an empty input rather than a hang.
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function unbound(what) {
  return new Error(
    `${what} is unavailable: this run has no connection bound (GRAFT_PROXY_URL and GRAFT_CONNECTION are unset). Run the module through the connection's execute tool to reach the vendor.`,
  );
}

/** `${proxyUrl}/c/${connection}/` as a URL, the prefix every request of this run is under. */
function connectionPrefix() {
  const base = proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`;
  return new URL(`c/${connection}/`, base);
}

/**
 * The base URL an SDK is pointed at — see the header. Without a host, the connection's primary; with
 * one, the `/h/<host>` form the proxy resolves against the connection's declared set (ADR 0010).
 */
function proxyBase(host) {
  if (!proxyUrl || !connection) throw unbound("ctx.proxyBase");
  const base = connectionPrefix().href.replace(/\/$/, "");
  if (host === undefined) return base;
  if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
    throw new Error(
      `ctx.proxyBase takes a host name the connection declares, such as "api.example.com", not ${JSON.stringify(host)}.`,
    );
  }
  return `${base}/h/${host}`;
}

/**
 * An absolute URL given to `ctx.fetch`, rewritten onto the proxy's host form (the header):
 * `https://files.slack.com/upload/v1/abc?x=1` becomes `${prefix}h/files.slack.com/upload/v1/abc?x=1`,
 * the same route `ctx.proxyBase("files.slack.com")` names, so the proxy judges the host against the
 * connection's set and this function judges nothing about the set (GRA-197). What it does refuse is
 * what would make the rewrite a lie: a scheme other than `https:` (the proxy speaks only that to a
 * vendor), credentials in the URL (the proxy supplies the credential, and a module never holds one),
 * and a host that is not a host name (so it cannot become a path). The fragment is dropped, as fetch
 * drops it. `refuse` is the caller's, so a refused write is on the dry run's report as before.
 */
function hostRoute(target, prefix, refuse) {
  let given;
  try {
    given = new URL(target);
  } catch {
    throw refuse(`ctx.fetch refused a URL it could not parse: ${target}`);
  }
  if (given.protocol !== "https:") {
    throw refuse(
      `ctx.fetch takes an https:// URL on one of the connection's hosts, or a vendor-relative path such as "/v1/orders", not ${given.protocol}// (${target}).`,
    );
  }
  if (given.username !== "" || given.password !== "") {
    throw refuse(
      `ctx.fetch refused a URL carrying credentials for ${given.host}: the proxy supplies the connection's credential, and a module never holds one.`,
    );
  }
  if (!HOST_PATTERN.test(given.host)) {
    throw refuse(
      `ctx.fetch refused a URL whose host is not a host name (${given.host}); the proxy reaches a host the connection declares, such as "files.example.com".`,
    );
  }
  return new URL(`h/${given.host}${given.pathname}${given.search}`, prefix);
}

function boundFetch(path, init = {}) {
  if (!proxyUrl || !connection) throw unbound("ctx.fetch");
  const target = String(path);
  const method = String(init.method ?? "GET").toUpperCase();
  // A refusal here never reaches the proxy; in a dry run it is still part of the report, because a
  // write the module could not even address is a write request that was not well-formed.
  const refuse = (message) => {
    if (dryRun && !READ_METHODS.has(method)) {
      recordCall(dryRunRecord.writesRefused, {
        method,
        path: target,
        status: null,
        error: message,
      });
    }
    return new Error(message);
  };
  const prefix = connectionPrefix();
  let url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    url = hostRoute(target, prefix, refuse);
  } else {
    url = new URL(target.replace(/^\/+/, ""), prefix);
    if (!url.href.startsWith(prefix.href)) {
      throw refuse(`ctx.fetch refused a path that leaves the connection: ${target}`);
    }
  }

  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  // Never follow: the proxy returned the vendor's 3xx unfollowed on purpose, and the only host this
  // sandbox can reach is the proxy — see the header.
  const request = { ...init, headers, redirect: "manual" };
  if (!dryRun) return fetch(url, request);
  return dryRunFetch(url, request, { method, path: target, headers, init });
}

/**
 * The dry-run half of `ctx.fetch`: the same request, and a record of what came back — see the header.
 * The response reaches the module as the proxy sent it; only the record is this function's.
 */
async function dryRunFetch(url, request, call) {
  const response = await fetch(url, request);
  if (READ_METHODS.has(call.method)) {
    const reason = response.headers.get(REFUSAL_HEADER);
    recordCall(dryRunRecord.reads, {
      method: call.method,
      path: call.path,
      status: response.status,
      ...(reason ? { reason, ...(await recordRefusal(response)) } : {}),
    });
    return response;
  }
  if (response.headers.get(DRY_RUN_HEADER) === DRY_RUN_INTERCEPTED) {
    await recordPreview(call.method, call.path, call.headers, call.init, response);
    return response;
  }
  recordCall(dryRunRecord.writesRefused, {
    method: call.method,
    path: call.path,
    status: response.status,
    error: null,
  });
  return response;
}

/** A refusal of `ctx.blob`'s: the reason word first, so stderr and a `cause` line both name it, and on `code` for a module that reads it. */
function blobRefusal(reason, message) {
  return Object.assign(new Error(`${reason}: ${message}`), { code: reason });
}

/**
 * The id inside a ref, and the blob's directory under the mount (the header). A string that is
 * not `blob://<id>` is `blob_not_found` with a sentence saying what a ref looks like; an id that is
 * not a directory name, or names a `.tmp`, is `blob_not_found` too, since nothing under `/blobs`
 * can be called that.
 */
function resolveBlobRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(BLOB_REF_SCHEME)) {
    throw blobRefusal(
      "blob_not_found",
      `${JSON.stringify(ref)} is not a blob ref and names no blob this agent holds. ctx.blob takes the ${BLOB_REF_SCHEME}<id> string ctx.blob.write answered.`,
    );
  }
  const id = ref.slice(BLOB_REF_SCHEME.length);
  if (!BLOB_ID_PATTERN.test(id) || id === "." || id === ".." || id.endsWith(BLOB_TMP_SUFFIX)) {
    throw blobNotFound(ref);
  }
  return { id, dir: `${blobsDir}/${id}` };
}

function blobNotFound(ref) {
  return blobRefusal(
    "blob_not_found",
    `${ref} names no blob this agent holds. It may have expired, or been written by another agent; run the tool that produced it again.`,
  );
}

/**
 * The blob's directory, once it is known to be one: the directory and the two files in it are each
 * `lstat`ed, so a symlink anywhere in the three (a path a dependency planted, pointing out of the
 * mount) is `blob_not_found` rather than followed, as the header lists. `stat` and `read` both open
 * a blob through here.
 */
async function openBlob(ref) {
  const { dir } = resolveBlobRef(ref);
  const entry = await lstatOrNotFound(dir, ref);
  if (!entry.isDirectory()) throw blobNotFound(ref);
  for (const file of [BLOB_META_FILE, BLOB_DATA_FILE]) {
    const inside = await lstatOrNotFound(join(dir, file), ref);
    if (!inside.isFile()) throw blobNotFound(ref);
  }
  return dir;
}

async function lstatOrNotFound(path, ref) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw blobNotFound(ref);
    throw error;
  }
}

/** The sidecar of an opened blob, as `stat` answers it. */
async function readBlobMeta(dir) {
  const meta = JSON.parse(await readFile(join(dir, BLOB_META_FILE), "utf8"));
  return {
    bytes: meta.bytes,
    contentType: meta.contentType,
    ...(typeof meta.name === "string" ? { name: meta.name } : {}),
    expiresAt: meta.expiresAt,
  };
}

/** Bytes as `ctx.blob.write` accepts them: a `Uint8Array` (a `Buffer` included), any other view, or an `ArrayBuffer`. */
function bytesOf(chunk, what) {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new Error(
    `${what} bytes: a Uint8Array, a Blob or a ReadableStream<Uint8Array>, not ${describeType(chunk)}. Encode text with new TextEncoder().encode(text).`,
  );
}

function describeType(value) {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return value.constructor?.name ? `a ${value.constructor.name}` : "an object";
}

/** `data` as something to iterate chunks of: one chunk for bytes, the stream of a `Blob`, a `ReadableStream` as it is. */
function blobSource(data) {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.stream();
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) return data;
  return [bytesOf(data, "ctx.blob.write takes")];
}

/**
 * `ctx.blob.write` — see the header. The bytes are streamed and counted on the way in, the cap
 * refused mid-stream, and the directory renamed into place once `data` and `meta.json` are both
 * whole: the one commit point. Whatever fails, the `.tmp` directory goes before the error does.
 */
async function blobWrite(data, opts) {
  const contentType =
    opts !== null && typeof opts === "object" && typeof opts.contentType === "string"
      ? opts.contentType.trim()
      : "";
  if (contentType === "") {
    throw new Error(
      'ctx.blob.write takes { contentType } naming the media type of the bytes, such as "application/pdf", and an optional name.',
    );
  }
  if (contentType.length > MAX_BLOB_CONTENT_TYPE_CHARS || !MEDIA_TYPE_PATTERN.test(contentType)) {
    throw blobRefusal(
      "blob_invalid_content_type",
      `ctx.blob.write's contentType is a media type such as "application/pdf" or "text/csv; charset=utf-8", at most ${MAX_BLOB_CONTENT_TYPE_CHARS} characters, not ${JSON.stringify(contentType.slice(0, 64))}.`,
    );
  }
  if (opts.name !== undefined && opts.name !== null && typeof opts.name !== "string") {
    throw new Error(`ctx.blob.write's name is a string, not ${describeType(opts.name)}.`);
  }
  const name = typeof opts.name === "string" && opts.name !== "" ? opts.name : undefined;
  if (name !== undefined && (name.length > MAX_BLOB_NAME_CHARS || BLOB_NAME_REFUSED.test(name))) {
    throw blobRefusal(
      "blob_invalid_name",
      `ctx.blob.write's name is a file name such as "invoice.pdf": at most ${MAX_BLOB_NAME_CHARS} characters, no slash, no control character.`,
    );
  }
  const source = blobSource(data);

  const id = randomUUID();
  const tmp = `${blobsDir}/${id}${BLOB_TMP_SUFFIX}`;
  const dir = `${blobsDir}/${id}`;
  try {
    // Not recursive on purpose: a sandbox with no `/blobs` mount has nowhere a blob may live, and
    // making the directory on the sandbox's own disk would hide the file from the server.
    await mkdir(tmp);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw blobRefusal(
        "blob_store_unavailable",
        `${blobsDir} is not mounted in this sandbox, so no blob can be written here.`,
      );
    }
    throw error;
  }

  // Two bounds on this write (the header), judged per chunk as the bytes land: the per-blob cap on
  // this write's own count, and the budget on the shared reservation, which every write in flight
  // adds to as it goes. One chunk is one synchronous step, so the shared figure is exact.
  let bytes = 0;
  try {
    const counted = async function* () {
      for await (const chunk of source) {
        const part = bytesOf(chunk, "a stream handed to ctx.blob.write yields");
        bytes += part.byteLength;
        blobBytesReserved += part.byteLength;
        if (blobBytesReserved > blobBudgetBytes || bytes > MAX_BLOB_BYTES) {
          // What this write had left to it: the budget less what every other write holds.
          const left = Math.max(0, blobBudgetBytes - (blobBytesReserved - bytes));
          throw bytes > MAX_BLOB_BYTES && left >= MAX_BLOB_BYTES
            ? blobRefusal(
                "blob_too_large",
                `the blob passed ${MAX_BLOB_BYTES} bytes (256 MiB), the cap on one blob. Write less — a page, a range, a compressed form.`,
              )
            : blobRefusal(
                "blob_quota",
                `the blob would carry this run past the ${formatMiB(left)} MiB left of its budget: the agent's live blobs are at the ${formatMiB(blobQuotaBytes)} MiB quota. A blob expires 24 hours after its write and stops counting then; write less, or run again once one has.`,
              );
        }
        yield part;
      }
    };
    await pipeline(counted(), createWriteStream(join(tmp, BLOB_DATA_FILE)));

    const writtenAt = new Date();
    const expiresAt = new Date(writtenAt.getTime() + BLOB_TTL_MS).toISOString();
    const meta = {
      bytes,
      contentType,
      ...(name !== undefined ? { name } : {}),
      writtenAt: writtenAt.toISOString(),
      expiresAt,
      agentId,
      toolVersion,
    };
    await writeFile(join(tmp, BLOB_META_FILE), JSON.stringify(meta), "utf8");
    await rename(tmp, dir);

    const ref = `${BLOB_REF_SCHEME}${id}`;
    blobLedger.push({
      ref,
      bytes,
      contentType,
      ...(name !== undefined ? { name } : {}),
      expiresAt,
    });
    return ref;
  } catch (error) {
    // A refused or failed write is nowhere: not on disk, not on the ledger, and its reservation
    // goes back to the budget with its `.tmp`.
    blobBytesReserved -= bytes;
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** A byte count in MiB for a sentence, to one decimal where it is not whole. */
function formatMiB(bytes) {
  return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}

/** `ctx.blob.stat` — the sidecar, or `blob_not_found`. */
async function blobStat(ref) {
  return readBlobMeta(await openBlob(ref));
}

/**
 * `ctx.blob.read`: a `Blob` over `data`, opened lazily, typed from the sidecar (the header). The
 * `Blob` holds a handle to the file and nothing of its bytes: `.stream()` reads it in chunks, and
 * only `.arrayBuffer()`, `.bytes()` or `.text()` on the module's side holds it whole.
 */
async function blobRead(ref) {
  const dir = await openBlob(ref);
  const meta = await readBlobMeta(dir);
  return openAsBlob(join(dir, BLOB_DATA_FILE), { type: meta.contentType });
}

async function main() {
  if (!modulePath) {
    fail(
      EXIT_USAGE,
      "usage: node runner.mjs <module directory | index.ts | module.mjs> < input.json",
    );
    return;
  }
  const entry = await resolveModule(modulePath);
  if (!entry) {
    fail(
      EXIT_USAGE,
      `${modulePath} is not a module: expected a directory holding ${ENTRIES.join(" or ")}, or the module file itself.`,
    );
    return;
  }

  const raw = await readStdin();
  let input = {};
  if (raw.trim() !== "") {
    try {
      input = JSON.parse(raw);
    } catch (error) {
      fail(EXIT_USAGE, `stdin is not JSON: ${describe(error)}`);
      return;
    }
  }

  // Started before the import, because a module's top-level `await` can hang as surely as its
  // default export can. Deliberately *not* `unref`'d: a module that never settles and holds no
  // handle would otherwise let the process exit 0 with nothing on stdout — the timer is what turns
  // that silence into exit code 2. A module that finishes ends the process explicitly below.
  const timer = setTimeout(() => {
    fail(
      EXIT_TIMEOUT,
      `Timed out after ${timeoutMs}ms: the module did not settle. For work that legitimately takes longer, start it detached and poll it.`,
    );
  }, timeoutMs);

  // The five the check declares, and no more — see the header.
  const ctx = Object.freeze({
    fetch: boundFetch,
    proxyBase,
    proxyKey: token ?? "",
    connection: connection ?? null,
    blob: Object.freeze({ write: blobWrite, read: blobRead, stat: blobStat }),
  });

  let result;
  let moduleError;
  try {
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.default !== "function") {
      fail(
        EXIT_THREW,
        `${modulePath} must export a default function: export default async function (input, ctx) { ... }`,
      );
      return;
    }
    result = await module.default(input, ctx);
  } catch (error) {
    // In a dry run a throw is part of the report, not the end of the process — see the header.
    if (!dryRun) {
      clearTimeout(timer);
      await failWithLedger(EXIT_THREW, describe(error));
      return;
    }
    moduleError = describe(error);
  }
  clearTimeout(timer);

  let json;
  try {
    json = JSON.stringify(result === undefined ? null : result);
  } catch (error) {
    if (!dryRun) {
      await failWithLedger(
        EXIT_THREW,
        `The module's result is not serialisable as JSON: ${describe(error)}`,
      );
      return;
    }
    moduleError = `The module's result is not serialisable as JSON: ${describe(error)}`;
    json = "null";
  }
  // The envelope — see the header: the result (the dry-run report, in a dry run) beside the ledger
  // of every blob written. The result is parsed back from the JSON it was just checked to be, so
  // one object is serialised and a caller reads one.
  // The marker line first, then the JSON on one line: a reader unwraps only what follows the
  // marker, and a module's own `{ result, blobs }` stays the module's.
  json = `${ENVELOPE_MARKER}\n${JSON.stringify({
    result: dryRun ? dryRunReport(json, moduleError) : JSON.parse(json),
    blobs: blobLedger,
  })}`;
  if (resultPath) {
    // The detached path — see the header. The directory is made here rather than assumed, because a
    // plain command started detached has written nothing under it before the runner runs.
    try {
      await mkdir(dirname(resultPath), { recursive: true });
      await writeFile(`${resultPath}.tmp`, json, "utf8");
      await rename(`${resultPath}.tmp`, resultPath);
    } catch (error) {
      fail(EXIT_THREW, `The result could not be written to ${resultPath}: ${describe(error)}`);
      return;
    }
    process.stdout.write(`${RESULT_MARKER}${resultPath}\n`, () => process.exit(EXIT_OK));
    return;
  }
  process.stdout.write(json, () => process.exit(EXIT_OK));
}

/**
 * The dry-run report — the header's contract, built once the module has settled. `passed` is decided
 * on what was verified: every read answered with a 2xx — a 3xx is the vendor pointing elsewhere,
 * not an answer, and `ctx.fetch` does not follow it — every write request reached the proxy's
 * preview, and the module did not fail *before* it got there — a throw with no write intercepted is
 * the module failing on its own, while a throw after one is the unverified half doing what it must
 * with a preview for a response. The module's result rides inside as `moduleResult`, parsed back from
 * the JSON it was already checked to be, so a caller reads one object; the report itself rides as the
 * envelope's `result`, with the blobs the dry run wrote beside it.
 */
function dryRunReport(resultJson, moduleError) {
  const { reads, writesPreviewed, writesRefused, omitted } = dryRunRecord;
  const readsVerified = reads.every((read) => read.status < 300);
  const writeRequestsVerified = writesRefused.length === 0;
  const failedBeforeAnyWrite = moduleError !== undefined && writesPreviewed.length === 0;
  const passed = readsVerified && writeRequestsVerified && !failedBeforeAnyWrite;
  return {
    dryRun: true,
    passed,
    reads,
    writesPreviewed,
    writesRefused,
    ...(omitted > 0 ? { omitted } : {}),
    ...(moduleError === undefined
      ? { moduleResult: JSON.parse(resultJson) }
      : {
          moduleError:
            moduleError.length > STDERR_TAIL_CHARS
              ? `…${moduleError.slice(moduleError.length - STDERR_TAIL_CHARS)}`
              : moduleError,
        }),
    verified: { reads: readsVerified, writeRequests: writeRequestsVerified },
    unverified: writesPreviewed.length > 0 ? ["post-write handling"] : [],
  };
}

main();
