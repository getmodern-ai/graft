import { createHmac } from "node:crypto";

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
 *  - booleans and `null`: one bit, and the bit a module branches on (`has_more`);
 *  - integers from 0 to 99: counts, pages and codes a module loops or branches on, naming no one;
 *  - a redaction marker (`[redacted…]`), whole or inside a string, so a reviewer still sees it;
 *  - a string with no letter or digit.
 */

export type ScrubRule = {
  /** Draws every placeholder. The same seed and recording give the same scrub. */
  seed: string;
  /** Strings to leave as they are: the module's literals and its schema's strings. */
  keep?: Iterable<string>;
};

const SMALL_INTEGER_LIMIT = 100;
const MARKER = /\[redacted[^\]]*\]/g;
const EMAIL = /^([^\s@]+)@[^\s@]+\.[A-Za-z]{2,}$/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const MAX_ATTEMPTS = 64;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
/** 2000-01-01 to 2030-01-01, the span a placeholder time is drawn from. */
const TIME_FROM = Date.UTC(2000, 0, 1);
const TIME_SPAN = Date.UTC(2030, 0, 1) - TIME_FROM;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

type Scrubber = {
  string(text: string): string;
  number(value: number): number;
  /** A JSON value, every leaf scrubbed. */
  value(value: unknown): unknown;
};

function createScrubber(rule: ScrubRule, avoid: { strings: Set<string>; numbers: Set<number> }) {
  const keep = new Set(rule.keep ?? []);
  const strings = new Map<string, string>();
  const numbers = new Map<number, number>();
  const used = new Set<string>();

  const string = (text: string): string => {
    if (keep.has(text) || text.startsWith("[redacted") || !/[\p{L}\d]/u.test(text)) return text;
    const known = strings.get(text);
    if (known !== undefined) return known;
    const url = urlPlaceholder(text);
    if (url !== null) {
      strings.set(text, url);
      return url;
    }
    let placeholder = text;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const next = draws(rule.seed, `s\u0000${text}\u0000${attempt}`);
      const email = EMAIL.exec(text);
      const iso = ISO.exec(text);
      placeholder = email
        ? `${substitute(email[1] as string, next)}@example.com`
        : iso
          ? isoPlaceholder(iso, next)
          : substituteAroundMarkers(text, next);
      if (placeholder !== text && !used.has(placeholder) && !avoid.strings.has(placeholder)) break;
    }
    strings.set(text, placeholder);
    used.add(placeholder);
    return placeholder;
  };

  const number = (value: number): number => {
    if (Number.isInteger(value) && value >= 0 && value < SMALL_INTEGER_LIMIT) return value;
    if (!Number.isFinite(value)) return value;
    const known = numbers.get(value);
    if (known !== undefined) return known;
    let placeholder = value;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      placeholder = numberPlaceholder(value, draws(rule.seed, `n\u0000${value}\u0000${attempt}`));
      if (
        placeholder !== value &&
        !used.has(`#${placeholder}`) &&
        !avoid.numbers.has(placeholder)
      ) {
        break;
      }
    }
    numbers.set(value, placeholder);
    used.add(`#${placeholder}`);
    return placeholder;
  };

  const value = (node: unknown): unknown => {
    if (typeof node === "string") return string(node);
    if (typeof node === "number") return number(node);
    if (Array.isArray(node)) return node.map(value);
    if (isRecord(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, value(v)]));
    return node;
  };

  return { string, number, value } satisfies Scrubber;
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

function scrubHeader(name: string, value: string, scrub: Scrubber): string {
  if (name === "content-type") return value;
  if (name === "link") {
    return value.replace(/<([^>]*)>/g, (_, url: string) => `<${scrub.string(url)}>`);
  }
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

/**
 * The recording with every vendor value scrubbed: the input, each read's answer (headers but the
 * content type, and the body), each request's values that came from an answer or the input, and the
 * result, every leaf of it, under one mapping. The build command then takes the requests and the
 * result from a second dry run over these answers (`record.ts`), so a value the module computed
 * rather than copied is the scrubbed data's too.
 */
export function scrubRecording(recording: StockRecording, rule: ScrubRule): StockRecording {
  const source = { strings: new Set<string>(), numbers: new Set<number>() };
  collectLeaves(recording.input, source);
  for (const exchange of recording.exchanges) {
    if (exchange.kind === "read") {
      bodyLeaves(exchange.response.body, source);
      for (const value of Object.values(exchange.response.headers)) source.strings.add(value);
    }
  }
  const avoid = { strings: new Set(source.strings), numbers: new Set(source.numbers) };
  collectLeaves(recording.result, avoid);
  const scrub = createScrubber(rule, avoid);

  // The answers first, then the input, so the mapping is the same whichever a value appeared in.
  const exchanges = recording.exchanges.map((exchange) =>
    exchange.kind === "read"
      ? {
          ...exchange,
          url: scrubRequestUrl(exchange.url, source, scrub),
          response: scrubResponse(exchange.response, scrub, rule.seed),
        }
      : (() => {
          const body = scrubRequestBody(exchange.body, source, scrub);
          return {
            ...exchange,
            url: scrubRequestUrl(exchange.url, source, scrub),
            ...(body ? { body } : {}),
          };
        })(),
  );
  return {
    ...recording,
    input: scrub.value(recording.input) as Record<string, unknown>,
    exchanges,
    ...("result" in recording ? { result: scrub.value(recording.result) } : {}),
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
 * What the scrub keeps as public code: every string literal in the module's files (a template
 * literal's text between its `${…}`) and every string in its input schema, so an enum value or an
 * example a test input names is not drawn again.
 */
export function keptLiteralsOf(
  files: readonly { content: string }[],
  inputSchema: unknown,
): string[] {
  const kept = stringLeaves(inputSchema, new Set<string>());
  const literal = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const file of files) {
    for (const match of file.content.matchAll(literal)) {
      const [, double, single, template] = match;
      const pieces =
        template !== undefined ? template.split(/\$\{[^}]*\}/) : [double ?? single ?? ""];
      for (const piece of pieces) {
        const text = piece.replace(/\\(.)/g, "$1");
        if (text !== "") kept.add(text);
      }
    }
  }
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

/** The shortest value the survival check looks for: shorter ones collide with ordinary words. */
const SURVIVAL_MIN_LENGTH = 6;

/**
 * Where a value from the raw recording's input or answers is still to be found in the scrubbed one:
 * `input`, `exchange <n>` or `result`, never the value itself, since that is what must not be
 * printed. A value the module's source holds (`source`), a kept one, or a key is not looked for.
 * The build command's last check before it writes; an answer here means nothing is written.
 */
export function survivingValuesOf(
  raw: StockRecording,
  scrubbed: StockRecording,
  options: { source: string; keep?: Iterable<string> },
): string[] {
  const keep = new Set(options.keep ?? []);
  const keys = keysOf(raw, new Set<string>());
  const values = stringLeaves(raw.input, new Set<string>());
  for (const exchange of raw.exchanges) {
    if (exchange.kind !== "read") continue;
    const body = exchange.response.body;
    if (body && "json" in body) stringLeaves(body.json, values);
    if (body && "text" in body) values.add(body.text);
    for (const [name, value] of Object.entries(exchange.response.headers)) {
      if (name !== "content-type") values.add(value);
    }
  }
  const sought = [...values].filter(
    (value) =>
      value.length >= SURVIVAL_MIN_LENGTH &&
      !value.startsWith("[redacted") &&
      !keep.has(value) &&
      !keys.has(value) &&
      !options.source.includes(value) &&
      urlPlaceholder(value) !== value,
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
