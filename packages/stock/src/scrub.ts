import { createHmac } from "node:crypto";

import { stringLiteralsOf } from "@graft/check/string-literals";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import type { RecordedBody, RecordedResponse, StockRecording } from "./recording";

/**
 * The scrub (GRA-257; `RECORDING.md`, *The scrub*): a stock recording is made against a
 * maintainer's own account and committed to a public repository, so before it is written every value
 * a vendor answered is replaced by a placeholder of the same type and shape. Keys, array lengths and
 * nesting are kept; one value maps to one placeholder within a recording, so an id an earlier answer
 * gave and a later request names is the same placeholder in both.
 *
 * Pure for a seed. The build command draws a fresh random seed per recording, so a placeholder is
 * not a keyed hash anyone could test a guessed name against.
 *
 * What is kept, and why each:
 *  - a value in `keep`: the module's own string literals and its input schema's strings, which are
 *    public code (`keptLiteralsOf`), so a module comparing an answer with `"message"` still matches;
 *  - the input schema's `enum` and `const` numbers, public code too;
 *  - booleans and `null`: one bit, and the bit a module branches on (`has_more`);
 *  - integers from 0 to 99: counts, pages and codes a module loops or branches on, naming no one;
 *  - a redaction marker (`[redacted…]`), whole or inside a string, so a reviewer still sees it; the
 *    text around it is scrubbed as any other (Greptile on #192: an echoed credential followed by a
 *    name kept the name);
 *  - a string with no letter or digit;
 *  - in a `link` header, a `rel` whose every value is one of `SAFE_LINK_RELATIONS` and the parameter
 *    names RFC 8288 defines; every other parameter value is drawn again, and each target is a URL
 *    like any other.
 *
 * **When in doubt it fails rather than keeps** (Greptile on #192). A value for which no placeholder
 * can be drawn that is neither an original value nor another value's placeholder, or (in the input)
 * one its input schema admits, throws a `ScrubFailure` naming the part of the recording and never the
 * value, and the build refuses the recording as `recording_failed`.
 */

export type ScrubRule = {
  /** Draws every placeholder. The same seed and recording give the same scrub. */
  seed: string;
  /** Strings to leave as they are: the module's literals and its schema's strings. */
  keep?: Iterable<string>;
  /**
   * The tool's input schema. The input's placeholders are drawn within it (an enum's value, a number
   * within its bounds and `multipleOf`, a string its length, pattern and format admit), and its
   * strings and its `enum` and `const` values, public code, are kept wherever they appear.
   */
  inputSchema?: unknown;
};

/**
 * The scrub could not draw a placeholder it may keep. `where` names the part of the recording
 * (`the input`, `exchange 2's answer`); the message never carries the value.
 */
export class ScrubFailure extends Error {
  constructor(
    readonly reason: string,
    readonly where?: string,
  ) {
    super(where === undefined ? reason : `${reason}, in ${where}`);
    this.name = "ScrubFailure";
  }
}

const SMALL_INTEGER_LIMIT = 100;
const MARKER = /\[redacted[^\]]*\]/g;
const EMAIL = /^([^\s@]+)@[^\s@]+\.[A-Za-z]{2,}$/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const MAX_ATTEMPTS = 64;

/** A link relation a client follows by name, which names nothing of the account's (RFC 8288). */
const SAFE_LINK_RELATIONS: ReadonlySet<string> = new Set([
  "next",
  "prev",
  "previous",
  "first",
  "last",
  "self",
  "start",
  "up",
  "alternate",
  "canonical",
  "related",
  "index",
  "help",
  "edit",
  "describedby",
  "collection",
  "item",
  "search",
]);
/** The parameter names RFC 8288 defines, which are protocol and kept; any other is drawn again. */
const LINK_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "rel",
  "rev",
  "anchor",
  "title",
  "title*",
  "type",
  "hreflang",
  "media",
]);

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
/** 2000-01-01 to 2030-01-01, the span a placeholder time is drawn from. */
const TIME_FROM = Date.UTC(2000, 0, 1);
const TIME_SPAN = Date.UTC(2030, 0, 1) - TIME_FROM;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a string holds a letter or a digit outside its redaction markers. */
function hasWord(text: string): boolean {
  return /[\p{L}\d]/u.test(text.replace(MARKER, ""));
}

/** A stream of pseudo-random numbers from the seed, one stream per (kind, value, attempt). */
function draws(seed: string, key: string): () => number {
  let block = 0;
  let bytes = Buffer.alloc(0);
  let at = 0;
  return () => {
    if (at + 4 > bytes.length) {
      bytes = createHmac("sha256", seed).update(`${key}\u0000${block}`).digest();
      block += 1;
      at = 0;
    }
    const value = bytes.readUInt32BE(at);
    at += 4;
    return value / 2 ** 32;
  };
}

function pick(alphabet: string, next: () => number): string {
  return alphabet[Math.floor(next() * alphabet.length)] as string;
}

/** Each letter a letter of the same case, each digit a digit; every other character kept. */
function substitute(text: string, next: () => number): string {
  const hex =
    text.length >= 6 && /\d/.test(text) && !/[g-zG-Z]/.test(text) && /^[\w-]+$/.test(text);
  let out = "";
  for (const char of text) {
    if (/\d/.test(char)) out += pick(DIGITS, next);
    else if (/\p{Lu}/u.test(char)) out += pick(hex ? "ABCDEF" : UPPER, next);
    else if (/\p{L}/u.test(char)) out += pick(hex ? "abcdef" : LOWER, next);
    else out += char;
  }
  return out;
}

/** `substitute`, leaving every redaction marker inside the text as it is. */
function substituteAroundMarkers(text: string, next: () => number): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    out += substitute(text.slice(last, match.index), next) + match[0];
    last = match.index + match[0].length;
  }
  return out + substitute(text.slice(last), next);
}

function isoPlaceholder(match: RegExpExecArray, next: () => number): string {
  const time = new Date(TIME_FROM + Math.floor(next() * TIME_SPAN)).toISOString();
  const [, , , , sep, , , ss, fraction, zone] = match;
  let out = `${time.slice(0, 4)}-${time.slice(5, 7)}-${time.slice(8, 10)}`;
  if (sep !== undefined) {
    out += `${sep}${time.slice(11, 13)}:${time.slice(14, 16)}`;
    if (ss !== undefined) out += `:${time.slice(17, 19)}`;
    if (fraction !== undefined) {
      out += `.${time.slice(20, 23).padEnd(fraction.length, "0").slice(0, fraction.length)}`;
    }
  }
  return out + (zone ?? "");
}

function urlPlaceholder(text: string): string | null {
  if (!URL_LIKE.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

/** Every digit drawn again; the sign, the point, the digit counts and the exponent kept. */
function numberPlaceholder(value: number, next: () => number): number {
  const text = String(value);
  const [mantissa = "", exponent] = text.split("e");
  const [whole = "", fraction] = mantissa.replace("-", "").split(".");
  const drawWhole = [...whole]
    .map((_, index) =>
      index === 0 && (whole.length > 1 || whole !== "0")
        ? pick("123456789", next)
        : pick(DIGITS, next),
    )
    .join("");
  const drawFraction =
    fraction === undefined
      ? ""
      : `.${[...fraction]
          .map((_, index) =>
            index === fraction.length - 1 ? pick("123456789", next) : pick(DIGITS, next),
          )
          .join("")}`;
  const sign = value < 0 ? "-" : "";
  return Number(
    `${sign}${drawWhole}${drawFraction}${exponent === undefined ? "" : `e${exponent}`}`,
  );
}

/** What an input schema asks of a number, for drawing one inside it. */
type NumberRange = { low: number | null; high: number | null; step: number | null };

/**
 * A number inside the range, a multiple of the step where there is one, with the value's decimal
 * places where there is none; null where the range is empty. The schema's own validator still
 * judges it (an exclusive bound, say), so this only has to land inside often.
 */
function numberInRange(value: number, range: NumberRange, next: () => number): number | null {
  const spread = Math.max(Math.abs(value), 1) * 10;
  const low = range.low ?? (range.high === null ? value - spread : range.high - spread);
  const high = range.high ?? low + spread;
  if (range.step !== null && range.step > 0) {
    const from = Math.ceil(low / range.step);
    const to = Math.floor(high / range.step);
    if (to < from) return null;
    const multiple = from + Math.floor(next() * (to - from + 1));
    return Number((multiple * range.step).toPrecision(12));
  }
  if (high < low) return null;
  const places = String(value).split(".")[1]?.length ?? 0;
  return Number((low + next() * (high - low)).toFixed(places));
}

type Scrubber = {
  /** `accept`, where given, is the input schema's judgement of a candidate placeholder. */
  string(text: string, accept?: (candidate: string) => boolean): string;
  number(value: number, accept?: (candidate: number) => boolean, range?: NumberRange): number;
  /** A JSON value, every leaf scrubbed. */
  value(value: unknown): unknown;
};

const NO_PLACEHOLDER =
  "no placeholder could be drawn for one of its values that is neither an original value nor another value's placeholder";
const NOT_IN_SCHEMA =
  "no placeholder the tool's input schema admits could be drawn for one of its values";

function createScrubber(
  rule: ScrubRule,
  avoid: { strings: Set<string>; numbers: Set<number> },
  keptNumbers: ReadonlySet<number>,
): Scrubber {
  const keep = new Set(rule.keep ?? []);
  const strings = new Map<string, string>();
  const numbers = new Map<number, number>();
  const used = new Set<string>();

  const string = (text: string, accept?: (candidate: string) => boolean): string => {
    if (keep.has(text) || !hasWord(text)) return text;
    const known = strings.get(text);
    if (known !== undefined) {
      if (accept && !accept(known)) throw new ScrubFailure(NOT_IN_SCHEMA);
      return known;
    }
    const marked = text.replace(MARKER, "") !== text;
    const url = marked ? null : urlPlaceholder(text);
    if (url !== null && (!accept || accept(url))) {
      strings.set(text, url);
      return url;
    }
    const email = marked ? null : EMAIL.exec(text);
    const iso = marked ? null : ISO.exec(text);
    let refusedBySchema = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const next = draws(rule.seed, `s\u0000${text}\u0000${attempt}`);
      const placeholder = email
        ? `${substitute(email[1] as string, next)}@example.com`
        : iso
          ? isoPlaceholder(iso, next)
          : substituteAroundMarkers(text, next);
      if (placeholder === text || used.has(placeholder) || avoid.strings.has(placeholder)) continue;
      if (accept && !accept(placeholder)) {
        refusedBySchema = true;
        continue;
      }
      strings.set(text, placeholder);
      used.add(placeholder);
      return placeholder;
    }
    throw new ScrubFailure(refusedBySchema ? NOT_IN_SCHEMA : NO_PLACEHOLDER);
  };

  const number = (
    value: number,
    accept?: (candidate: number) => boolean,
    range?: NumberRange,
  ): number => {
    if (!Number.isFinite(value) || keptNumbers.has(value)) return value;
    if (Number.isInteger(value) && value >= 0 && value < SMALL_INTEGER_LIMIT) {
      if (!accept || accept(value)) return value;
    }
    const known = numbers.get(value);
    if (known !== undefined) {
      if (accept && !accept(known)) throw new ScrubFailure(NOT_IN_SCHEMA);
      return known;
    }
    let refusedBySchema = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const next = draws(rule.seed, `n\u0000${value}\u0000${attempt}`);
      // The same shape first; past half the attempts, anywhere the schema's bounds admit.
      const placeholder =
        range && attempt >= MAX_ATTEMPTS / 2
          ? numberInRange(value, range, next)
          : numberPlaceholder(value, next);
      // A finite value only: `1e308` drawn with a larger leading digit is `Infinity`, which JSON
      // writes as `null` (Greptile on #192).
      if (
        placeholder === null ||
        !Number.isFinite(placeholder) ||
        placeholder === value ||
        used.has(`#${placeholder}`) ||
        avoid.numbers.has(placeholder)
      ) {
        continue;
      }
      if (accept && !accept(placeholder)) {
        refusedBySchema = true;
        continue;
      }
      numbers.set(value, placeholder);
      used.add(`#${placeholder}`);
      return placeholder;
    }
    throw new ScrubFailure(refusedBySchema ? NOT_IN_SCHEMA : NO_PLACEHOLDER);
  };

  const value = (node: unknown): unknown => {
    if (typeof node === "string") return string(node);
    if (typeof node === "number") return number(node);
    if (Array.isArray(node)) return node.map(value);
    if (isRecord(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, value(v)]));
    return node;
  };

  return { string, number, value };
}

const schemaValidator = new AjvJsonSchemaValidator();
/** Each subschema's validator by its text, or null where it does not compile on its own. */
const leafValidators = new Map<string, ((candidate: unknown) => boolean) | null>();

/**
 * The input schema's judgement of a leaf's placeholder: the subschema at the leaf, compiled alone.
 * None for an empty subschema, or one that does not compile alone (a `$ref` to the root's
 * definitions); the whole input is judged against the whole schema after the scrub (`record.ts`).
 */
function acceptOf(schema: Record<string, unknown>): ((candidate: unknown) => boolean) | undefined {
  if (Object.keys(schema).length === 0) return undefined;
  const key = JSON.stringify(schema);
  if (!leafValidators.has(key)) {
    let judge: ((candidate: unknown) => boolean) | null;
    try {
      const validate = schemaValidator.getValidator(schema as JsonSchemaType);
      judge = (candidate) => validate(candidate).valid;
    } catch {
      judge = null;
    }
    leafValidators.set(key, judge);
  }
  return leafValidators.get(key) ?? undefined;
}

function rangeOf(schema: Record<string, unknown>): NumberRange | undefined {
  const numeric = (key: string) =>
    typeof schema[key] === "number" ? (schema[key] as number) : null;
  const low = numeric("minimum") ?? numeric("exclusiveMinimum");
  const high = numeric("maximum") ?? numeric("exclusiveMaximum");
  const step = numeric("multipleOf") ?? (schema.type === "integer" ? 1 : null);
  if (low === null && high === null && numeric("multipleOf") === null) return undefined;
  return { low, high, step };
}

/** The subschema an array's entry at `index` answers to. */
function entrySchemaOf(schema: Record<string, unknown>, index: number): unknown {
  if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) {
    return schema.prefixItems[index];
  }
  if (Array.isArray(schema.items)) {
    return index < schema.items.length ? schema.items[index] : schema.additionalItems;
  }
  return schema.items;
}

/** The subschema an object's property answers to. */
function propertySchemaOf(schema: Record<string, unknown>, key: string): unknown {
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) {
    return schema.properties[key];
  }
  return schema.additionalProperties;
}

/**
 * The input, scrubbed within its schema (Greptile on #192: a valid `100` under `maximum: 100` was
 * drawn as another three-digit number). An `enum` or `const` value is public and stays; a value
 * outside one is replaced by one of the schema's; a string or a number is drawn under the mapping
 * and accepted only where its subschema admits it.
 */
function scrubInput(node: unknown, schema: unknown, scrub: Scrubber, seed: string): unknown {
  const at = isRecord(schema) ? schema : {};
  const options = Object.hasOwn(at, "const")
    ? [at.const]
    : Array.isArray(at.enum) && at.enum.length > 0
      ? at.enum
      : null;
  if (options !== null) {
    const text = JSON.stringify(node);
    if (options.some((option) => JSON.stringify(option) === text)) return node;
    return options[Math.floor(draws(seed, `e\u0000${text}`)() * options.length)];
  }
  if (typeof node === "string") return scrub.string(node, acceptOf(at));
  if (typeof node === "number") return scrub.number(node, acceptOf(at), rangeOf(at));
  if (Array.isArray(node)) {
    return node.map((entry, index) => scrubInput(entry, entrySchemaOf(at, index), scrub, seed));
  }
  if (isRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, entry]) => [
        key,
        scrubInput(entry, propertySchemaOf(at, key), scrub, seed),
      ]),
    );
  }
  return node;
}

/** The schema's `enum` and `const` numbers, which are public code. */
function schemaNumbersOf(node: unknown, into: Set<number>): Set<number> {
  if (Array.isArray(node)) for (const entry of node) schemaNumbersOf(entry, into);
  else if (isRecord(node)) {
    for (const [key, entry] of Object.entries(node)) {
      if (key === "const" && typeof entry === "number") into.add(entry);
      if (key === "enum" && Array.isArray(entry)) {
        for (const option of entry) if (typeof option === "number") into.add(option);
      }
      schemaNumbersOf(entry, into);
    }
  }
  return into;
}

/** Every string and number leaf of a JSON value. */
function collectLeaves(node: unknown, into: { strings: Set<string>; numbers: Set<number> }) {
  if (typeof node === "string") into.strings.add(node);
  else if (typeof node === "number") into.numbers.add(node);
  else if (Array.isArray(node)) for (const entry of node) collectLeaves(entry, into);
  else if (isRecord(node)) for (const entry of Object.values(node)) collectLeaves(entry, into);
}

function bodyLeaves(
  body: RecordedBody | undefined,
  into: { strings: Set<string>; numbers: Set<number> },
) {
  if (!body) return;
  if ("json" in body) collectLeaves(body.json, into);
  else if ("text" in body) into.strings.add(body.text);
}

function scrubBody(
  body: RecordedBody | undefined,
  scrub: Scrubber,
  seed: string,
): RecordedBody | undefined {
  if (!body) return body;
  if ("json" in body) return { json: scrub.value(body.json) };
  if ("text" in body) return { text: scrub.string(body.text) };
  const length = Buffer.from(body.base64, "base64").length;
  const next = draws(seed, `b\u0000${body.base64}`);
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(next() * 256);
  return { base64: bytes.toString("base64") };
}

type LinkParameter = { name: string; value: string | null; quoted: boolean };
type LinkEntry = { target: string; parameters: LinkParameter[] };

const LINK_ENTRY =
  /\s*<([^>]*)>((?:\s*;\s*[^\s;,=]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s;,"]*))?)*)\s*(?:,|$)/y;
const LINK_PARAMETER = /;\s*([^\s;,=]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s;,"]*))?/g;

/** A `link` header's entries (RFC 8288), or null where it does not parse as one whole. */
function parseLinkHeader(value: string): LinkEntry[] | null {
  const entries: LinkEntry[] = [];
  const entry = new RegExp(LINK_ENTRY);
  while (entry.lastIndex < value.length) {
    const from = entry.lastIndex;
    const match = entry.exec(value);
    if (!match || entry.lastIndex === from) return null;
    const parameters = [...(match[2] ?? "").matchAll(LINK_PARAMETER)].map(
      ([, name = "", raw]): LinkParameter => {
        if (raw === undefined) return { name, value: null, quoted: false };
        const quoted = raw.startsWith('"');
        return { name, value: quoted ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw, quoted };
      },
    );
    entries.push({ target: match[1] ?? "", parameters });
  }
  return entries.length > 0 ? entries : null;
}

/** Whether a `link` parameter is a relation a client follows by name, and so kept. */
function isSafeRelation(parameter: LinkParameter): boolean {
  return (
    parameter.name.toLowerCase() === "rel" &&
    parameter.value !== null &&
    parameter.value.trim() !== "" &&
    parameter.value
      .trim()
      .split(/\s+/)
      .every((relation) => SAFE_LINK_RELATIONS.has(relation.toLowerCase()))
  );
}

/**
 * The account's values in a `link` header: the targets and every parameter but a safe `rel`, which
 * the scrub draws again and the survival check looks for. The whole header where it does not parse.
 */
function linkValuesOf(value: string): string[] {
  const entries = parseLinkHeader(value);
  if (entries === null) return [value];
  return entries.flatMap((entry) => [
    entry.target,
    ...entry.parameters.flatMap((parameter) =>
      isSafeRelation(parameter) ? [] : [...linkNameValues(parameter), parameter.value ?? ""],
    ),
  ]);
}

/** A parameter's name, where it is not one RFC 8288 defines and so may be the account's. */
function linkNameValues(parameter: LinkParameter): string[] {
  return LINK_PARAMETER_NAMES.has(parameter.name.toLowerCase()) ? [] : [parameter.name];
}

function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * A `link` header with each target scrubbed as a URL, a safe `rel` kept, and every other parameter's
 * value drawn again (Greptile on #192: a `title` kept a name), its name too where RFC 8288 does not
 * define it. One that does not parse is scrubbed as one string.
 */
function scrubLinkHeader(value: string, scrub: Scrubber): string {
  const entries = parseLinkHeader(value);
  if (entries === null) return scrub.string(value);
  return entries
    .map((entry) => {
      const parameters = entry.parameters.map((parameter) => {
        if (isSafeRelation(parameter)) return `; rel=${quoted(parameter.value ?? "")}`;
        const name = LINK_PARAMETER_NAMES.has(parameter.name.toLowerCase())
          ? parameter.name
          : scrub.string(parameter.name);
        if (parameter.value === null) return `; ${name}`;
        const drawn = scrub.string(parameter.value);
        return `; ${name}=${parameter.quoted ? quoted(drawn) : drawn}`;
      });
      return `<${scrub.string(entry.target)}>${parameters.join("")}`;
    })
    .join(", ");
}

function scrubHeader(name: string, value: string, scrub: Scrubber): string {
  if (name === "content-type") return value;
  if (name === "link") return scrubLinkHeader(value, scrub);
  return scrub.string(value);
}

function scrubResponse(
  response: RecordedResponse,
  scrub: Scrubber,
  seed: string,
): RecordedResponse {
  const headers = Object.fromEntries(
    Object.entries(response.headers).map(([name, value]) => [
      name,
      scrubHeader(name, value, scrub),
    ]),
  );
  const body = scrubBody(response.body, scrub, seed);
  return { status: response.status, headers, ...(body ? { body } : {}) };
}

/**
 * A request the module sent, with each value that came from an answer or the input (a path
 * segment, a query value, a JSON leaf of the body) replaced as it was there. The module's own
 * constants, `/api/conversations.history` or `limit=5`, are not such values and stay.
 */
function scrubRequestUrl(
  text: string,
  source: { strings: Set<string>; numbers: Set<number> },
  scrub: Scrubber,
): string {
  const url = new URL(text);
  const one = (raw: string): string => {
    if (source.strings.has(raw)) return scrub.string(raw);
    const asNumber = Number(raw);
    if (raw.trim() !== "" && source.numbers.has(asNumber)) return String(scrub.number(asNumber));
    return raw;
  };
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return segment;
      }
      const scrubbed = one(decoded);
      return scrubbed === decoded ? segment : encodeURIComponent(scrubbed);
    })
    .join("/");
  const params = [...url.searchParams.entries()];
  if (params.some(([, value]) => one(value) !== value)) {
    url.search = new URLSearchParams(params.map(([key, value]) => [key, one(value)])).toString();
  }
  return url.toString();
}

function scrubRequestBody(
  body: RecordedBody | undefined,
  source: { strings: Set<string>; numbers: Set<number> },
  scrub: Scrubber,
): RecordedBody | undefined {
  if (!body) return body;
  const leaf = (node: unknown): unknown => {
    if (typeof node === "string") return source.strings.has(node) ? scrub.string(node) : node;
    if (typeof node === "number") return source.numbers.has(node) ? scrub.number(node) : node;
    if (Array.isArray(node)) return node.map(leaf);
    if (isRecord(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, leaf(v)]));
    return node;
  };
  if ("json" in body) return { json: leaf(body.json) };
  if ("text" in body) return { text: leaf(body.text) as string };
  return body;
}

/** `scrub`, with a `ScrubFailure` it throws told where in the recording it happened. */
function within<T>(where: string, scrub: () => T): T {
  try {
    return scrub();
  } catch (error) {
    if (error instanceof ScrubFailure && error.where === undefined) {
      throw new ScrubFailure(error.reason, where);
    }
    throw error;
  }
}

/**
 * The recording with every vendor value scrubbed: the input, each read's answer (headers but the
 * content type, and the body), each request's values that came from an answer or the input, and the
 * result, every leaf of it, under one mapping. The build command then takes the requests and the
 * result from a second dry run over these answers (`record.ts`), so a value the module computed
 * rather than copied is the scrubbed data's too. Throws a `ScrubFailure` where it cannot.
 */
export function scrubRecording(recording: StockRecording, rule: ScrubRule): StockRecording {
  const source = { strings: new Set<string>(), numbers: new Set<number>() };
  collectLeaves(recording.input, source);
  for (const exchange of recording.exchanges) {
    if (exchange.kind === "read") {
      bodyLeaves(exchange.response.body, source);
      for (const [name, value] of Object.entries(exchange.response.headers)) {
        source.strings.add(value);
        if (name === "link") for (const piece of linkValuesOf(value)) source.strings.add(piece);
      }
    }
  }
  const avoid = { strings: new Set(source.strings), numbers: new Set(source.numbers) };
  collectLeaves(recording.result, avoid);
  const scrub = createScrubber(
    { ...rule, keep: [...(rule.keep ?? []), ...stringLeaves(rule.inputSchema, new Set())] },
    avoid,
    schemaNumbersOf(rule.inputSchema, new Set()),
  );

  // The input first, so its placeholders are drawn within its schema and an answer naming the same
  // value takes the same one.
  const input = within(
    "the input",
    () =>
      scrubInput(recording.input, rule.inputSchema, scrub, rule.seed) as Record<string, unknown>,
  );
  const exchanges = recording.exchanges.map((exchange, index) => {
    const request = `exchange ${index + 1}'s request`;
    if (exchange.kind === "read") {
      return {
        ...exchange,
        url: within(request, () => scrubRequestUrl(exchange.url, source, scrub)),
        response: within(`exchange ${index + 1}'s answer`, () =>
          scrubResponse(exchange.response, scrub, rule.seed),
        ),
      };
    }
    const body = within(request, () => scrubRequestBody(exchange.body, source, scrub));
    return {
      ...exchange,
      url: within(request, () => scrubRequestUrl(exchange.url, source, scrub)),
      ...(body ? { body } : {}),
    };
  });
  return {
    ...recording,
    input,
    exchanges,
    ...("result" in recording
      ? { result: within("the result", () => scrub.value(recording.result)) }
      : {}),
  };
}

/** Every string leaf of a JSON value. */
function stringLeaves(node: unknown, into: Set<string>): Set<string> {
  if (typeof node === "string") into.add(node);
  else if (Array.isArray(node)) for (const entry of node) stringLeaves(entry, into);
  else if (isRecord(node)) for (const entry of Object.values(node)) stringLeaves(entry, into);
  return into;
}

/**
 * What the scrub keeps as public code: every string the module's files spell, as the program reads
 * it (`@graft/check`'s `stringLiteralsOf`, a parse by the check's own TypeScript: string literals,
 * template text between and inside its `${…}`, escapes decoded; Greptile on #192), and every string
 * in its input schema, so an enum value or an example a test input names is not drawn again.
 */
export function keptLiteralsOf(
  files: readonly { path: string; content: string }[],
  inputSchema: unknown,
): string[] {
  const kept = stringLeaves(inputSchema, new Set<string>());
  for (const literal of stringLiteralsOf(files)) kept.add(literal);
  kept.delete("");
  return [...kept];
}

/** Every object key of a JSON value. */
function keysOf(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const entry of node) keysOf(entry, into);
  else if (isRecord(node)) {
    for (const [key, entry] of Object.entries(node)) {
      into.add(key);
      keysOf(entry, into);
    }
  }
  return into;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * A URL that is its scheme and host alone, which the scrub keeps as it keeps every URL's: written
 * with or without the closing slash, since its placeholder always carries one and would otherwise
 * read as the raw value surviving inside it (an app's `external_url` in a GitHub comment; GRA-253,
 * Greptile on #192).
 */
function isBareOrigin(value: string): boolean {
  const origin = urlPlaceholder(value);
  return origin === value || origin === `${value}/`;
}

/** The shortest value the survival check looks for: shorter ones collide with ordinary words. */
const SURVIVAL_MIN_LENGTH = 6;

/** A value's text between its redaction markers, each piece that holds a word. */
function unmarkedPieces(value: string): string[] {
  return value.split(MARKER).filter(hasWord);
}

/**
 * Where a value from the raw recording's input or answers is still to be found in the scrubbed one:
 * `input`, `exchange <n>` or `result`, never the value itself, since that is what must not be
 * printed. A value the module's source holds (`source`), a kept one, or a key is not looked for; a
 * value with a redaction marker is looked for as its text around the marker, and a `link` header as
 * its targets and parameters.
 * The build command's last check before it writes; an answer here means nothing is written.
 */
export function survivingValuesOf(
  raw: StockRecording,
  scrubbed: StockRecording,
  options: { source: string; keep?: Iterable<string> },
): string[] {
  const keep = new Set(options.keep ?? []);
  const keys = keysOf(raw, new Set<string>());
  const values = new Set<string>();
  const add = (value: string) => {
    for (const piece of unmarkedPieces(value)) values.add(piece);
  };
  for (const value of stringLeaves(raw.input, new Set<string>())) add(value);
  for (const exchange of raw.exchanges) {
    if (exchange.kind !== "read") continue;
    const body = exchange.response.body;
    if (body && "json" in body) for (const value of stringLeaves(body.json, new Set())) add(value);
    if (body && "text" in body) add(body.text);
    for (const [name, value] of Object.entries(exchange.response.headers)) {
      if (name === "link") for (const piece of linkValuesOf(value)) add(piece);
      else if (name !== "content-type") add(value);
    }
  }
  const sought = [...values].filter(
    (value) =>
      value.length >= SURVIVAL_MIN_LENGTH &&
      !keep.has(value) &&
      !keys.has(value) &&
      !options.source.includes(value) &&
      !isBareOrigin(value),
  );
  const parts: [string, unknown][] = [
    ["input", scrubbed.input],
    ...scrubbed.exchanges.map((exchange, index): [string, unknown] => [
      `exchange ${index + 1}`,
      exchange,
    ]),
    ["result", scrubbed.result ?? null],
  ];
  return parts
    .filter(([, part]) => {
      const leaves = [...stringLeaves(part, new Set<string>())].flatMap((leaf) => [
        leaf,
        decoded(leaf),
      ]);
      return sought.some((value) => leaves.some((leaf) => leaf.includes(value)));
    })
    .map(([where]) => where);
}
