/**
 * What a proof read's body is recorded as (GRA-201).
 *
 * The probe slices the first `PROOF_BODY_CHARS` of the response as text, whatever the vendor sent.
 * Read that way, a workbook, a PDF or a ZIP is a run of NULs and replacement characters: it tells the
 * model nothing about the vendor's shape, and Postgres refuses it in a `jsonb` column (SQLSTATE
 * 22P05: no U+0000 inside a JSON string), which on 2026-09-23 ended a production job as `job_failed`
 * with the statement as its message. So a body that is not text is recorded as one sentence naming
 * the media type and the size, in the trace, the prompt and the job's diagnostics alike — they all
 * read the same `ProofRead` — and the bytes stay in the sandbox. `ok` and `status` are untouched:
 * a 200 proves the path whatever the body is.
 *
 * Two judges, either of which decides. The declared type, when it is one of the families that is
 * never text; and the content, when it carries a NUL or a run of control and replacement characters.
 * `application/octet-stream` is on neither list on purpose: it is the type a vendor declares when it
 * has not decided, JSON included, so its content decides.
 */

/** Media type families no proof read shows: the bytes are never a vendor's shape. */
const BINARY_TYPE =
  /^(image|audio|video|font)\/|^application\/(zip|gzip|x-gzip|x-tar|x-bzip2|x-7z-compressed|pdf|vnd\.)/i;

/** How much of the body the content judge reads; the head of a binary body settles it. */
const SAMPLE_CHARS = 1_000;
/** The share of control and replacement characters past which a sample is not text. */
const BINARY_SHARE = 0.1;

const NUL = "\u0000";

/** A control character other than tab, newline and carriage return; DEL; or the replacement character. */
function isNonTextCode(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  return code === 0x7f || code === 0xfffd;
}

/** The type without its parameters: `application/zip; charset=binary` is judged as `application/zip`. */
export function mediaTypeOf(contentType: string | null | undefined): string | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type ? type : null;
}

/** Whether the text read off the response is not text at all. */
export function looksBinary(body: string): boolean {
  if (body.includes(NUL)) return true;
  const sample = body.slice(0, SAMPLE_CHARS);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (isNonTextCode(sample.charCodeAt(i))) nonText += 1;
  }
  return nonText / sample.length >= BINARY_SHARE;
}

export type ProofBodyInput = {
  /** The first `PROOF_BODY_CHARS` of the response as the probe read them; null when it answered none. */
  body: string | null;
  /** The response's `content-type`, as the probe read it. */
  contentType: string | null;
  /** The response's `content-length`, when the vendor sent one. */
  contentLength: string | null;
  /** How many characters the probe read in all, before the slice. */
  length: number | null;
};

/**
 * The body as the record keeps it: the text as it was for a text body, the sentence for a binary
 * one. The sentence says what a tool that needs the bytes does instead of reading them here.
 */
export function recordableProofBody(input: ProofBodyInput): string | null {
  if (input.body === null) return null;
  const type = mediaTypeOf(input.contentType);
  const binary = (type !== null && BINARY_TYPE.test(type)) || looksBinary(input.body);
  if (!binary) return input.body;
  const size = describeSize(input.contentLength, input.length);
  return `The body is not text and is not shown: ${type ?? "no content-type"}, ${size}. A tool that needs the bytes moves them with ctx.blob.write, never through its result.`;
}

function describeSize(contentLength: string | null, length: number | null): string {
  const declared = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared >= 0) {
    return `${declared.toLocaleString("en-US")} bytes`;
  }
  if (length !== null && Number.isFinite(length) && length >= 0) {
    return `${length.toLocaleString("en-US")} characters read, length undeclared`;
  }
  return "length undeclared";
}
