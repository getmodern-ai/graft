/**
 * How `find_tool` searches the toolbox (GRA-236; ADR 0025, "search is a deterministic word index,
 * never a model"). Pure: no store, no session, no model, no embedding.
 *
 * A tool is indexed as four fields of stemmed words: its name (hyphens read as spaces), its vendor
 * (the slug, and any display name the caller knows for it), its input labels (`inputLabels`) and
 * its description. A query is read as terms: `queryWords`, function words dropped, each stemmed.
 * A tool is a hit when every term hits some field, as the term itself, as one of its synonyms
 * (`SYNONYMS`: "find" reaches a search, "dm" a message), or, for a term of four characters or
 * more, as the start of a longer word. All-or-nothing on the terms is GRA-115's rule kept, so a
 * word absent from every field is still a miss; what changed is what counts as the word present.
 *
 * Hits are ranked by the caller's `tier` (the working set before the rest of the toolbox), then,
 * when the query asks to read (`READ_VERBS`) and not to write, read-only tools before the rest,
 * then by score: per term and field, the field's weight (name over vendor over input labels over
 * description) times how the term hit (itself over a synonym over a prefix). Ties go by name, then
 * vendor, so the order is a function of the tools and the query alone. The first `limit` are
 * answered and the rest counted as `more`.
 *
 * GRA-221's write-up (`docs/research/gra-221-pipedream-coverage.md` on its research branch) has
 * the queries the substring rule failed; `tool-index.test.ts` pins them.
 */

/** What `find_tool` answers at most; the rest are counted (`ToolSearch.more`). */
export const FIND_TOOL_LIMIT = 5;

/**
 * A tool as the index reads it. `tier` is the caller's ordering, lower first: `find_tool` passes 0
 * for the agent's working set and 1 for the rest of the toolbox, and leaves room for GRA-234's
 * stock tiers after them. `readOnly` unset ranks with the writes.
 */
export type IndexedTool = {
  vendor: string;
  name: string;
  description: string;
  inputSchema?: unknown;
  readOnly?: boolean;
  tier?: number;
};

export type SearchOptions = {
  /** How many hits to answer; `FIND_TOOL_LIMIT` unset. */
  limit?: number;
  /** Display names per vendor slug, searched as the vendor is ("HubSpot", a connection's name). */
  vendorNames?: ReadonlyMap<string, readonly string[]>;
};

/** The hits, best first, and how many more matched past the limit. */
export type ToolSearch<T> = { hits: T[]; more: number };

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

const MIN_STEM = 3;
const UNDOUBLED = /([bdfgkmnprt])\1$/;

function undouble(stemmed: string): string {
  return UNDOUBLED.test(stemmed) && stemmed.length - 1 >= MIN_STEM ? stemmed.slice(0, -1) : stemmed;
}

/**
 * A small English stemmer, enough to fold the forms tool names and queries use onto one stem:
 * plurals ("issues", "searches", "replies"), then "-ing" and "-ed", then a final "e", so "create",
 * "creates", "created" and "creating" agree. No suffix is taken when fewer than three letters
 * would be left. Not Porter's: the index needs agreement between forms, not a linguist's root.
 */
export function stem(word: string): string {
  if (word.length <= MIN_STEM) return word;
  let s = word;
  if (s.endsWith("ies") && s.length - 3 >= MIN_STEM - 1) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(?:x|ch|sh|zz)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(?:ss|us|is)$/.test(s) && s.length - 1 >= MIN_STEM) {
    s = s.slice(0, -1);
  }
  if (s.endsWith("ied") && s.length - 3 >= MIN_STEM - 1) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith("ing") && s.length - 3 >= MIN_STEM) s = undouble(s.slice(0, -3));
  else if (s.endsWith("ed") && s.length - 2 >= MIN_STEM) s = undouble(s.slice(0, -2));
  if (s.endsWith("e") && s.length - 1 >= MIN_STEM) s = s.slice(0, -1);
  return s;
}

/** Words a query carries that say nothing about which tool: dropped unless nothing else is left. */
const FUNCTION_WORDS = new Set([
  "an",
  "the",
  "my",
  "me",
  "our",
  "your",
  "their",
  "its",
  "it",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "from",
  "with",
  "and",
  "or",
  "all",
  "any",
  "some",
  "up",
  "is",
  "are",
  "be",
  "this",
  "that",
  "these",
  "those",
  "please",
  "tool",
  "tools",
]);

/**
 * The verbs and nouns a person says for one another, query word to the words a tool may say
 * instead, one way: "find" reaches a tool named for a search, but "search" does not reach every
 * getter. "look up" is "look" with "up" dropped. Kept short on purpose; each line is a query
 * GRA-221 saw fail or its near neighbour. A synonym hit scores below the word itself.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  find: ["search", "get", "lookup", "look", "query", "retrieve", "fetch", "list"],
  search: ["find", "query", "lookup", "look"],
  look: ["lookup", "find", "search", "get"],
  lookup: ["look", "find", "search", "get"],
  get: ["retrieve", "fetch", "read", "find"],
  fetch: ["get", "retrieve", "read"],
  retrieve: ["get", "fetch", "read"],
  read: ["get", "fetch", "retrieve", "list"],
  list: ["search", "query", "browse", "find"],
  show: ["list", "get", "display"],
  browse: ["list", "search"],
  send: ["post"],
  post: ["send", "publish"],
  dm: ["message", "direct"],
  create: ["add", "new", "make", "insert"],
  add: ["create", "insert", "append", "new"],
  make: ["create", "add"],
  new: ["create", "add"],
  update: ["edit", "modify", "change", "patch", "set"],
  edit: ["update", "modify", "change"],
  modify: ["update", "edit", "change"],
  change: ["update", "edit", "modify"],
  delete: ["remove", "trash", "erase"],
  remove: ["delete", "trash"],
  schedule: ["create", "add", "book"],
  meeting: ["event"],
  event: ["meeting"],
  upcoming: ["next", "future"],
  email: ["mail"],
  contact: ["person", "people"],
  user: ["member", "person", "people"],
  people: ["person", "user", "contact", "member"],
  file: ["document", "doc"],
};

const STEMMED_SYNONYMS = new Map(
  Object.entries(SYNONYMS).map(([word, alternatives]) => [
    stem(word),
    [...new Set(alternatives.map(stem))],
  ]),
);

/** A query that reads, unless it also carries a write verb: read-only tools rank first. */
const READ_VERBS = new Set(
  ["find", "search", "look", "lookup", "get", "fetch", "retrieve", "read", "list", "show"]
    .concat(["browse", "view", "query", "count", "check"])
    .map(stem),
);
const WRITE_VERBS = new Set(
  ["send", "post", "create", "add", "make", "new", "update", "edit", "modify", "change", "set"]
    .concat(["delete", "remove", "trash", "archive", "move", "upload", "write", "insert"])
    .concat(["reply", "mark", "cancel", "schedule", "invite", "assign", "dm"])
    .map(stem),
);

/**
 * The terms of a query: its words less the function words (all of them kept when nothing else is
 * left, so "their" is searched rather than refused), each stemmed, duplicates dropped.
 */
export function queryTerms(query: string): string[] {
  const words = queryWords(query);
  const content = words.filter((word) => !FUNCTION_WORDS.has(word));
  return [...new Set((content.length > 0 ? content : words).map(stem))];
}

const MAX_LABEL_DEPTH = 8;

const splitCase = (key: string): string =>
  key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .toLowerCase();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The words an input schema offers a search: each property's name read as words (`objectType` is
 * "object type"), its `title`, and its string `enum` values, through nested objects and lists, so
 * a generic tool whose object is an input value ("contacts" in HubSpot's object type, GRA-221) is
 * reachable by that word. Property descriptions are not labels and are not read.
 */
export function inputLabels(schema: unknown): string[] {
  const labels: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (!isObject(node) || depth > MAX_LABEL_DEPTH) return;
    if (isObject(node.properties)) {
      for (const [key, property] of Object.entries(node.properties)) {
        labels.push(splitCase(key));
        if (isObject(property)) {
          if (typeof property.title === "string") labels.push(property.title.toLowerCase());
          if (Array.isArray(property.enum)) {
            for (const value of property.enum) {
              if (typeof value === "string") labels.push(value.toLowerCase());
            }
          }
        }
        walk(property, depth + 1);
      }
    }
    walk(node.items, depth + 1);
  };
  walk(schema, 0);
  return labels;
}

/** Field weights: a hit in the name says most about the tool, one in its description least. */
const WEIGHTS = { name: 4, vendor: 3, labels: 2, description: 1 } as const;
type Field = keyof typeof WEIGHTS;
/** How a term hit a field: itself, a synonym, or the start of a longer word. */
const EXACT = 1;
const SYNONYM = 0.75;
const PREFIX = 0.5;
const MIN_PREFIX = 4;

const fieldTerms = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(WORD_SEPARATOR).filter(Boolean).map(stem));

function documentOf(
  tool: IndexedTool,
  vendorNames: ReadonlyMap<string, readonly string[]> | undefined,
): Record<Field, Set<string>> {
  return {
    name: fieldTerms(tool.name),
    vendor: fieldTerms([tool.vendor, ...(vendorNames?.get(tool.vendor) ?? [])].join(" ")),
    labels: fieldTerms(inputLabels(tool.inputSchema).join(" ")),
    description: fieldTerms(tool.description),
  };
}

function strength(term: string, field: Set<string>): number {
  if (field.has(term)) return EXACT;
  if (STEMMED_SYNONYMS.get(term)?.some((alternative) => field.has(alternative))) return SYNONYM;
  if (term.length >= MIN_PREFIX) {
    for (const word of field) if (word.length > term.length && word.startsWith(term)) return PREFIX;
  }
  return 0;
}

/** The tool's score for the terms, or null when a term hits no field. */
function scoreOf(document: Record<Field, Set<string>>, terms: readonly string[]): number | null {
  let total = 0;
  for (const term of terms) {
    let termScore = 0;
    for (const field of Object.keys(WEIGHTS) as Field[]) {
      termScore += WEIGHTS[field] * strength(term, document[field]);
    }
    if (termScore === 0) return null;
    total += termScore;
  }
  return total;
}

/** Whether the query asks to read: a read verb among its terms and no write verb. */
export function readsOnly(terms: readonly string[]): boolean {
  return terms.some((term) => READ_VERBS.has(term)) && !terms.some((term) => WRITE_VERBS.has(term));
}

/**
 * The tools every term of the query hits, ranked, the first `limit` answered and the rest counted.
 * A query with no term answers nothing: the caller decides whether that is a refusal (`find_tool`
 * says so) or an empty answer.
 */
export function searchTools<T extends IndexedTool>(
  tools: readonly T[],
  query: string,
  options: SearchOptions = {},
): ToolSearch<T> {
  const limit = options.limit ?? FIND_TOOL_LIMIT;
  const terms = queryTerms(query);
  if (terms.length === 0) return { hits: [], more: 0 };
  const reads = readsOnly(terms);
  const scored: { tool: T; score: number }[] = [];
  for (const tool of tools) {
    const score = scoreOf(documentOf(tool, options.vendorNames), terms);
    if (score !== null) scored.push({ tool, score });
  }
  scored.sort(
    (a, b) =>
      (a.tool.tier ?? 0) - (b.tool.tier ?? 0) ||
      (reads ? Number(b.tool.readOnly === true) - Number(a.tool.readOnly === true) : 0) ||
      b.score - a.score ||
      a.tool.name.localeCompare(b.tool.name) ||
      a.tool.vendor.localeCompare(b.tool.vendor),
  );
  return {
    hits: scored.slice(0, limit).map(({ tool }) => tool),
    more: Math.max(0, scored.length - limit),
  };
}

/**
 * The share of `terms` that hit some field of the tool, 0 to 1, each by the same rule a query's
 * term is judged by (itself, a synonym, or a prefix). The goal-shaped entry to the index
 * (GRA-243): `acquire`'s similar check reads a goal against a tool whose description is long, as a
 * stock tool's is, where the share of the two word sets' union would be diluted by the
 * description's own words. Empty terms cover nothing.
 */
export function termCoverage(
  tool: IndexedTool,
  terms: readonly string[],
  options: Pick<SearchOptions, "vendorNames"> = {},
): number {
  if (terms.length === 0) return 0;
  const document = documentOf(tool, options.vendorNames);
  const fields = Object.keys(WEIGHTS) as Field[];
  const hit = terms.filter((term) => fields.some((field) => strength(term, document[field]) > 0));
  return hit.length / terms.length;
}
