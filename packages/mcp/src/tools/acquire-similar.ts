import { queryWords, type Searchable } from "./find-tool.match";

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
 * dropped; two words agree when one begins with the other and the shorter is four characters or
 * more (`email`/`emails`, `list`/`lists`), or they are equal. The score is the share of the union
 * that agrees, and a tool at or above `SIMILAR_THRESHOLD` is a candidate, best first, at most
 * `MAX_SIMILAR`. A goal that merely shares a vendor's vocabulary with a tool for a different job
 * — "find unreplied threads" against `find-invoices` — scores under it; the suite pins both sides
 * with the toolbox of that day. And a goal that writes (create, send, delete…) is never answered
 * with a read-only tool, nor a goal that reads with a tool that writes: "get a draft" and
 * "create a reply draft" share most of their words and are different jobs.
 */

export const SIMILAR_THRESHOLD = 0.3;
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

/** A goal whose first words carry one of these asks for a write; a read-only tool is not it. */
const WRITE_VERBS = new Set([
  "create",
  "creates",
  "send",
  "sends",
  "reply",
  "replies",
  "update",
  "updates",
  "delete",
  "deletes",
  "remove",
  "removes",
  "add",
  "adds",
  "post",
  "posts",
  "archive",
  "archives",
  "mark",
  "marks",
  "move",
  "moves",
  "insert",
  "inserts",
  "upload",
  "uploads",
  "set",
  "sets",
  "write",
  "writes",
  "cancel",
  "cancels",
  "trash",
  "modify",
  "modifies",
  "label",
  "labels",
]);

/** Whether the goal asks for a write: one of `WRITE_VERBS` among its first three content words. */
export function goalWrites(goal: string): boolean {
  return contentWords(goal)
    .slice(0, 3)
    .some((word) => WRITE_VERBS.has(word));
}

/** The words that carry a text's meaning: `find_tool`'s words less the stopwords. */
export function contentWords(text: string): string[] {
  return queryWords(text.replaceAll("-", " ")).filter((word) => !STOPWORDS.has(word));
}

function agree(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX && long.startsWith(short);
}

/** The share of the two word sets' union on which they agree, 0 to 1. */
export function similarity(goal: string, tool: Searchable): number {
  const goalWords = contentWords(goal);
  const toolWords = contentWords(`${tool.name} ${tool.description}`);
  if (goalWords.length === 0 || toolWords.length === 0) return 0;
  const goalHits = goalWords.filter((g) => toolWords.some((t) => agree(g, t))).length;
  const toolHits = toolWords.filter((t) => goalWords.some((g) => agree(g, t))).length;
  const agreed = Math.min(goalHits, toolHits);
  return agreed / (goalWords.length + toolWords.length - agreed);
}

/**
 * The tools that look like the goal, best first, at most `MAX_SIMILAR`; empty when none is close.
 * A tool whose `readOnly` is known and disagrees with what the goal asks for is not a candidate.
 */
export function similarTools<T extends Searchable & { readOnly?: boolean }>(
  tools: readonly T[],
  goal: string,
): T[] {
  const writes = goalWrites(goal);
  return tools
    .filter((tool) => tool.readOnly === undefined || tool.readOnly !== writes)
    .map((tool) => ({ tool, score: similarity(goal, tool) }))
    .filter(({ score }) => score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, MAX_SIMILAR)
    .map(({ tool }) => tool);
}
