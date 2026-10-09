import { randomBytes } from "node:crypto";

import { redactText, secretFieldNamesFor } from "@graft/core";
import {
  CREDENTIAL_REDACTED,
  createUpstreamFetch,
  isSafeMethod,
  type UpstreamFetch,
  type UpstreamRequest,
} from "@graft/proxy";

import { dryRunFailureOf, dryRunStockTool, stockConnectionFor } from "./dry-run";
import type { LiveConnection } from "./mode";
import {
  RECORDED_RESPONSE_HEADERS,
  RECORDING_FORMAT,
  type RecordedExchange,
  type RecordedRead,
  recordedBodyOf,
  redactRecording,
  replayResponseOf,
  type StockRecording,
} from "./recording";
import { keptLiteralsOf, scrubRecording, survivingValuesOf } from "./scrub";
import type { StockWorkspaceTool } from "./workspace";

/**
 * The build command's recording (GRA-246; `RECORDING.md`): one dry run of the built module with its
 * test input, by the real runner through the real proxy, over the maintainer's connection to the
 * real vendor (or a suite's `upstreamFetch`), with every read the proxy sent on recorded beside the
 * vendor's answer and every write the proxy stopped recorded from its preview. The same dry run the
 * harness replays, so what is recorded is what `proveReplay` will ask for.
 *
 * Nothing leaves here unscrubbed or unredacted (`RECORDING.md`, *The scrub* and *Redaction*). The
 * first dry run's answers and its input go through `scrubRecording` under a fresh random seed; the
 * module then runs a second time, as a dry run whose vendor is those scrubbed answers in order, and
 * the requests it makes and the result it answers there are the ones recorded, so a request naming
 * an id from an earlier answer, or a result the module computed, is the scrubbed data's and the
 * harness's replay matches by construction. `survivingValuesOf` is the last check, and the whole
 * goes through `redactRecording` with the connection's credential values and its scheme's field
 * names; so do the sentences, which can quote a vendor's answer, though never a surviving value.
 */

/**
 * The proxy's own echo redaction (`@graft/proxy`'s `echo.ts`), mirrored onto what is recorded: a
 * vendor that echoes the credential has it replaced by `CREDENTIAL_REDACTED` before the module sees
 * the answer, so the recording holds the answer as the module saw it, and the replay hands the
 * module the same text and gets the same result. Values shorter than the proxy's floor are left to
 * `redactRecording`, as the proxy leaves them.
 */
const MIN_ECHO_LENGTH = 8;

function echoRedacted(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join(CREDENTIAL_REDACTED), text);
}

function echoRedactedBytes(bytes: Uint8Array, secrets: readonly string[]): Uint8Array {
  if (secrets.length === 0) return bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Binary: the proxy passes it untouched, and so does the recording; `redactRecording` judges it.
    return bytes;
  }
  return new TextEncoder().encode(echoRedacted(text, secrets));
}

export type RecordProofResult =
  | { ok: true; recording: StockRecording }
  | { ok: false; problems: string[] };

export async function recordStockProof(
  tool: StockWorkspaceTool,
  options: {
    /** The maintainer's connection; null for a keyless starter. */
    connection: LiveConnection | null;
    /** The vendor; the proxy's own guarded fetch when absent. */
    upstreamFetch?: UpstreamFetch;
    now?: () => Date;
    /** The scrub's seed; a fresh random one by default, which is what the build command uses. */
    seed?: string;
  },
): Promise<RecordProofResult> {
  const wire = `${tool.vendor}__${tool.name}`;
  const credential = options.connection?.credential ?? {};
  const rule = {
    secretValues: Object.values(credential).filter((value) => value.length > 0),
    secretFieldNames: options.connection
      ? secretFieldNamesFor(options.connection.scheme, options.connection.schemeConfig)
      : [],
  };
  const problems: string[] = [];
  const fail = (): RecordProofResult => ({
    ok: false,
    problems: problems.map((problem) => redactText(`stock tool ${wire}: ${problem}`, rule).text),
  });

  const connection = stockConnectionFor(tool, options.connection, true);
  if (typeof connection === "string") {
    problems.push(connection);
    return fail();
  }

  const exchanges: RecordedExchange[] = [];
  const echoable = rule.secretValues.filter((value) => value.length >= MIN_ECHO_LENGTH);
  const vendor = options.upstreamFetch ?? createUpstreamFetch();
  const upstreamFetch: UpstreamFetch = async (request: UpstreamRequest, init) => {
    const method = request.method.toUpperCase();
    if (!isSafeMethod(method)) {
      // The token carries the dry-run claim, so the proxy previews every write; one that reached
      // here would be a proxy that let it leave, and nothing is sent.
      problems.push(`a ${method} reached the vendor in a dry run`);
      return Response.json({ error: "write_reached_vendor" }, { status: 500 });
    }
    const response = await vendor(request, init);
    // Read whole to record it, and handed on to the proxy as the same bytes.
    const bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
    const headers: Record<string, string> = {};
    for (const name of RECORDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = echoRedacted(value, echoable);
    }
    const body = recordedBodyOf(echoRedactedBytes(bytes, echoable));
    exchanges.push({
      kind: "read",
      method: method as "GET" | "HEAD",
      url: request.url,
      response: { status: response.status, headers, ...(body ? { body } : {}) },
    });
    const nullBody = method === "HEAD" || [204, 205, 304].includes(response.status);
    // Field by field: a `Response`'s fields are getters, which a spread does not copy.
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: nullBody ? null : new Response(bytes).body,
    };
  };

  const run = await dryRunStockTool({
    tool,
    connection,
    credential,
    upstreamFetch,
    onPreview: (write) => {
      exchanges.push({
        kind: "write",
        method: write.method,
        url: `https://${write.host}${write.path}`,
        ...(write.body ? { body: write.body } : {}),
      });
    },
  });
  if (!run.ran) {
    problems.push(
      `the module did not run (exit ${run.code}): ${run.stderr.trim().slice(-500) || "no output"}`,
    );
    return fail();
  }
  if (!run.report.passed) problems.push(`its dry run did not pass: ${dryRunFailureOf(run.report)}`);
  if (problems.length > 0) return fail();

  const raw: StockRecording = {
    format: RECORDING_FORMAT,
    tool: wire,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    input: tool.testInput as Record<string, unknown>,
    exchanges,
    ...(run.report.moduleResult === undefined ? {} : { result: run.report.moduleResult }),
  };

  // The scrub: the answers and the input, then the module again over them.
  const keep = keptLiteralsOf(tool.files, tool.inputSchema);
  const scrubbed = scrubRecording(raw, {
    seed: options.seed ?? randomBytes(16).toString("hex"),
    keep,
  });
  const answers = scrubbed.exchanges.filter(
    (exchange): exchange is RecordedRead => exchange.kind === "read",
  );
  const again: RecordedExchange[] = [];
  const readsAgain = () => again.filter((exchange) => exchange.kind === "read").length;
  const rerun = await dryRunStockTool({
    tool: { ...tool, testInput: scrubbed.input },
    connection,
    credential,
    upstreamFetch: async (request: UpstreamRequest) => {
      const method = request.method.toUpperCase();
      const answer = answers[readsAgain()];
      if (!isSafeMethod(method) || !answer) {
        problems.push(
          `over the scrubbed answers it made a call the first run did not: ${method} ${new URL(request.url).hostname}`,
        );
        return Response.json({ error: "not_in_recording" }, { status: 404 });
      }
      again.push({ ...answer, method: method as "GET" | "HEAD", url: request.url });
      return replayResponseOf(answer);
    },
    onPreview: (write) => {
      again.push({
        kind: "write",
        method: write.method,
        url: `https://${write.host}${write.path}`,
        ...(write.body ? { body: write.body } : {}),
      });
    },
  });
  if (!rerun.ran) {
    problems.push(
      `over the scrubbed answers the module did not run (exit ${rerun.code}): ${rerun.stderr.trim().slice(-500) || "no output"}`,
    );
    return fail();
  }
  if (!rerun.report.passed) {
    problems.push(
      `over the scrubbed answers its dry run did not pass: ${dryRunFailureOf(rerun.report)}`,
    );
  } else if (readsAgain() !== answers.length) {
    problems.push(
      `over the scrubbed answers it made ${readsAgain()} read(s), the first run ${answers.length}; a module that branches on a vendor's value can name the value as a literal, which the scrub keeps`,
    );
  }
  if (problems.length > 0) return fail();

  const { result: _scrubbedResult, ...rest } = scrubbed;
  const recording: StockRecording = {
    ...rest,
    exchanges: again,
    ...(rerun.report.moduleResult === undefined ? {} : { result: rerun.report.moduleResult }),
  };
  const survived = survivingValuesOf(raw, recording, {
    source: tool.files.map((file) => file.content).join("\n"),
    keep,
  });
  if (survived.length > 0) {
    problems.push(
      `a value from the vendor's answers survived the scrub in its recording's ${survived.join(", ")}; nothing was recorded`,
    );
    return fail();
  }
  return { ok: true, recording: redactRecording(recording, rule).recording };
}
