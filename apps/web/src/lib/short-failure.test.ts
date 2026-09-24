import { describe, expect, it } from "vitest";

import { FAILURE_DETAILS_MAX, isHtmlBody, runFailure, shortFailure } from "./short-failure";

/** Google's 404 page, shaped as the walk of 2026-09-25 printed it. */
const GOOGLE_404 = `<!DOCTYPE html>
<html lang=en>
  <meta charset=utf-8>
  <title>Error 404 (Not Found)!!1</title>
  <style>*{margin:0;padding:0}html,code{font:15px/22px arial,sans-serif}${"x".repeat(900)}</style>
  <p><b>404.</b> <ins>That's an error.</ins>
  <p>The requested URL <code>/v4/spreadsheets/abc/values/A1</code> was not found on this server.
</html>`;

describe("shortFailure", () => {
  it("summarises an HTML page, with the status its words name, and trims the raw text for Details", () => {
    const failure = shortFailure(`Google Sheets answered 404: ${GOOGLE_404}`);
    expect(failure.sentence).toBe(
      "The integration answered with a web page instead of data (status 404).",
    );
    expect(failure.details?.startsWith("Google Sheets answered 404: <!DOCTYPE html>")).toBe(true);
    expect(failure.details).toHaveLength(FAILURE_DETAILS_MAX);
    expect(failure.details?.endsWith("…")).toBe(true);
  });

  it("reads the status off the page's title, or takes the one it is given, or says none", () => {
    expect(shortFailure(GOOGLE_404).sentence).toBe(
      "The integration answered with a web page instead of data (status 404).",
    );
    expect(shortFailure("<html><body>Bad gateway</body></html>", { status: 502 }).sentence).toBe(
      "The integration answered with a web page instead of data (status 502).",
    );
    expect(shortFailure("<html><body>Sign in</body></html>").sentence).toBe(
      "The integration answered with a web page instead of data.",
    );
  });

  it("knows a page by its start, its doctype anywhere, or its closing tag", () => {
    expect(isHtmlBody("<!doctype html><p>hi")).toBe(true);
    expect(isHtmlBody("<HTML>")).toBe(true);
    expect(isHtmlBody("…the tail of a page</html>")).toBe(true);
    expect(isHtmlBody("The input <city> is required")).toBe(false);
    expect(isHtmlBody('{"error":"not_authed"}')).toBe(false);
  });

  it("keeps a short refusal as it is, with nothing more behind Details", () => {
    expect(shortFailure("The tool's input does not match its schema: city is required.")).toEqual({
      sentence: "The tool's input does not match its schema: city is required.",
      details: null,
    });
    expect(shortFailure("fetch failed")).toEqual({ sentence: "fetch failed.", details: null });
  });

  it("takes the first line, drops a leading Error:, and keeps the rest behind Details", () => {
    const failure = shortFailure(
      "TypeError: Cannot read properties of undefined (reading 'files')\n    at default (/tools/drive/index.mjs:12:20)\n    at run (/graft/runner.mjs:88:5)",
    );
    expect(failure.sentence).toBe("Cannot read properties of undefined (reading 'files').");
    expect(failure.details).toContain("at default (/tools/drive/index.mjs:12:20)");
  });

  it("cuts a long first line at its first sentence, or with an ellipsis", () => {
    const long = `Slack answered not_authed. ${"The token was refused by the workspace. ".repeat(10)}`;
    expect(shortFailure(long).sentence).toBe("Slack answered not_authed.");
    const unbroken = shortFailure(`Failed ${"x".repeat(400)}`).sentence;
    expect(unbroken.length).toBeLessThanOrEqual(200);
    expect(unbroken.endsWith("…")).toBe(true);
  });

  it("puts a run's stderr tail behind Details beside its sentence (runFailure)", () => {
    expect(
      runFailure({
        message: "The tool threw: Drive answered 403.",
        answer: {
          error: "The tool threw: Drive answered 403.",
          stderrTail: "at list (index.mjs:4)",
        },
      }),
    ).toEqual({
      sentence: "The tool threw: Drive answered 403.",
      details: "The tool threw: Drive answered 403.\n\nat list (index.mjs:4)",
    });
    expect(
      runFailure({ message: "<!DOCTYPE html><html></html>", answer: { status: 404 } }).sentence,
    ).toBe("The integration answered with a web page instead of data (status 404).");
    expect(runFailure({ message: "Refused: input_invalid" })).toEqual({
      sentence: "Refused: input_invalid.",
      details: null,
    });
  });

  it("falls back to a sentence of its own for nothing", () => {
    expect(shortFailure("")).toEqual({ sentence: "The tool did not answer.", details: null });
    expect(shortFailure(null, { fallback: "The job failed." })).toEqual({
      sentence: "The job failed.",
      details: null,
    });
  });
});
