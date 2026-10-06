/**
 * A failure as Setup shows it (GRA-217): one sentence a person can read, with the raw text behind
 * *Details*, cut short. On the walk of 2026-09-25 a run against the wrong Google host printed the
 * whole of Google's HTML 404 page on the result step; the building step's failure reason had the
 * same shape. `shortFailure` is used by both.
 *
 * - An HTML body (the text starts with `<!DOCTYPE` or `<html`, or carries either or `</html>`
 *   anywhere, since a runner's error puts the body after its own words) becomes "The integration
 *   answered with a web page instead of data", with the status when the text or the page's title
 *   names one.
 * - Anything else is its first line, a leading `Error:` dropped, cut at the first sentence when
 *   that line runs long, and ended with a full stop.
 * - `details` is the raw text trimmed to `FAILURE_DETAILS_MAX` characters, or null when it says no
 *   more than the sentence.
 */

/** The most of the raw text *Details* shows. */
export const FAILURE_DETAILS_MAX = 500;

/** The longest sentence the failure shows before it is cut. */
export const FAILURE_SENTENCE_MAX = 200;

export type ShortFailure = { sentence: string; details: string | null };

const HTML_START = /<!doctype\s+html|<html[\s>]/i;
const HTML_END = /<\/html>/i;

/** Whether the text carries an HTML page. */
export function isHtmlBody(text: string): boolean {
  return HTML_START.test(text) || HTML_END.test(text);
}

/** The HTTP status the words before a page name, or the page's title does (`Error 404 (Not Found)`). */
function statusIn(text: string): number | null {
  const start = text.search(HTML_START);
  const words = start >= 0 ? text.slice(0, start) : text;
  const named =
    /\b(?:status(?:\s+code)?|http(?:\/[\d.]+)?|answered|returned|responded(?:\s+with)?|error)\s*:?\s*([1-5]\d\d)\b/i.exec(
      words,
    );
  if (named) return Number(named[1]);
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
  const inTitle = title ? /\b([45]\d\d)\b/.exec(title) : null;
  return inTitle ? Number(inTitle[1]) : null;
}

/** Text cut to `max` characters, an ellipsis marking the cut. */
export function trimmed(text: string, max = FAILURE_DETAILS_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function withStop(sentence: string): string {
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The sentence of a failure that is not a page: its first line, readable. */
function firstSentence(text: string): string {
  const line = (text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "").trim();
  const bare = line.replace(/^(?:uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error:\s*/, "");
  if (bare.length <= FAILURE_SENTENCE_MAX) return bare;
  const end = /[.!?](?=\s)/.exec(bare);
  if (end && end.index < FAILURE_SENTENCE_MAX) return bare.slice(0, end.index + 1);
  return trimmed(bare, FAILURE_SENTENCE_MAX);
}

export function shortFailure(
  raw: string | null | undefined,
  options: { status?: number | null; fallback?: string } = {},
): ShortFailure {
  const text = (raw ?? "").trim();
  const fallback = options.fallback ?? "The tool did not answer.";
  if (text === "") return { sentence: fallback, details: null };
  const details = trimmed(text, FAILURE_DETAILS_MAX);
  if (isHtmlBody(text)) {
    const status = options.status ?? statusIn(text);
    const sentence = `The integration answered with a web page instead of data${status ? ` (status ${status})` : ""}.`;
    return { sentence, details };
  }
  const sentence = withStop(firstSentence(text) || fallback);
  return { sentence, details: details === sentence || `${details}.` === sentence ? null : details };
}

/**
 * A run that did not answer (`AgentToolRunOutput` with `ok: false`) as the result step shows it:
 * the run's sentence made short, and behind *Details* that sentence with the runner's stderr tail
 * beside it when it says more.
 */
export function runFailure(output: {
  message: string;
  answer?: Record<string, unknown>;
}): ShortFailure {
  const tail = output.answer?.stderrTail;
  const extra =
    typeof tail === "string" && tail.trim() !== "" && !output.message.includes(tail.trim())
      ? `\n\n${tail.trim()}`
      : "";
  const status = typeof output.answer?.status === "number" ? output.answer.status : null;
  return shortFailure(`${output.message}${extra}`, { status });
}
