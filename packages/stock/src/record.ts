import { redactText, secretFieldNamesFor } from "@graft/core";
import {
  CREDENTIAL_REDACTED,
  createUpstreamFetch,
  isSafeMethod,
  type UpstreamFetch,
  type UpstreamRequest,
} from "@graft/proxy";
import { echoableSecrets } from "@graft/proxy/echo";

import { dryRunFailureOf, dryRunStockTool, issueSequence, stockConnectionFor } from "./dry-run";
import type { LiveConnection } from "./mode";
import {
  bodyBytesOf,
  RECORDED_RESPONSE_HEADERS,
  RECORDING_FORMAT,
  type RecordedExchange,
  recordedBodyOf,
  redactRecording,
  type StockRecording,
} from "./recording";
import { credentialForms } from "./secrets";
import type { StockWorkspaceTool } from "./workspace";

/**
 * The build command's recording (GRA-246; `RECORDING.md`): one dry run of the built module with its
 * test input, by the real runner through the real proxy, over the maintainer's connection to the
 * real vendor (or a suite's `upstreamFetch`), with every read the proxy sent on recorded beside the
 * vendor's answer and every write the proxy stopped recorded from its preview. The same dry run the
 * harness replays, so what is recorded is what `proveReplay` will ask for.
 *
 * Nothing leaves here unredacted: the recording goes through `redactRecording` with every form of
 * the connection's credential values (`secrets.ts`: encoded, base64, the basic pair, the header
 * values) and its scheme's field names, and so do the sentences, which can quote a vendor's answer.
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

  const recording: StockRecording = {
    format: RECORDING_FORMAT,
    tool: wire,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    input: tool.testInput as Record<string, unknown>,
    exchanges: exchanges.sort((a, b) => a.sequence - b.sequence).map(({ exchange }) => exchange),
    ...(run.report.moduleResult === undefined ? {} : { result: run.report.moduleResult }),
  };
  return { ok: true, recording: redactRecording(recording, rule).recording };
}
