import { type IndexedTool, queryWords, stem, termCoverage } from "./tool-index";

/**
 * Whether the toolbox already holds what an `acquire` goal asks for (GRA-154). Pure: no store.
 *
 * On 2026-09-21 an agent called `find_tool`, then `acquire` for "the five most recent emails in
 * the Gmail inbox" against a toolbox holding `list-recent-inbox-emails` and
 * `list-recent-inbox-messages`, and a third copy was built. `acquire` now ranks the vendor's live
 * tools against the goal before it opens a job, and a close match is answered instead of built.
 *
 * The rule: the goal's content words and a tool's — its name with hyphens read as spaces, plus its
 * description — with function words and the verbs every goal uses (retrieve, return, show, use)
 * dropped; two words agree when the word index's stemmer folds them together (`tool-index.ts`,
 * GRA-236: `reply`/`replies`, `create`/`created`), or one begins with the other and the shorter is
 * four characters or more (`email`/`emails`, `list`/`lists`). The goal is a sentence or two, not a
 * query, so it is scored by overlap rather than `find_tool`'s every-term rule. The score is the share of the union
 * that agrees, and a tool at or above `SIMILAR_THRESHOLD` is a candidate, best first, at most
 * `MAX_SIMILAR`. A goal that merely shares a vendor's vocabulary with a tool for a different job
 * — "find unreplied threads" against `find-invoices` — scores under it; the suite pins both sides
 * with the toolbox of that day. And a goal that writes (create, send, delete…) is never answered
 * with a read-only tool, nor a goal that reads with a tool that writes: "get a draft" and
 * "create a reply draft" share most of their words and are different jobs.
 *
 * **Stock tools join the same judgement** (ADR 0025; GRA-243): the caller passes the vendor's
 * ready-made tools beside the toolbox's. A stock tool's description is written in full, so its
 * own words dilute the union; a tool is therefore also a candidate when the word index's
 * goal-shaped entry (`termCoverage`) finds at least `COVERAGE_THRESHOLD` of the goal's content
 * words in its name, vendor, input labels or description. The 2026-09-21 goals that must match
 * nothing cover at most half of any tool's words, so they still miss.
 */

export const SIMILAR_THRESHOLD = 0.3;
export const COVERAGE_THRESHOLD = 0.75;
export const MAX_SIMILAR = 3;
const MIN_PREFIX = 4;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "from",
  "at",
  "as",
  "is",
  "are",
  "be",
  "it",
  "its",
  "that",
  "this",
  "these",
  "those",
  "each",
  "all",
  "any",
  "into",
  "your",
  "my",
  "their",
  "our",
  "per",
  "up",
  "out",
  "then",
  "than",
  "when",
  "where",
  "which",
  "who",
  "what",
  "no",
  "not",
  "only",
  "also",
  "so",
  "if",
  "via",
  "using",
  "use",
  "return",
  "returns",
  "returning",
  "including",
  "include",
  "includes",
  "get",
  "gets",
  "retrieve",
  "retrieves",
  "fetch",
  "fetches",
  "show",
  "shows",
  "showing",
  "connected",
  "api",
  "tool",
  "read",
  "readonly",
  "given",
  "new",
  "existing",
  "default",
  "accept",
  "accepts",
  "input",
  "id",
]);

/**
 * A goal that carries one of these anywhere asks for a write, and a read-only tool is not it —
 * "list items and then delete the selected one" writes (Greptile on #122). The verbs with an
 * everyday noun sense are `LEADING_WRITE_VERBS`: they count only as the goal's first content word,
 * so "Mark the message read" and "Reply to the latest email" write while "emails I need to reply
 * to" reads.
 */
const WRITE_VERBS = new Set([
  "create",
  "creates",
  "send",
  "sends",
  "update",
  "updates",
  "delete",
  "deletes",
  "remove",
  "removes",
  "archive",
  "archives",
  "move",
  "moves",
  "insert",
  "inserts",
  "upload",
  "uploads",
  "write",
  "writes",
  "cancel",
  "cancels",
  "trash",
  "modify",
  "modifies",
]);

const LEADING_WRITE_VERBS = new Set([
  "add",
  "reply",
  "mark",
  "set",
  "label",
  "post",
  "draft",
  "star",
  "flag",
  "assign",
  "schedule",
]);

/**
 * Whether the goal asks for a write: one of `WRITE_VERBS` among its content words, or one of
 * `LEADING_WRITE_VERBS` as the first.
 */
export function goalWrites(goal: string): boolean {
  const words = contentWords(goal);
  return words.some((word) => WRITE_VERBS.has(word)) || LEADING_WRITE_VERBS.has(words[0] ?? "");
}

/** The words that carry a text's meaning: `find_tool`'s words less the stopwords. */
export function contentWords(text: string): string[] {
  return queryWords(text.replaceAll("-", " ")).filter((word) => !STOPWORDS.has(word));
}

function agree(a: string, b: string): boolean {
  if (a === b || stem(a) === stem(b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

/** The share of the two word sets' union on which they agree, 0 to 1. */
export function similarity(goal: string, tool: IndexedTool): number {
  const goalWords = contentWords(goal);
  const toolWords = contentWords(`${tool.name} ${tool.description}`);
  if (goalWords.length === 0 || toolWords.length === 0) return 0;
  const goalHits = goalWords.filter((g) => toolWords.some((t) => agree(g, t))).length;
  const toolHits = toolWords.filter((t) => goalWords.some((g) => agree(g, t))).length;
  const agreed = Math.min(goalHits, toolHits);
  return agreed / (goalWords.length + toolWords.length - agreed);
}

/** The share of the goal's content words the word index finds in the tool, 0 to 1. */
export function goalCoverage(goal: string, tool: IndexedTool): number {
  return termCoverage(tool, [...new Set(contentWords(goal).map(stem))]);
}

/**
 * The tools that look like the goal, best first, at most `MAX_SIMILAR`; empty when none is close.
 * A tool whose `readOnly` is known and disagrees with what the goal asks for is not a candidate.
 * Ordered by the overlap score, then the coverage, then the name, so a tool the caller lists
 * first at an equal score (the toolbox before stock) is not reordered by the tie-break alone.
 */
export function similarTools<T extends IndexedTool>(tools: readonly T[], goal: string): T[] {
  const writes = goalWrites(goal);
  return tools
    .filter((tool) => tool.readOnly === undefined || tool.readOnly !== writes)
    .map((tool) => ({ tool, score: similarity(goal, tool), coverage: goalCoverage(goal, tool) }))
    .filter(({ score, coverage }) => score >= SIMILAR_THRESHOLD || coverage >= COVERAGE_THRESHOLD)
    .sort(
      (a, b) =>
        b.score - a.score || b.coverage - a.coverage || a.tool.name.localeCompare(b.tool.name),
    )
    .slice(0, MAX_SIMILAR)
    .map(({ tool }) => tool);
}
