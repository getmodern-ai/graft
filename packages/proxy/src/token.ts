/**
 * Where a capability token may ride, which inbound headers are stripped before a request is
 * forwarded, and how the token itself is kept off the wire.
 *
 * The token is accepted wherever an SDK would put an API key, because an authored module is written
 * against the vendor's SDK and told only "the base URL is the proxy, the key is this token" — the
 * token *is* the placeholder credential ADR 0010 describes. Five positions, tried in this order:
 * `Authorization: Bearer <t>`, `Authorization: Basic base64(<t>:)` or `base64(:<t>)` — an SDK
 * that sends its key as one half of a basic pair — a raw `Authorization: <t>`, `x-api-key`, and
 * the proxy's own `x-graft-token`. An `Authorization` carrying some *other* credential (a basic
 * pair with both halves filled) is not a token and falls through to the next position — the
 * vendor's basic credentials are the proxy's to add, never the caller's to send. The query string
 * is deliberately not a position: a bearer credential in a URL is logged by every intermediary,
 * so an SDK that can only send its key as a query parameter takes the hand-written path.
 */

const BEARER = /^bearer\s+(\S+)\s*$/i;
const BASIC = /^basic\s+([A-Za-z0-9+/=_-]+)\s*$/i;

/** The three header names a token is read from, lowercased as `Headers` reports them. */
export const TOKEN_HEADERS = ["authorization", "x-api-key", "x-graft-token"] as const;

export function extractToken(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (authorization) {
    const bearer = BEARER.exec(authorization);
    if (bearer?.[1]) return bearer[1];
    const basic = basicToken(authorization);
    if (basic) return basic;
    // A raw token has no whitespace; anything with a space is another scheme's credential.
    if (!/\s/.test(authorization)) return authorization;
  }
  for (const name of ["x-api-key", "x-graft-token"] as const) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * A basic pair with exactly one half filled is the token in that half; a pair with both halves is
 * somebody's real basic credential, which is not a token and is stripped like any other.
 */
function basicToken(authorization: string): string | null {
  const match = BASIC.exec(authorization);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const user = decoded.slice(0, colon).trim();
  const password = decoded.slice(colon + 1).trim();
  const candidate = user && !password ? user : !user && password ? password : null;
  return candidate && !/\s/.test(candidate) ? candidate : null;
}

/**
 * Every inbound header that carries or could carry a credential, removed before forwarding. The
 * three token positions, the proxy-auth pair, and cookies — a sandbox has no business sending a
 * cookie to a vendor, and one that did would be forwarding something it should not hold. A scheme
 * plugin *sets* the header it owns after this pass, so a caller cannot smuggle a second value in
 * beside the injected one either.
 */
export const INBOUND_AUTH_HEADERS = [
  "authorization",
  "proxy-authorization",
  "proxy-authenticate",
  "x-api-key",
  "x-graft-token",
  "cookie",
] as const;

/**
 * The token itself removed from wherever else it rode. An SDK constructed with the token as its
 * API key (ADR 0010) puts it wherever that SDK puts a key: one of the named positions above, which
 * `forwardableRequestHeaders` has already stripped, or a header or query parameter the proxy has
 * no name for — `apikey`, `x-auth-token`, `?key=`. This is the by-value sweep behind the by-name
 * strip: any remaining header whose value contains the token, and any query parameter whose value
 * does, is dropped, so the token reaches no vendor whatever position it was given. The scheme
 * plugin then sets its own header or parameter, and a parameter the sweep removed under the
 * scheme's own name is simply replaced by the real credential. The query is rewritten only when a
 * hit was found, so the common case keeps the caller's encoding byte for byte.
 */
export function scrubToken(headers: Headers, url: URL, token: string): void {
  for (const [name, value] of [...headers.entries()]) {
    if (value.includes(token)) headers.delete(name);
  }
  const hits = [...url.searchParams].filter(([, value]) => value.includes(token));
  for (const [name, value] of hits) url.searchParams.delete(name, value);
}
