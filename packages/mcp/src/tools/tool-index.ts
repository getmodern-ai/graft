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
 * Two exceptions (GRA-278): a soft word ("recent", "most", a count; `SOFT_WORDS`) ranks and never
 * decides, and a read verb counts as a weak hit on any read-only tool (`READ_CLASS`). Another
 * tool's wire name inside a description is not indexed (`WIRE_NAME_REFERENCE`).
 *
 * Hits are ranked by the caller's `tier` (the working set before the rest of the toolbox), then,
 * when the query asks to read (`readsOnly`) and not to write, read-only tools before the rest,
 * then by score: per term and field, the field's weight (name over vendor over input labels over
 * description) times how the term hit (itself over a synonym over a prefix), plus the name's weight
 * for each owner word of the query ("my") the name spells (`OWNER_WORDS`) and for each term asked
 * for in the plural that the name answers in the plural (`agreement`). Ties go by name, then
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
  "as",
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
  read: ["get", "fetch", "retrieve", "list", "search"],
  list: ["search", "query", "browse", "find"],
  show: ["list", "get", "display", "search"],
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
  // An inbox holds email, and the integration is named for it: a person's own Gmail tool says
  // "inbox" or "Gmail" where a person says "email" (2026-10-11's "list my recent emails").
  email: ["mail", "message", "inbox", "gmail"],
  mail: ["email", "message", "inbox", "gmail"],
  thread: ["conversation"],
  conversation: ["thread"],
  latest: ["newest", "recent", "last"],
  recent: ["latest", "newest", "last"],
  newest: ["latest", "recent", "last"],
  contact: ["person", "people"],
  user: ["member", "person", "people"],
  people: ["person", "user", "contact", "member"],
  file: ["document", "doc"],
  ticket: ["issue"],
  sprint: ["cycle"],
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
 * Words that qualify which of a tool's results a person wants rather than which tool: "recent",
 * "latest", "most", a count ("5", "10"). They rank a hit without deciding one (GRA-278): "list my
 * recent emails" is a search of the inbox whether or not the search's description says "recent",
 * and on 2026-10-11 the all-words rule cut `gmail__search-messages` for want of the word. A soft
 * word that hits scores as any term does; one that misses costs nothing.
 */
const SOFT_WORDS: ReadonlySet<string> = new Set(
  ["recent", "recently", "latest", "newest", "last", "most", "top", "first", "few", "several"]
    .concat(["many", "every", "each", "today"])
    .map(stem),
);
const NUMBER = /^\p{N}+$/u;

const isSoft = (term: string): boolean => SOFT_WORDS.has(term) || NUMBER.test(term);

/** A word in its plural form, as the stemmer sees one: it ends in "s" and stems to something else. */
const isPlural = (word: string): boolean => word.endsWith("s") && stem(word) !== word;

/**
 * The words a person says in the singular for a whole mailbox: "read my email" is the inbox, where
 * "read my spreadsheet" is one spreadsheet.
 */
const MAILBOX_WORDS: ReadonlySet<string> = new Set(["email", "mail", "inbox"].map(stem));

/**
 * A query's terms as `queryTerms` reads them, each marked `many` when the person asks for more than
 * one: the word is plural ("emails"), or it is a mailbox word an owner word stands before with only
 * soft words between ("my email", "my latest email").
 */
function queryContent(query: string): { term: string; many: boolean }[] {
  const words = queryWords(query);
  const keepAll = words.every((word) => FUNCTION_WORDS.has(word));
  const seen = new Set<string>();
  const out: { term: string; many: boolean }[] = [];
  let owned = false;
  for (const word of words) {
    if (!keepAll && FUNCTION_WORDS.has(word)) {
      owned = OWNER_WORDS.has(word);
      continue;
    }
    const term = stem(word);
    const many = isPlural(word) || (owned && MAILBOX_WORDS.has(term));
    if (!isSoft(term)) owned = false;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push({ term, many });
  }
  return out;
}

/**
 * The terms of a query: its words less the function words (all of them kept when nothing else is
 * left, so "their" is searched rather than refused), each stemmed, duplicates dropped.
 */
export function queryTerms(query: string): string[] {
  return queryContent(query).map(({ term }) => term);
}

/**
 * The function words that say whose, which `queryTerms` drops but which rank a hit without deciding
 * one (GRA-269): a tool whose name spells one scores it at the name's weight, so "my linear issues"
 * finds Linear's `list-my-issues` before the other issue tools, while a tool whose name does not
 * spell it is still a hit. Only these: "in" or "to" in a name ("reply-in-thread") says nothing a
 * query's "in" asked for.
 */
const OWNER_WORDS: ReadonlySet<string> = new Set(["my", "me", "our"]);

/** The owner words of a query, unless they are all it has, when they are its terms already. */
function rankingWords(query: string): string[] {
  const words = queryWords(query);
  if (words.every((word) => FUNCTION_WORDS.has(word))) return [];
  return words.filter((word) => OWNER_WORDS.has(word));
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

/**
 * Another tool's wire name in a description ("messageId comes from gmail__search-messages"):
 * dropped before the description is indexed (GRA-278), since its words are the other tool's job.
 * They made `gmail__create-draft` a hit for "list" through "search", and every Gmail tool a hit
 * for "get" through `gmail__get-message`.
 */
const WIRE_NAME_REFERENCE = /[\p{L}\p{N}-]+__[\p{L}\p{N}-]+/gu;

function documentOf(
  tool: IndexedTool,
  vendorNames: ReadonlyMap<string, readonly string[]> | undefined,
): Record<Field, Set<string>> {
  return {
    name: fieldTerms(tool.name),
    vendor: fieldTerms([tool.vendor, ...(vendorNames?.get(tool.vendor) ?? [])].join(" ")),
    labels: fieldTerms(inputLabels(tool.inputSchema).join(" ")),
    description: fieldTerms(tool.description.replaceAll(WIRE_NAME_REFERENCE, " ")),
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

/** A term's score against every field: zero when it hits none. */
function termScore(document: Record<Field, Set<string>>, term: string): number {
  let score = 0;
  for (const field of Object.keys(WEIGHTS) as Field[]) {
    score += WEIGHTS[field] * strength(term, document[field]);
  }
  return score;
}

/**
 * What a read verb that hits no field of a read-only tool scores: a hit, below any word's (GRA-278).
 * "show", "read", "view" and "check" each ask for some read, and which read is the nouns' to say,
 * so "show my emails" reaches the inbox search though the search's name says neither "show" nor a
 * synonym of it. A write tool earns nothing this way.
 */
const READ_CLASS = 0.25;

/** The tool's score for the terms, or null when a hard term hits no field. */
function scoreOf(
  document: Record<Field, Set<string>>,
  terms: readonly { term: string; soft: boolean }[],
  readOnly: boolean,
): number | null {
  let total = 0;
  for (const { term, soft } of terms) {
    let score = termScore(document, term);
    if (score === 0 && readOnly && READ_VERBS.has(term)) score = READ_CLASS;
    if (score === 0 && !soft) return null;
    total += score;
  }
  return total;
}

/**
 * Whether the tool's name answers a query term asked for in the plural with a plural (GRA-278):
 * "recent emails" and "my email" ask for a list and `search-messages` is one, while "latest email"
 * asks for one message and `get-message` reads one. Each such term scores a name hit again, so it
 * orders the tools the words found and never finds one; a term asked for in the singular earns
 * nothing.
 */
const AGREEMENT = WEIGHTS.name * EXACT;

function agreement(name: string, terms: readonly { term: string; many: boolean }[]): number {
  const words = name.toLowerCase().split(WORD_SEPARATOR).filter(Boolean);
  let total = 0;
  for (const { term, many } of terms) {
    if (!many || isSoft(term)) continue;
    const alternatives = STEMMED_SYNONYMS.get(term) ?? [];
    const hit = words.find((n) => stem(n) === term || alternatives.includes(stem(n)));
    if (hit !== undefined && isPlural(hit)) total += AGREEMENT;
  }
  return total;
}

/**
 * Whether the query asks to read: a read verb or a soft word among its terms, and no write verb.
 * A soft word asks which results ("recent charges", "my 5 latest emails"), so it reads too
 * (GRA-278). A query with neither, "notion database rows", is left to the score.
 */
export function readsOnly(terms: readonly string[]): boolean {
  return (
    terms.some((term) => READ_VERBS.has(term) || isSoft(term)) &&
    !terms.some((term) => WRITE_VERBS.has(term))
  );
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
  const content = queryContent(query);
  if (content.length === 0) return { hits: [], more: 0 };
  const terms = content.map(({ term }) => term);
  // Soft words rank and never decide, unless they are all the query has.
  const allSoft = terms.every(isSoft);
  const judged = content.map(({ term }) => ({ term, soft: !allSoft && isSoft(term) }));
  const reads = readsOnly(terms);
  const ranking = rankingWords(query);
  const scored: { tool: T; score: number }[] = [];
  for (const tool of tools) {
    const document = documentOf(tool, options.vendorNames);
    const score = scoreOf(document, judged, tool.readOnly === true);
    if (score === null) continue;
    const spelled = ranking.filter((word) => document.name.has(stem(word))).length;
    scored.push({
      tool,
      score: score + spelled * WEIGHTS.name * EXACT + agreement(tool.name, content),
    });
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
