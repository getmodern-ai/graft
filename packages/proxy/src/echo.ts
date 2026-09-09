import type { CredentialFields } from "./types";

/**
 * A vendor that reflects the credential — into a response header, or into a body: a 401 whose
 * message quotes the key it did not like, a debug endpoint that echoes the request, an error page.
 * The proxy is the only component holding the plaintext at injection time (GRA-1, "The core and
 * its seams": decrypted in exactly one component), so it is the only one that can redact by
 * *value*; everything downstream — the runner's report, `acquire`'s trace (ADR 0012) — can redact
 * only by shape, and a key of an unrecognised shape would otherwise reach the sandbox and the trace
 * verbatim. So the response leg does it here, once, for headers and text-like bodies alike, and
 * says so: `x-graft-redacted: credential` on the response and `credentialEchoed` on the wide event.
 *
 * Text-like is decided by the vendor's `content-type` — JSON, text, XML, HTML, a form, JavaScript,
 * and their `+json`/`+xml` structured suffixes — with a body that declares no type treated as text
 * when it decodes as UTF-8. Anything else — an image, an archive, a PDF — passes through untouched:
 * a byte sequence in a binary body that happens to spell a key is not an echo, and rewriting it
 * would corrupt the file. Values shorter than `MIN_REDACTABLE_LENGTH` are not redacted: they would
 * match ordinary text, and a real key is far longer.
 */

/** What an echoed credential value is replaced with, in a header or a body. One marker, one meaning. */
export const CREDENTIAL_REDACTED = "[redacted:credential]";

/** Set on a response the proxy changed on the way back; absent on one it did not. */
export const REDACTED_HEADER = "x-graft-redacted";
export const REDACTED_CREDENTIAL = "credential";

/** Shorter credential values would match header or body text by accident; a real key is far longer. */
export const MIN_REDACTABLE_LENGTH = 8;

/**
 * Every value a vendor could have seen and echoed: the stored credential's fields, the derived wire
 * credential's (an access token, a signed JWT), and for basic auth the base64 pair the header
 * actually carries — a vendor echoing `Authorization: Basic …` echoes that, not the password.
 */
export function echoableSecrets(credential: CredentialFields, wire: CredentialFields): string[] {
  const values = new Set<string>();
  for (const source of [credential, wire]) {
    for (const value of Object.values(source)) {
      if (typeof value === "string" && value.length >= MIN_REDACTABLE_LENGTH) values.add(value);
    }
  }
  const { username, password } = credential;
  if (typeof username === "string" && typeof password === "string") {
    const pair = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    if (pair.length >= MIN_REDACTABLE_LENGTH) values.add(pair);
  }
  return [...values];
}

/** Media types read as text beyond `text/*`: the structured ones a vendor answers an API call with. */
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "application/javascript",
  "application/ecmascript",
  "application/xhtml+xml",
  "application/graphql",
  "application/problem+json",
]);

/**
 * Whether a body is one the redaction may rewrite. By declared type first; a body with no type is
 * text when it decodes as UTF-8 — the fatal decoder refuses binary at the first invalid sequence.
 */
export function isTextLike(contentType: string | null, bytes: Uint8Array): boolean {
  const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media === "") {
    if (bytes.byteLength === 0) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  if (media.startsWith("text/")) return true;
  if (media.endsWith("+json") || media.endsWith("+xml")) return true;
  return TEXT_MEDIA_TYPES.has(media);
}

function replaceAll(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join(CREDENTIAL_REDACTED), text);
}

/**
 * The response headers, minus any echoed value, in place. `set-cookie` is handled through
 * `getSetCookie` because it is the one header that may legitimately appear more than once. Answers
 * whether anything changed.
 */
export function redactHeaderEchoes(headers: Headers, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  let changed = false;
  const cookies = headers.getSetCookie();
  for (const [name, value] of [...headers.entries()]) {
    if (name === "set-cookie") continue;
    const clean = replaceAll(value, secrets);
    if (clean !== value) {
      headers.set(name, clean);
      changed = true;
    }
  }
  if (cookies.some((cookie) => replaceAll(cookie, secrets) !== cookie)) {
    headers.delete("set-cookie");
    for (const cookie of cookies) headers.append("set-cookie", replaceAll(cookie, secrets));
    changed = true;
  }
  return changed;
}

/**
 * The body, minus any echoed value — the same bytes back when it is not text-like or nothing
 * matched, so a binary body is never re-encoded. A text-like body is decoded leniently (its type
 * said text; a stray invalid byte is the vendor's), rewritten, and re-encoded as UTF-8.
 */
export function redactBodyEchoes(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string | null,
  secrets: readonly string[],
): { bytes: Uint8Array<ArrayBuffer>; changed: boolean } {
  if (secrets.length === 0 || bytes.byteLength === 0 || !isTextLike(contentType, bytes)) {
    return { bytes, changed: false };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  const clean = replaceAll(text, secrets);
  if (clean === text) return { bytes, changed: false };
  const encoded = new TextEncoder().encode(clean);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return { bytes: out, changed: true };
}
