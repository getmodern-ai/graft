import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { redactText } from "@graft/core";
import {
  createUpstreamFetch,
  isSafeMethod,
  type UpstreamFetch,
  type UpstreamRequest,
} from "@graft/proxy";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import { checkStockTool } from "./check";
import { dryRunFailureOf, dryRunStockTool, stockConnectionFor } from "./dry-run";
import type { StockHarnessMode } from "./mode";
import {
  parseRecording,
  RECORDING_FILE,
  type RecordedBody,
  type RecordedRead,
  type RecordedWrite,
  recordedBodyOf,
  redactRecording,
  replayResponseOf,
  type StockRecording,
} from "./recording";
import { STOCK_DIR, type StockWorkspaceTool } from "./workspace";

/**
 * The stock harness (ADR 0025; GRA-240): what proves a stock tool on every pull request, with no
 * secret and no vendor reached. Three proofs, each answering the sentences of what failed, every one
 * opening `stock tool <vendor>__<name>:` so a red run names the tool and the cause:
 *
 *  - `proveCheck`: the check passes the module against its own schema, and the annotations it
 *    derives are the ones the manifest declares;
 *  - `proveTestInput`: the input schema compiles and the test input is valid input;
 *  - `proveReplay`: the module runs, as a dry run, by the real runner through the real proxy, whose
 *    vendor is the recording (`RECORDING.md`). Its reads must be the recording's, in order; its
 *    writes stop at the proxy's preview, never reach the vendor, and must be the recording's; and its
 *    result must be the recording's. In live mode (`mode.ts`) the reads go to the vendor instead.
 *
 * `harness.test.ts` runs the three over every tool in the workspace.
 */

export type ProofProblems = string[];

const wireOf = (tool: Pick<StockWorkspaceTool, "vendor" | "name">) =>
  `${tool.vendor}__${tool.name}`;

const sayer = (tool: Pick<StockWorkspaceTool, "vendor" | "name">) => (cause: string) =>
  `stock tool ${wireOf(tool)}: ${cause}`;

export async function proveCheck(tool: StockWorkspaceTool): Promise<ProofProblems> {
  const say = sayer(tool);
  const verdict = await checkStockTool(tool);
  if (!verdict.ok) {
    return verdict.problems.map((problem) => say(`the check refuses the module: ${problem}`));
  }
  const problems: ProofProblems = [];
  for (const key of ["readOnly", "destructive"] as const) {
    if (verdict.annotations[key] !== tool.annotations[key]) {
      problems.push(
        say(
          `its manifest declares ${key}: ${tool.annotations[key]}, but the check derives ${key}: ${verdict.annotations[key]} from the module`,
        ),
      );
    }
  }
  return problems;
}

/** The validator a run uses (`@graft/mcp`'s `schema.ts`): the MCP SDK's Ajv provider. */
export function proveTestInput(tool: StockWorkspaceTool): ProofProblems {
  const say = sayer(tool);
  let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  try {
    validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
  } catch (error) {
    return [say(`its input schema does not compile: ${String(error)}`)];
  }
  const verdict = validate(tool.testInput);
  return verdict.valid
    ? []
    : [say(`its test input fails its input schema: ${verdict.errorMessage ?? "invalid"}`)];
}

/** The tool's recording off the workspace, or a sentence saying why there is none to replay. */
export async function readStockRecording(
  tool: Pick<StockWorkspaceTool, "vendor" | "name">,
  dir: string = STOCK_DIR,
): Promise<{ ok: true; recording: StockRecording } | { ok: false; problem: string }> {
  const say = sayer(tool);
  const where = `${tool.vendor}/${tool.name}/${RECORDING_FILE}`;
  let text: string;
  try {
    text = await readFile(join(dir, tool.vendor, tool.name, RECORDING_FILE), "utf8");
  } catch {
    return { ok: false, problem: say(`${where} is missing; the build command writes it`) };
  }
  try {
    return { ok: true, recording: parseRecording(text, where) };
  } catch (error) {
    return { ok: false, problem: say((error as Error).message) };
  }
}

/** What the replay saw beside its sentences: every request that reached the vendor, and every preview. */
export type ReplayReport = {
  problems: ProofProblems;
  /** Every request the proxy sent on to the vendor (the recording, in replay mode). */
  reachedVendor: { method: string; url: string }[];
  /** Every write the proxy stopped, as its preview named it. */
  previewed: { method: string; host: string; path: string; body: RecordedBody | undefined }[];
};

/** A read as the comparison sees it: method, host, path, and the query as sorted pairs. */
type ReadKey = { method: string; host: string; path: string; query: [string, string][] };

function readKeyOf(method: string, url: string): ReadKey {
  const parsed = new URL(url);
  return {
    method: method.toUpperCase(),
    host: parsed.hostname.toLowerCase(),
    path: parsed.pathname,
    query: [...parsed.searchParams].sort(([a, x], [b, y]) =>
      a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
    ),
  };
}

/**
 * Whether the request the module made is the recorded read. A recorded query parameter whose value
 * was redacted is the credential a scheme put there, so its name is set aside on both sides; live,
 * where a value may follow the vendor's own data, the parameter names alone are compared.
 */
function sameRead(recorded: ReadKey, actual: ReadKey, live: boolean): boolean {
  if (recorded.method !== actual.method || recorded.host !== actual.host) return false;
  if (recorded.path !== actual.path) return false;
  const secret = new Set(
    recorded.query.filter(([, value]) => value.startsWith("[redacted")).map(([name]) => name),
  );
  const keep = (query: [string, string][]) =>
    query
      .filter(([name]) => !secret.has(name))
      .map(([name, value]) => (live ? name : `${name}=${value}`));
  return isDeepStrictEqual(keep(recorded.query), keep(actual.query));
}

/** Every key path of a JSON value, arrays collapsed to `[]`, for the live comparison of shapes. */
function keyPaths(value: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keyPaths(entry, `${prefix}[]`, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      keyPaths(entry, path, out);
    }
  }
  return out;
}

function describeBody(body: RecordedBody | undefined): string {
  if (!body) return "no body";
  const text =
    "json" in body ? JSON.stringify(body.json) : "text" in body ? body.text : body.base64;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sameBody(a: RecordedBody | undefined, b: RecordedBody | undefined): boolean {
  return isDeepStrictEqual(a ?? null, b ?? null);
}

export async function proveReplay(
  tool: StockWorkspaceTool,
  recording: StockRecording,
  mode: StockHarnessMode = { kind: "replay", tools: null },
): Promise<ReplayReport> {
  const say = sayer(tool);
  const problems: ProofProblems = [];
  const reachedVendor: ReplayReport["reachedVendor"] = [];
  const previewed: ReplayReport["previewed"] = [];
  const live = mode.kind === "live";
  const liveConnection = live ? (mode.connections[tool.vendor] ?? null) : null;
  const secrets = Object.values(liveConnection?.credential ?? {});
  // A live sentence may carry a vendor's text; nothing in it may carry the credential.
  const finish = (): ReplayReport => ({
    problems: problems.map((problem) => redactText(problem, { secretValues: secrets }).text),
    reachedVendor,
    previewed,
  });

  if (recording.tool !== wireOf(tool)) {
    problems.push(say(`its recording is of ${recording.tool}`));
    return finish();
  }
  if (!isDeepStrictEqual(recording.input, tool.testInput)) {
    problems.push(
      say("its recording was made with another input than test-input.json; rebuild it"),
    );
    return finish();
  }
  if (redactRecording(recording).redacted) {
    problems.push(
      say(
        "its recording holds something credential-shaped that redaction would replace; write it through redactRecording",
      ),
    );
    return finish();
  }

  // Replay needs no credential, whatever the starter's scheme: the vendor is the recording.
  const connection = stockConnectionFor(tool, liveConnection, live);
  if (typeof connection === "string") {
    problems.push(say(connection));
    return finish();
  }

  const reads = recording.exchanges.filter((e): e is RecordedRead => e.kind === "read");
  const writes = recording.exchanges.filter((e): e is RecordedWrite => e.kind === "write");
  let next = 0;
  const realFetch = live ? createUpstreamFetch() : null;

  const upstreamFetch: UpstreamFetch = async (request: UpstreamRequest, init) => {
    reachedVendor.push({ method: request.method, url: request.url });
    if (!isSafeMethod(request.method)) {
      problems.push(
        say(
          `a ${request.method} reached the vendor in a dry run: ${new URL(request.url).pathname}`,
        ),
      );
      return Response.json({ error: "write_reached_vendor" }, { status: 500 });
    }
    const expected = reads[next];
    const actual = readKeyOf(request.method, request.url);
    const shown = `${actual.method} ${actual.host}${actual.path}`;
    if (!expected) {
      problems.push(say(`it made a read the recording does not hold: ${shown}`));
      return Response.json({ error: "not_in_recording" }, { status: 404 });
    }
    if (!sameRead(readKeyOf(expected.method, expected.url), actual, live)) {
      const recorded = readKeyOf(expected.method, expected.url);
      problems.push(
        say(
          `its read ${next + 1} disagrees with the recording: it made ${shown}${actual.query.length ? `?${new URLSearchParams(actual.query)}` : ""}, the recording holds ${recorded.method} ${recorded.host}${recorded.path}${recorded.query.length ? `?${new URLSearchParams(recorded.query)}` : ""}`,
        ),
      );
      next += 1;
      return Response.json({ error: "not_in_recording" }, { status: 404 });
    }
    next += 1;
    if (!realFetch) return replayResponseOf(expected);

    const response = await realFetch(request, init);
    if (response.status !== expected.response.status) {
      problems.push(
        say(
          `the vendor answered ${shown} with ${response.status}; the recording holds ${expected.response.status}`,
        ),
      );
    }
    // The vendor's body is read whole here, to compare its shape, and handed on as the same bytes.
    const bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
    const recordedBody = expected.response.body;
    if (recordedBody && "json" in recordedBody) {
      const body = recordedBodyOf(bytes);
      const have = body && "json" in body ? keyPaths(body.json) : new Set<string>();
      const lost = [...keyPaths(recordedBody.json)].filter((path) => !have.has(path));
      if (lost.length > 0) {
        problems.push(
          say(
            `the vendor's answer to ${shown} lacks fields the recording holds: ${lost.slice(0, 10).join(", ")}${lost.length > 10 ? ` and ${lost.length - 10} more` : ""}`,
          ),
        );
      }
    }
    return { ...response, body: new Response(bytes).body };
  };

  const run = await dryRunStockTool({
    tool,
    connection,
    credential: liveConnection?.credential ?? {},
    upstreamFetch,
    onPreview: (write) => previewed.push(write),
  });
  if (!run.ran) {
    problems.push(
      say(
        `the module did not run (exit ${run.code}): ${run.stderr.trim().slice(-500) || "no output"}`,
      ),
    );
    return finish();
  }
  const { report } = run;
  for (let index = next; index < reads.length; index += 1) {
    const missed = reads[index] as RecordedRead;
    problems.push(
      say(`it never made the recording's read ${index + 1}: ${missed.method} ${missed.url}`),
    );
  }

  if (previewed.length !== writes.length) {
    problems.push(
      say(
        `it made ${previewed.length} write(s) that stopped at the preview; the recording holds ${writes.length}`,
      ),
    );
  }
  writes.forEach((write, index) => {
    const made = previewed[index];
    if (!made) return;
    const url = new URL(write.url);
    if (made.method !== write.method || made.host !== url.hostname || made.path !== url.pathname) {
      problems.push(
        say(
          `its write ${index + 1} disagrees with the recording: it made ${made.method} ${made.host}${made.path}, the recording holds ${write.method} ${url.hostname}${url.pathname}`,
        ),
      );
    } else if (!live && !sameBody(made.body, write.body)) {
      problems.push(
        say(
          `its write ${index + 1}'s body disagrees with the recording: it sent ${describeBody(made.body)}, the recording holds ${describeBody(write.body)}`,
        ),
      );
    }
  });

  if (!report.passed) {
    problems.push(say(`its dry run did not pass: ${dryRunFailureOf(report)}`));
  } else if (
    !live &&
    "result" in recording &&
    !isDeepStrictEqual(report.moduleResult, recording.result)
  ) {
    problems.push(
      say(
        `its result disagrees with the recording's: it answered ${describeBody({ json: report.moduleResult })}, the recording holds ${describeBody({ json: recording.result })}`,
      ),
    );
  }
  return finish();
}
