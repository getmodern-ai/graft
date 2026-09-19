/**
 * How `find_tool` matches and ranks (GRA-115). Pure: no store, no session.
 *
 * The query is split into words on whitespace and punctuation, lowercased, one-character words
 * dropped. A tool is a hit when every word appears in the join of its vendor, its name (hyphens
 * read as spaces) and its description — each word as a substring, in any order. The whole query as
 * one contiguous substring was the rule before, and "rate exchange" found nothing that "exchange
 * rate" found; the agent was sent to `acquire` for a tool that existed.
 *
 * Hits are ranked: a tool with a word in its name first, then one with a word in its vendor, then
 * one with a word in its description, then by how many words hit the name; ties by name, then by
 * vendor, so the order is a function of the toolbox and the query alone.
 */

export type Searchable = { vendor: string; name: string; description: string };

/** A hit and how it matched, ready to sort. */
type Scored<T> = { tool: T; name: number; vendor: number; description: number };

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * The words of a query: split on anything that is neither a letter nor a number, lowercased, a
 * one-character word dropped, duplicates dropped. An empty list means the query has no word to
 * match on, which `find_tool` refuses rather than answering the whole toolbox.
 */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(WORD_SEPARATOR)
    .filter((word) => [...word].length > 1);
  return [...new Set(words)];
}

const readable = (field: string): string => field.toLowerCase().replaceAll("-", " ");

const countHits = (field: string, words: string[]): number =>
  words.filter((word) => field.includes(word)).length;

function score<T extends Searchable>(tool: T, words: string[]): Scored<T> | null {
  const name = readable(tool.name);
  const vendor = readable(tool.vendor);
  const description = tool.description.toLowerCase();
  const joined = `${vendor} ${name} ${description}`;
  if (!words.every((word) => joined.includes(word))) return null;
  return {
    tool,
    name: countHits(name, words),
    vendor: countHits(vendor, words),
    description: countHits(description, words),
  };
}

/** Whether every word of the query appears in the join of vendor, name and description. */
export function matchesQuery(tool: Searchable, query: string): boolean {
  const words = queryWords(query);
  return words.length > 0 && score(tool, words) !== null;
}

const present = (count: number): number => (count > 0 ? 1 : 0);

function compare<T extends Searchable>(a: Scored<T>, b: Scored<T>): number {
  return (
    present(b.name) - present(a.name) ||
    present(b.vendor) - present(a.vendor) ||
    present(b.description) - present(a.description) ||
    b.name - a.name ||
    a.tool.name.localeCompare(b.tool.name) ||
    a.tool.vendor.localeCompare(b.tool.vendor)
  );
}

/**
 * The tools every word of the query hits, best first. An empty word list answers no tool: the
 * caller decides whether that is a refusal (`find_tool` says so) or an empty answer.
 */
export function rankTools<T extends Searchable>(tools: readonly T[], query: string): T[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const scored: Scored<T>[] = [];
  for (const tool of tools) {
    const hit = score(tool, words);
    if (hit) scored.push(hit);
  }
  return scored.sort(compare).map((hit) => hit.tool);
}
