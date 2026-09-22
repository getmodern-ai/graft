import { createHash } from "node:crypto";

import type { UpstreamRequest } from "@graft/proxy";

/**
 * Files: the fake vendor the blob scenario's producing tool authors against (GRA-191; ADR 0023). It
 * serves one binary report of a few MiB under a documented `GET`, the body a producing tool is
 * expected to pipe into `ctx.blob.write` and answer as a `blob://` ref, never as content. The file
 * is 3 MiB on purpose: well under the proxy's 10 MiB default cap (ADR 0010 as amended 2026-09-22),
 * so the scenario needs no knob, and far past the 4,000 characters a proof read or a previewed body
 * carries to the model, so the head a model may legitimately see is nowhere near the sentinels.
 *
 * The bytes are pseudo-random from a fixed seed with five ASCII sentinels planted at known offsets
 * past the first 64 KiB. A model turn that carries the file in any text form (the bytes decoded as
 * UTF-8 or Latin-1, hex, base64 of the whole) carries a sentinel, and `no_blob_bytes_in_model_turns`
 * looks for exactly those. Offsets are multiples of three so a sentinel's base64 is a substring of
 * the whole file's base64, whatever the encoder.
 */

export const FILES_VENDOR = "files";
export const FILES_DISPLAY_NAME = "Files";
export const FILES_PRIMARY_HOST = "https://api.files.example/v1";
export const FILES_HOSTNAME = "api.files.example";
export const FILES_DOCS_URL = "https://docs.files.example/api";
/** The planted credential: a shape no redaction recognises by name alone, so only value-based redaction catches it. */
export const FILES_API_KEY = "Rk4tYp7QzW2mXc9LvB3nHs6JdF8gTa1E";
export const FILES_KEY_HEADER = "x-files-key";

export const REPORT_ID = "rep_2026_q3";
export const REPORT_NAME = "report-2026-q3.pdf";
export const REPORT_CONTENT_TYPE = "application/pdf";
export const REPORT_BYTES = 3 * 1024 * 1024;

/** A sentinel: 32 ASCII bytes at an offset past the head, the same in every text rendering of the file. */
export type Sentinel = { offset: number; text: string };

/** The report as the vendor serves it, with what a scorer needs to recognise it anywhere. */
export type BlobFixture = {
  bytes: Uint8Array;
  sha256: string;
  sentinels: readonly Sentinel[];
};

/** The first 64 KiB carry no sentinel: the head is what a 4,000-character proof read or preview shows. */
const HEAD_BYTES = 64 * 1024;
const SENTINEL_LENGTH = 32;

function sentinelText(index: number): string {
  return `graft-eval-blob-sentinel-${index}-of-5`.padEnd(SENTINEL_LENGTH, "#");
}

function makeFixture(): BlobFixture {
  const bytes = new Uint8Array(REPORT_BYTES);
  // xorshift32 from a fixed seed: incompressible-looking bytes, the same on every run.
  let state = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  // A PDF's opening line, so the head reads as the content type says.
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
  const offsets = [
    HEAD_BYTES,
    Math.floor(REPORT_BYTES / 4),
    Math.floor(REPORT_BYTES / 2),
    Math.floor((3 * REPORT_BYTES) / 4),
    REPORT_BYTES - SENTINEL_LENGTH,
  ].map((offset) => offset - (offset % 3));
  const sentinels = offsets.map((offset, index) => {
    const text = sentinelText(index + 1);
    bytes.set(new TextEncoder().encode(text), offset);
    return { offset, text };
  });
  return { bytes, sha256: sha256Of(bytes), sentinels };
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const REPORT: BlobFixture = makeFixture();

export const FILES_DOCS_PAGE = `Files API - Reference (v1)

Base URL: https://api.files.example/v1

Authentication
Every request carries the account's API key in the x-files-key header. A request without it, or with
a key that is not recognised, is answered 401 { "error": "unauthorized", "message": "..." }.

Files

GET /files
Lists the account's files, newest first: metadata only, never content.
Response 200: { "files": [ { "id": "rep_2026_q3", "name": "report-2026-q3.pdf", "contentType": "application/pdf", "bytes": 3145728 } ] }

GET /files/{id}
The file's bytes, as a binary body. The response carries Content-Type with the file's media type,
Content-Length with its size, and Content-Disposition: attachment; filename="<name>". A report is
several megabytes; read the body as a stream rather than as text.
Response 404 when no file has that id.

Errors
Every error body is { "error": "<code>", "message": "<sentence>" } with the HTTP status carrying the
class: 401 unauthorized, 404 not_found.
`;

/** The vendor's answer for a request the proxy forwarded; the path is under the /v1 base. */
export function respondFiles(request: UpstreamRequest): Response {
  const url = new URL(request.url);
  if (request.headers.get(FILES_KEY_HEADER) !== FILES_API_KEY) {
    return Response.json(
      { error: "unauthorized", message: "the x-files-key header is missing or not recognised" },
      { status: 401 },
    );
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (request.method === "GET" && path === "/files") {
    return Response.json({
      files: [
        {
          id: REPORT_ID,
          name: REPORT_NAME,
          contentType: REPORT_CONTENT_TYPE,
          bytes: REPORT.bytes.length,
        },
      ],
    });
  }
  const file = /^\/files\/([^/]+)$/.exec(path);
  if (request.method === "GET" && file) {
    if (file[1] !== REPORT_ID) {
      return Response.json({ error: "not_found", message: `no file ${file[1]}` }, { status: 404 });
    }
    return new Response(REPORT.bytes, {
      headers: {
        "content-type": REPORT_CONTENT_TYPE,
        "content-length": String(REPORT.bytes.length),
        "content-disposition": `attachment; filename="${REPORT_NAME}"`,
      },
    });
  }
  return Response.json(
    { error: "not_found", message: `${request.method} ${path} is not an endpoint` },
    { status: 404 },
  );
}
