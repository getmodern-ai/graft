import { GENERIC_SECRET_FIELD_NAMES, REDACTED, type RedactionRule, redactValue } from "@graft/core";

/**
 * A stock tool's recording (ADR 0025; GRA-240): `recording.json` beside its module, what the tool's
 * proof saw when it was built, so the harness can replay it on every pull request with no vendor
 * reached and no secret held. `RECORDING.md` beside the workspace is the format's documentation for
 * the build command (GRA-246), which writes one through `redactRecording`, and for a reviewer.
 *
 * The recording is not part of the tool: `readStockWorkspace` leaves it out of the module's files
 * and out of the source hash, so re-recording a tool appends no catalogue version.
 */

export const RECORDING_FILE = "recording.json";
export const RECORDING_FORMAT = 1;

/**
 * The response headers a recording keeps; every other is dropped by `recordedResponseOf`. The media
 * type a module reads the body by, where a redirect points, and the pagination link a list follows.
 */
export const RECORDED_RESPONSE_HEADERS: readonly string[] = ["content-type", "location", "link"];

/** A body: JSON when it parses as JSON, UTF-8 text when it decodes, base64 otherwise. */
export type RecordedBody = { json: unknown } | { text: string } | { base64: string };

export type RecordedResponse = {
  status: number;
  /** Lower-case names, `RECORDED_RESPONSE_HEADERS` only. */
  headers: Record<string, string>;
  body?: RecordedBody;
};

/** A `GET` or `HEAD` the vendor answered: replayed from `response`. */
export type RecordedRead = {
  kind: "read";
  method: "GET" | "HEAD";
  /** The vendor URL as it left the proxy, query included, redacted. */
  url: string;
  response: RecordedResponse;
};

/** Any other method: stopped at the proxy's dry-run preview, so there is no vendor response. */
export type RecordedWrite = {
  kind: "write";
  method: string;
  url: string;
  /** What the module sent, as the preview carried it. Absent for a write with no body. */
  body?: RecordedBody;
};

export type RecordedExchange = RecordedRead | RecordedWrite;

export type StockRecording = {
  format: typeof RECORDING_FORMAT;
  /** The tool's wire name, `<vendor>__<name>`. */
  tool: string;
  /** ISO 8601. */
  recordedAt: string;
  /** The input the proof ran with: the tool's `test-input.json`. */
  input: Record<string, unknown>;
  /** Every call the module made through the proxy, in order. */
  exchanges: RecordedExchange[];
  /** The module's result in that run, compared whole on a replay. Absent: not compared. */
  result?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "must be an object";
  const keys = Object.keys(value);
  if (keys.length !== 1) return "must carry exactly one of json, text or base64";
  if ("json" in value) return null;
  if ("text" in value) return typeof value.text === "string" ? null : "text must be a string";
  if ("base64" in value) return typeof value.base64 === "string" ? null : "base64 must be a string";
  return "must carry exactly one of json, text or base64";
}

/**
 * The recording at `where` (a path a reader can open), or a throw whose sentence names it and the
 * first thing wrong. The harness turns the throw into the tool's failure sentence.
 */
export function parseRecording(text: string, where: string): StockRecording {
  const problem = (cause: string) => new Error(`${where} ${cause}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw problem(`is not JSON: ${String(error)}`);
  }
  if (!isRecord(value)) throw problem("must be a JSON object");
  if (value.format !== RECORDING_FORMAT) {
    throw problem(
      `has format ${JSON.stringify(value.format)}; this harness reads ${RECORDING_FORMAT}`,
    );
  }
  if (typeof value.tool !== "string") throw problem("must name its tool");
  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    throw problem("must carry recordedAt, an ISO 8601 time");
  }
  if (!isRecord(value.input)) throw problem("must carry input, a JSON object");
  if (!Array.isArray(value.exchanges)) throw problem("must carry exchanges, a list");
  value.exchanges.forEach((exchange: unknown, index) => {
    const at = `exchange ${index + 1}`;
    if (!isRecord(exchange)) throw problem(`${at} must be an object`);
    if (typeof exchange.method !== "string" || typeof exchange.url !== "string") {
      throw problem(`${at} must carry method and url`);
    }
    try {
      new URL(exchange.url);
    } catch {
      throw problem(`${at}'s url is not an absolute URL`);
    }
    if (exchange.kind === "read") {
      if (exchange.method !== "GET" && exchange.method !== "HEAD") {
        throw problem(`${at} is a read, so its method is GET or HEAD`);
      }
      const response = exchange.response;
      if (!isRecord(response) || typeof response.status !== "number") {
        throw problem(`${at} must carry response with a status`);
      }
      if (!isRecord(response.headers)) throw problem(`${at}'s response must carry headers`);
      const body = bodyProblem(response.body);
      if (body) throw problem(`${at}'s response body ${body}`);
    } else if (exchange.kind === "write") {
      if (exchange.method === "GET" || exchange.method === "HEAD") {
        throw problem(`${at} is a write, so its method is not GET or HEAD`);
      }
      const body = bodyProblem(exchange.body);
      if (body) throw problem(`${at}'s body ${body}`);
    } else {
      throw problem(`${at}'s kind must be read or write`);
    }
  });
  return value as StockRecording;
}

/** The body as a recording carries it. */
export function recordedBodyOf(bytes: Uint8Array): RecordedBody | undefined {
  if (bytes.byteLength === 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { base64: Buffer.from(bytes).toString("base64") };
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { text };
  }
}

/** A vendor's response as a recording carries it: the status, the kept headers, the body. */
export async function recordedResponseOf(response: Response): Promise<RecordedResponse> {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const body = recordedBodyOf(new Uint8Array(await response.arrayBuffer()));
  return { status: response.status, headers, ...(body ? { body } : {}) };
}

/** The bytes a recorded body stands for, and the media type to answer it with when none was kept. */
export function bodyBytesOf(body: RecordedBody | undefined): {
  bytes: Uint8Array;
  contentType: string | null;
} {
  if (!body) return { bytes: new Uint8Array(0), contentType: null };
  if ("json" in body) {
    return {
      bytes: new TextEncoder().encode(JSON.stringify(body.json)),
      contentType: "application/json",
    };
  }
  if ("text" in body)
    return { bytes: new TextEncoder().encode(body.text), contentType: "text/plain" };
  return { bytes: Buffer.from(body.base64, "base64"), contentType: "application/octet-stream" };
}

/** The vendor's answer to a read, as a replay hands it to the proxy. */
export function replayResponseOf(read: RecordedRead): Response {
  const { bytes, contentType } = bodyBytesOf(read.response.body);
  const headers = new Headers(read.response.headers);
  if (!headers.has("content-type") && contentType) headers.set("content-type", contentType);
  const nullBody = read.method === "HEAD" || [204, 205, 304].includes(read.response.status);
  return new Response(nullBody ? null : bytes, { status: read.response.status, headers });
}

/**
 * Redact a recording before it is written, as the acquire trace is redacted (`@graft/core`'s
 * `redactValue`): **by value** for every value in `rule.secretValues` (the connection's credential
 * fields, which the build command holds), then by shape (bearer and basic credentials, JWTs, the
 * well-known key shapes) and by field name inside a string (`token=…` in a query). On top of that,
 * a JSON property whose key is a secret field name (the generic set and `rule.secretFieldNames`) has
 * its string value replaced, since a parsed body has no `name: value` text for the shape pass to
 * read. Keys are kept, so a reader sees which field held a secret.
 *
 * A committed recording is a fixed point of this function with no rule: the harness fails a tool
 * whose recording still holds anything credential-shaped.
 */
export function redactRecording(
  recording: StockRecording,
  rule: RedactionRule = {},
): { recording: StockRecording; redacted: boolean } {
  const names = new Set(
    [...GENERIC_SECRET_FIELD_NAMES, ...(rule.secretFieldNames ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  );
  let byKey = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([key, entry]) => {
          if (
            typeof entry === "string" &&
            names.has(key.toLowerCase()) &&
            !entry.startsWith("[redacted")
          ) {
            byKey = true;
            return [key, REDACTED];
          }
          return [key, walk(entry)];
        }),
      );
    }
    return node;
  };
  const keyed = walk(recording) as StockRecording;
  const { value, redacted } = redactValue(keyed, rule);
  return { recording: value, redacted: redacted || byKey };
}

/** How a recording is written: two-space JSON and a final newline, so a diff reads line by line. */
export function formatRecording(recording: StockRecording): string {
  return `${JSON.stringify(recording, null, 2)}\n`;
}
