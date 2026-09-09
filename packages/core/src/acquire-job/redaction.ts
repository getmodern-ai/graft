import type { ConnectionScheme } from "@graft/db/schema/connection";
import { SCHEME_CREDENTIAL_FIELDS, SCHEME_OPTIONAL_CREDENTIAL_FIELDS } from "@graft/proxy";

/**
 * Redaction for what an `acquire` job records (ADR 0012: every vendor error body is stored with
 * credentials redacted) — one pure function, applied to every trace line and every payload before
 * it is written, so there is one place to argue about what counts as a secret.
 *
 * **The job never holds the connection's credential**, by design: a stored credential is decrypted
 * in exactly one place, the proxy's binding (GRA-6, `apps/server/src/app.ts`), and the job is not
 * it. So a credential's *value* is not something this function can be handed, and the redaction
 * works from what the job does know and from shape:
 *
 *  - the values the job does hold — the capability tokens it minted for its runs, which a module
 *    can print (`ctx.proxyKey`) and a proxy refusal can echo;
 *  - any `Authorization` header value, and any `Bearer`/`Basic` credential wherever it appears;
 *  - any string shaped like the capability token — a JWT, `eyJ…`;
 *  - the value of any field the connection's scheme names as secret (`SCHEME_CREDENTIAL_FIELDS`,
 *    the table the proxy reads) and of the header or query parameter the scheme carries the key in,
 *    plus the generic names a vendor echoes a key under, wherever `name: value`, `name=value` or
 *    `"name": "value"` appears;
 *  - a table of well-known key shapes — Stripe's, Slack's, GitHub's, AWS's, Google's, Linear's,
 *    GitLab's, and a PEM private key — for a vendor that echoes the raw key in prose, which the
 *    field-name rule cannot see.
 *
 * The last two are best-effort by construction: a vendor that echoes a key of an unrecognised shape
 * under no field name gets through. That is the limit of redacting without the value, and the
 * reason the value is not fetched to close it: a decrypt on the job's path would be a second place a
 * credential becomes plaintext, which is the property GRA-6 chose to keep.
 */

export const REDACTED = "[redacted]";

export type RedactionRule = {
  /** Values the job knows to be secret — its capability tokens. Short values are ignored (see `MIN_SECRET_LENGTH`). */
  secretValues?: readonly string[];
  /** Field, header and parameter names whose values are secret, beside the generic set. */
  secretFieldNames?: readonly string[];
};

/** A "secret" shorter than this is not redacted by value: it would match ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** Names a vendor or a proxy echoes a credential under, whatever the scheme. Compared case-insensitively. */
export const GENERIC_SECRET_FIELD_NAMES: readonly string[] = [
  "apiKey",
  "api_key",
  "apikey",
  "x-api-key",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "password",
  "secret",
  "privateKey",
  "private_key",
  "proxyKey",
  "authorization",
];

/** Key shapes worth recognising in prose. Each is anchored on a word boundary and needs a tail long enough not to be a word. */
const KEY_SHAPES: readonly RegExp[] = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9_]{8,}/g, // Stripe secret and restricted keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\blin_api_[A-Za-z0-9]{20,}/g, // Linear
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** The capability token's shape — a compact JWT — and any other JWT, which is a credential too. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/** `Bearer <token>` and `Basic <base64>` wherever they appear — an echoed header, a log line. */
const HTTP_CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** The scheme word of an `Authorization` value, which the field pass must not take for the credential. */
const AUTH_SCHEME_WORD = /^(?:Bearer|Basic|Digest|Token)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `name: value`, `name = value`, `"name": "value"`, `name=value` (a query string), with the value
 * running to the next delimiter — a quote, a comma, a semicolon, a closing brace, an ampersand, a
 * line end. The name is matched whole and case-insensitively; the value is replaced, the name kept,
 * so a reader still sees *which* field was redacted.
 */
function fieldPattern(names: readonly string[]): RegExp | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  const alternatives = unique.map(escapeRegExp).join("|");
  return new RegExp(
    `((?:^|[^A-Za-z0-9_-])["']?(?:${alternatives})["']?\\s*[:=]\\s*["']?)([^"'\\s,;}&]+)`,
    "gi",
  );
}

/**
 * Redact one string. Answers the text and whether anything changed, so the row can say so
 * (`acquire_trace.redacted`).
 */
export function redactText(
  text: string,
  rule: RedactionRule = {},
): { text: string; redacted: boolean } {
  let out = text;

  for (const secret of rule.secretValues ?? []) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTED);
  }

  out = out.replace(JWT, REDACTED);
  out = out.replace(HTTP_CREDENTIAL, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED);

  const fields = fieldPattern([...GENERIC_SECRET_FIELD_NAMES, ...(rule.secretFieldNames ?? [])]);
  if (fields) {
    out = out.replace(fields, (match: string, lead: string, value: string) => {
      // Already redacted by an earlier pass, or an auth scheme word whose credential the
      // `HTTP_CREDENTIAL` pass has dealt with — `authorization: Bearer [redacted]` stays readable.
      if (value.startsWith(REDACTED) || AUTH_SCHEME_WORD.test(value)) return match;
      return `${lead}${REDACTED}`;
    });
  }

  return { text: out, redacted: out !== text };
}

/**
 * Redact every string inside a JSON value — a dry-run report, an error body already parsed, a
 * check's diagnostics — leaving its shape and its keys alone. Keys are not redacted: a key is a
 * name, and the name of a secret field is what tells a reader a value was there.
 */
export function redactValue<T>(
  value: T,
  rule: RedactionRule = {},
): { value: T; redacted: boolean } {
  let redacted = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const result = redactText(node, rule);
      redacted ||= result.redacted;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return node;
  };
  return { value: walk(value) as T, redacted };
}

/**
 * The field names a connection's scheme makes secret: the credential fields the proxy reads
 * (`@graft/proxy`'s table), and the header or query parameter the scheme carries the key in, since
 * a vendor error echoing the request echoes it under that name.
 */
export function secretFieldNamesFor(
  scheme: ConnectionScheme,
  schemeConfig: Record<string, unknown> | null | undefined,
): string[] {
  const names = [
    ...SCHEME_CREDENTIAL_FIELDS[scheme],
    ...(SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? []),
  ];
  for (const key of ["headerName", "queryParam"]) {
    const value = schemeConfig?.[key];
    if (typeof value === "string" && value.trim()) names.push(value.trim());
  }
  return [...new Set(names)];
}
