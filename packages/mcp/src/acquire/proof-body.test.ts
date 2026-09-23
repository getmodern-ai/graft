import { describe, expect, it } from "vitest";

import { looksBinary, mediaTypeOf, recordableProofBody } from "./proof-body";

/**
 * A proof read's body is recorded as text only when it is text (GRA-201). The ZIP head is the shape
 * production's job 2cebd675 recorded off Google Drive's `alt=media` on 2026-09-23: `PK` and two
 * control characters, then NULs, which Postgres refuses inside jsonb.
 */

const ZIP_HEAD =
  "PK\u0003\u0004\u0014\u0000\b\b\b\u0000\u001D6]\u0000\u0000\u0000\u0000xl/drawings/drawing1.xml\uFFFD\uFFFD]n\uFFFD0";
const JSON_BODY = '{"items":[{"id":"itm_1","name":"Widget"}],"next":null}';
const SENTENCE_TAIL =
  "A tool that needs the bytes moves them with ctx.blob.write, never through its result.";

describe("mediaTypeOf", () => {
  it("drops the parameters and lowercases, and answers null for none", () => {
    expect(mediaTypeOf("Application/JSON; charset=utf-8")).toBe("application/json");
    expect(mediaTypeOf("application/zip")).toBe("application/zip");
    expect(mediaTypeOf("")).toBeNull();
    expect(mediaTypeOf(null)).toBeNull();
  });
});

describe("looksBinary", () => {
  it("is true on a NUL anywhere and on a run of control or replacement characters", () => {
    expect(looksBinary(ZIP_HEAD)).toBe(true);
    expect(looksBinary(`${JSON_BODY.repeat(40)}\u0000`)).toBe(true);
    expect(looksBinary("\uFFFD\uFFFD\uFFFD\uFFFDabcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  it("is false on text, tabs and newlines included, and on an empty body", () => {
    expect(looksBinary(JSON_BODY)).toBe(false);
    expect(looksBinary("line one\n\tline two\r\n<xml/>")).toBe(false);
    expect(looksBinary("")).toBe(false);
  });
});

describe("recordableProofBody", () => {
  it("keeps a text body as it was, whatever the declared type", () => {
    for (const contentType of [
      "application/json",
      "text/plain",
      "application/octet-stream",
      null,
    ]) {
      expect(
        recordableProofBody({ body: JSON_BODY, contentType, contentLength: null, length: 55 }),
      ).toBe(JSON_BODY);
    }
  });

  it("replaces a binary body with a sentence naming the type and the declared size, and no NUL survives", () => {
    const recorded = recordableProofBody({
      body: ZIP_HEAD,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentLength: "2434444",
      length: 2_434_444,
    });
    expect(recorded).toBe(
      `The body is not text and is not shown: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 2,434,444 bytes. ${SENTENCE_TAIL}`,
    );
    expect(recorded).not.toContain("\u0000");
  });

  it("judges by the declared type alone when the head happens to read as text", () => {
    // A PDF opens in ASCII; its streams, further in, do not.
    expect(
      recordableProofBody({
        body: "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n",
        contentType: "application/pdf; charset=binary",
        contentLength: null,
        length: 48_213,
      }),
    ).toBe(
      `The body is not text and is not shown: application/pdf, 48,213 characters read, length undeclared. ${SENTENCE_TAIL}`,
    );
  });

  it("judges an undeclared octet-stream by its content: a ZIP under it is binary, JSON under it is text", () => {
    expect(
      recordableProofBody({
        body: ZIP_HEAD,
        contentType: "application/octet-stream",
        contentLength: "2048",
        length: 2_048,
      }),
    ).toBe(
      `The body is not text and is not shown: application/octet-stream, 2,048 bytes. ${SENTENCE_TAIL}`,
    );
  });

  it("names no content-type and no length when the vendor sent neither", () => {
    expect(
      recordableProofBody({ body: ZIP_HEAD, contentType: null, contentLength: null, length: null }),
    ).toBe(
      `The body is not text and is not shown: no content-type, length undeclared. ${SENTENCE_TAIL}`,
    );
  });

  it("answers null for no body", () => {
    expect(
      recordableProofBody({
        body: null,
        contentType: "application/zip",
        contentLength: "9",
        length: null,
      }),
    ).toBeNull();
  });
});
