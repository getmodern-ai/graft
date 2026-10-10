import { randomBytes } from "node:crypto";

import { redactText, secretFieldNamesFor } from "@graft/core";
import {
  CREDENTIAL_REDACTED,
  createUpstreamFetch,
  isSafeMethod,
  type UpstreamFetch,
  type UpstreamRequest,
} from "@graft/proxy";
import { echoableSecrets } from "@graft/proxy/echo";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import { dryRunFailureOf, dryRunStockTool, issueSequence, stockConnectionFor } from "./dry-run";
import type { LiveConnection } from "./mode";
import {
  bodyBytesOf,
  RECORDED_RESPONSE_HEADERS,
  RECORDING_FORMAT,
  type RecordedExchange,
  type RecordedRead,
  recordedBodyOf,
  redactRecording,
  replayResponseOf,
  type StockRecording,
} from "./recording";
import { keptLiteralsOf, ScrubFailure, scrubRecording, survivingValuesOf } from "./scrub";
import { credentialForms } from "./secrets";
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
 * harness's replay matches by construction. The whole goes through `redactRecording` with every
 * form of the connection's credential values (`secrets.ts`: encoded, base64, the basic pair, the
 * header values) and its scheme's field names, and `survivingValuesOf` judges what that leaves, the
 * last check; so do the sentences, which can quote a vendor's answer, though never a surviving value.
 *
 * **The exchanges are in the order the module issued them** (Greptile on #191): each takes its place
 * from the sequence the dry run's proxy door gave its request (`dry-run.ts`'s `issueSequence`), not
 * from when the vendor answered, so a module that reads with `Promise.all` records its reads in the
 * order the replay will see them arrive.
 *
 * **A JSON body is handed to the module as the recording will replay it** (Greptile on #191): parsed
 * so the redaction can walk it, and re-serialised (`bodyBytesOf`) before the proxy passes it on, so
 * the text the module reads while recording is the text the replay gives it. `RECORDING.md` says
 * what that asks of a stock module.
 */

/**
 * The proxy's own echo redaction (`@graft/proxy`'s `echo.ts`), mirrored onto what is recorded: a
 * vendor that echoes the credential (or the basic pair the header carries) has it replaced by
 * `CREDENTIAL_REDACTED` before the module sees the answer, so the recording holds the answer as the
 * module saw it, and the replay hands the module the same text and gets the same result. The values
 * are the proxy's own (`echoableSecrets`); every other form is left to `redactRecording`, as the
 * proxy leaves it.
 */
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

/**
 * Why an input fails the tool's schema, by the validator a run uses (`harness.ts`'s
 * `proveTestInput`, `@graft/mcp`'s `schema.ts`), or null where it passes. Ajv's sentence names the
 * path and the rule, not the value.
 */
function inputSchemaProblemOf(schema: unknown, input: unknown): string | null {
  try {
    const verdict = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType)(input);
    return verdict.valid ? null : (verdict.errorMessage ?? "invalid");
  } catch (error) {
    return `the schema does not compile: ${String(error)}`;
  }
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
    secretValues: credentialForms(credential),
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

  // Each exchange beside the sequence its request was issued in; sorted by it once the run is over.
  const exchanges: { sequence: number; exchange: RecordedExchange }[] = [];
  // Only for a request that reached here outside the door's context, which the dry run never sends.
  let unsequenced = Number.MAX_SAFE_INTEGER / 2;
  const echoable = echoableSecrets(credential, credential);
  const vendor = options.upstreamFetch ?? createUpstreamFetch();
  const upstreamFetch: UpstreamFetch = async (request: UpstreamRequest, init) => {
    // Taken before anything is awaited: the place is the request's, whenever the vendor answers.
    const sequence = issueSequence() ?? unsequenced++;
    const method = request.method.toUpperCase();
    if (!isSafeMethod(method)) {
      // The token carries the dry-run claim, so the proxy previews every write; one that reached
      // here would be a proxy that let it leave, and nothing is sent.
      problems.push(`a ${method} reached the vendor in a dry run`);
      return Response.json({ error: "write_reached_vendor" }, { status: 500 });
    }
    const response = await vendor(request, init);
    // Read whole to record it, and handed on to the proxy below.
    const bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
    const headers: Record<string, string> = {};
    for (const name of RECORDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = echoRedacted(value, echoable);
    }
    const body = recordedBodyOf(echoRedactedBytes(bytes, echoable));
    exchanges.push({
      sequence,
      exchange: {
        kind: "read",
        method: method as "GET" | "HEAD",
        url: request.url,
        response: { status: response.status, headers, ...(body ? { body } : {}) },
      },
    });
    const nullBody = method === "HEAD" || [204, 205, 304].includes(response.status);
    // A JSON body goes on as the replay will serve it; any other as the vendor's own bytes.
    const handed = body && "json" in body ? bodyBytesOf(body).bytes : bytes;
    const handedHeaders = new Headers(response.headers);
    if (handed !== bytes) handedHeaders.delete("content-length");
    // Field by field: a `Response`'s fields are getters, which a spread does not copy.
    return {
      status: response.status,
      statusText: response.statusText,
      headers: handedHeaders,
      body: nullBody ? null : new Response(handed).body,
    };
  };

  const run = await dryRunStockTool({
    tool,
    connection,
    credential,
    upstreamFetch,
    onPreview: (write) => {
      exchanges.push({
        sequence: write.sequence,
        exchange: {
          kind: "write",
          method: write.method,
          url: `https://${write.host}${write.path}`,
          ...(write.body ? { body: write.body } : {}),
        },
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

  const ordered = exchanges.sort((a, b) => a.sequence - b.sequence);
  const raw: StockRecording = {
    format: RECORDING_FORMAT,
    tool: wire,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    input: tool.testInput as Record<string, unknown>,
    exchanges: ordered.map(({ exchange }) => exchange),
    ...(run.report.moduleResult === undefined ? {} : { result: run.report.moduleResult }),
  };

  // The scrub: the answers and the input, then the module again over them.
  const keep = keptLiteralsOf(tool.files, tool.inputSchema);
  let scrubbed: StockRecording;
  try {
    scrubbed = scrubRecording(raw, {
      seed: options.seed ?? randomBytes(16).toString("hex"),
      keep,
      inputSchema: tool.inputSchema,
    });
  } catch (error) {
    // Where, never what: the sentence reaches the maintainer's terminal and the build's report.
    if (!(error instanceof ScrubFailure)) throw error;
    problems.push(`the scrub failed: ${error.message}; nothing was recorded`);
    return fail();
  }
  // The scrubbed input is the test input the build writes and the harness validates, so it must
  // still be one the tool takes (Greptile on #192).
  const inputProblem = inputSchemaProblemOf(tool.inputSchema, scrubbed.input);
  if (inputProblem !== null) {
    problems.push(
      `its scrubbed test input fails its input schema (${inputProblem}); nothing was recorded`,
    );
    return fail();
  }
  const answers = scrubbed.exchanges.filter(
    (exchange): exchange is RecordedRead => exchange.kind === "read",
  );
  // The scrubbed answer for each request, by the sequence its request was issued in on the first
  // run: the module issues its requests in the same order over the scrubbed answers, so a
  // `Promise.all` module is answered each read's own answer whichever the proxy reaches first.
  const answerBySequence = new Map<number, RecordedRead>();
  ordered.forEach(({ sequence }, index) => {
    const exchange = scrubbed.exchanges[index];
    if (exchange?.kind === "read") answerBySequence.set(sequence, exchange);
  });
  const again: { sequence: number; exchange: RecordedExchange }[] = [];
  const readsAgain = () => again.filter(({ exchange }) => exchange.kind === "read").length;
  let unsequencedAgain = Number.MAX_SAFE_INTEGER / 2;
  const rerun = await dryRunStockTool({
    tool: { ...tool, testInput: scrubbed.input },
    connection,
    credential,
    upstreamFetch: async (request: UpstreamRequest) => {
      const sequence = issueSequence() ?? unsequencedAgain++;
      const method = request.method.toUpperCase();
      const answer = answerBySequence.get(sequence);
      if (!isSafeMethod(method) || !answer) {
        problems.push(
          `over the scrubbed answers it made a call the first run did not: ${method} ${new URL(request.url).hostname}`,
        );
        return Response.json({ error: "not_in_recording" }, { status: 404 });
      }
      again.push({
        sequence,
        exchange: { ...answer, method: method as "GET" | "HEAD", url: request.url },
      });
      return replayResponseOf(answer);
    },
    onPreview: (write) => {
      again.push({
        sequence: write.sequence,
        exchange: {
          kind: "write",
          method: write.method,
          url: `https://${write.host}${write.path}`,
          ...(write.body ? { body: write.body } : {}),
        },
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
    exchanges: again.sort((a, b) => a.sequence - b.sequence).map(({ exchange }) => exchange),
    ...(rerun.report.moduleResult === undefined ? {} : { result: rerun.report.moduleResult }),
  };
  // Redacted first, then judged: a credential the proxy put in a request URL, which a vendor may
  // quote back, is redaction's to take out (`secrets.ts`'s every form), not a vendor value the
  // scrub missed; what survives the redaction is.
  const redacted = redactRecording(recording, rule).recording;
  const survived = survivingValuesOf(raw, redacted, {
    source: tool.files.map((file) => file.content).join("\n"),
    keep,
  });
  if (survived.length > 0) {
    problems.push(
      `a value from the vendor's answers survived the scrub in its recording's ${survived.join(", ")}; nothing was recorded`,
    );
    return fail();
  }
  return { ok: true, recording: redacted };
}
