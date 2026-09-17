/**
 * The runner: how a module of authored code is executed inside a sandbox.
 *
 *   echo '{"orderId": 7}' | node /graft/runner.mjs /tools/unleashed/create-order/v3
 *
 * Seeded onto every sandbox beside the skills (`runner-source.ts` reads this file from the package).
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
 *  - stdin is the JSON input. Empty stdin is `{}`.
 *  - stdout receives exactly the JSON result and nothing else; exit code 0.
 *  - A thrown error puts its message and the tail of its stack on stderr, then each `cause` in its
 *    chain on a line of its own — undici's `fetch failed` keeps the host and the errno there and
 *    nowhere in the stack; exit code 1.
 *  - A timeout — `GRAFT_TIMEOUT_MS`, default sixty seconds — is a distinct message on stderr; exit
 *    code 2. Distinct so the caller can tell "the module is slow" from "the module is wrong".
 *  - Anything wrong with the invocation itself (no path, unparseable stdin) is exit code 64.
 *
 * ## `ctx` is the module's whole route out, and it never sees `GRAFT_*`
 *
 * `ctx` is `{ fetch, proxyBase, proxyKey, connection }`, frozen; the check declares the same four and
 * nothing else (`module-check.core.ts`, `CONTEXT_DECLARATION`).
 *
 *  - `ctx.fetch(path, init)` prepends `${GRAFT_PROXY_URL}/c/${GRAFT_CONNECTION}` to a vendor-relative
 *    path and adds `Authorization: Bearer ${GRAFT_TOKEN}`. Both halves of the binding are refused
 *    rather than bent: an absolute URL, so the token cannot be sent to any host but the proxy; a path
 *    that walks out of `/c/<connection>/`, so it cannot be sent for any connection but the one this
 *    run was minted for. It never follows a redirect (`redirect: "manual"`): a vendor 3xx the proxy
 *    hands back reaches the module as that status with its `Location`. The proxy does not follow
 *    redirects (CONTEXT.md, *Proxy*), and a sandbox can reach nothing but the proxy, so following
 *    one here could only dial a host the egress refuses and die as an opaque `fetch failed` (GRA-64).
 *  - `ctx.proxyBase(host?)` is the base URL an SDK is pointed at: `${GRAFT_PROXY_URL}/c/${connection}`
 *    for the connection's primary host, `…/c/${connection}/h/${host}` for another host the connection
 *    declares (ADR 0010). The proxy pins the request to the connection's host set; this only builds
 *    the address, and refuses a `host` that is not a bare host name so it cannot become a path.
 *  - `ctx.proxyKey` is the capability token itself, for an SDK's credential option — the proxy reads
 *    it from `Authorization` and swaps in the connection's real credential (ADR 0010, amended). It is
 *    the one thing a module holds that is secret-shaped, and it is bounded to this exec, this
 *    connection and minutes. Empty when no connection is bound, as `ctx.fetch` is unavailable then.
 *  - `ctx.connection` is the connection id, or null when none is bound.
 *
 * Every `GRAFT_*` variable is read out of the environment once, below, and then the whole `GRAFT_*`
 * set is deleted from `process.env` **before the module is imported** — so a module that prints its
 * environment prints none of them, and a module built from `process.env.GRAFT_TOKEN` sends no
 * credential at all. The check refuses such a module first (`execute-environment`); the two rules name
 * the same prefix and must change together.
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
 * Set by a detached exec, for work past the synchronous cap: the result is written to that file,
 * whole, and stdout carries `__GRAFT_RESULT__:<path>` instead of the JSON, so the process record's
 * logs say where the result went and the caller reads the file back once the status says the process
 * has finished. Written beside and renamed into place, so a reader that races the write sees the whole
 * result or no file — never half of one. Unset, stdout carries the JSON as above.
 */

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
/** What `ctx.proxyBase(host)` accepts: a host name, optionally with a port, and nothing that could be a path. */
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
  recordCall(dryRunRecord.writesPreviewed, {
    method: request !== null && typeof request.method === "string" ? request.method : method,
    path: request !== null && typeof request.path === "string" ? request.path : path,
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    throw refuse(
      `ctx.fetch takes a vendor-relative path such as "/v1/orders", not an absolute URL (${target}); the proxy supplies the host.`,
    );
  }

  const prefix = connectionPrefix();
  const url = new URL(target.replace(/^\/+/, ""), prefix);
  if (!url.href.startsWith(prefix.href)) {
    throw refuse(`ctx.fetch refused a path that leaves the connection: ${target}`);
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

  // The four the check declares, and no more — see the header.
  const ctx = Object.freeze({
    fetch: boundFetch,
    proxyBase,
    proxyKey: token ?? "",
    connection: connection ?? null,
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
      fail(EXIT_THREW, describe(error));
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
      fail(EXIT_THREW, `The module's result is not serialisable as JSON: ${describe(error)}`);
      return;
    }
    moduleError = `The module's result is not serialisable as JSON: ${describe(error)}`;
    json = "null";
  }
  if (dryRun) json = JSON.stringify(dryRunReport(json, moduleError));
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
 * the JSON it was already checked to be, so a caller reads one object.
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
