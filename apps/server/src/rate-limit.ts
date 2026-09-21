import { createHash } from "node:crypto";

import type { SessionLike } from "@graft/core";
import { type RateLimitBucket, type RateLimiter, UNLIMITED } from "@graft/ratelimit";
import { useLogger } from "evlog/hono";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The server's half of the rate-limit seam (GRA-149): one Hono middleware, one key per door, and
 * the refusal each door already speaks. `@graft/ratelimit` holds the interface, the bucket
 * vocabulary and the open form's in-process backing; this file holds everything that is a fact
 * about *this* server's doors, which is why the seam package does not import Hono.
 *
 * **Unlimited is the default in both forms.** `UNLIMITED` is compared by identity below and the
 * middleware returns before it does any work at all, so a self-host that set no `GRAFT_RATE_LIMIT_*`
 * variable pays one pointer comparison per request and never resolves a session or reads an
 * address it would not otherwise have read.
 *
 * **A refusal happens before the handler.** Nothing downstream runs: no approval is recorded
 * against the person, no tool call is counted against the agent's working set, no vendor is
 * reached. What the caller gets is 429 with `Retry-After`, in the body shape of the door it
 * knocked on, and the wide event gains `rateLimited` so `docker compose logs graft` says which
 * bucket and which key.
 */

/**
 * What a door counts on. Two strings rather than one because the key and the line are different
 * promises: `key` is what the backing compares, and `logged` is what an operator is allowed to
 * read back. They are the same string for an id the wide event already carries (a person, an
 * agent, a connection) and they differ for a client address, which is nobody's business at rest.
 */
export type RateLimitKey = { key: string; logged: string };

/** A person, an agent or a connection: the event already names these, so the line may too. */
export function identifiedKey(prefix: string, id: string): RateLimitKey {
  const key = `${prefix}:${id}`;
  return { key, logged: key };
}

/**
 * A caller's address. The limiter needs the address itself to count it; the log line gets a short
 * digest instead, so a rate-limit line in a container's log is not a record of who visited from
 * where. The digest is stable within a deployment, which is all an operator needs to see one
 * caller across many lines.
 */
export function addressKey(address: string): RateLimitKey {
  return { key: `addr:${address}`, logged: `addr:${digest(address)}` };
}

/** Twelve hex characters of SHA-256: enough to tell callers apart, not enough to walk back. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** What every door is handed: the backing, and how to believe an address behind a proxy. */
export type RateLimiting = {
  limiter: RateLimiter;
  /** `GRAFT_TRUSTED_PROXY_HOPS`; 0, the default, means `X-Forwarded-For` is never read. */
  trustedProxyHops: number;
};

/** The default, and what a harness that binds nothing gets: every door open. */
export const NO_RATE_LIMITING: RateLimiting = { limiter: UNLIMITED, trustedProxyHops: 0 };

/**
 * Where the request came from, or null when this process cannot tell.
 *
 * The socket's peer address unless the operator said how many proxies are in front, because
 * `X-Forwarded-For` is a header and anyone may send one: read unasked, it would let a single
 * caller spend a hundred other addresses' allowances, or none of its own, by writing a different
 * value each time. With `GRAFT_TRUSTED_PROXY_HOPS=n` the caller's entry is the `n`-th from the
 * right, one appended by each trusted hop; a header with fewer entries than that did not come
 * through the hops the operator described, so it is not believed and the socket answers instead.
 *
 * Null when there is no socket to ask, which is a Hono app driven by `app.request()` in a suite.
 * A door with no key does not limit: a limiter that refused everything it could not identify
 * would be a way to take the server down, and the failure direction here is availability.
 */
export function clientAddressOf(c: Context, trustedProxyHops: number): string | null {
  if (trustedProxyHops > 0) {
    const entries = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const claimed = entries[entries.length - trustedProxyHops];
    if (claimed) return claimed;
  }
  return socketAddressOf(c);
}

/**
 * The peer address `@hono/node-server` puts on the context (its own `getConnInfo` reads the same
 * three properties). Read defensively rather than imported, because the bindings are absent under
 * `app.request()` and a missing address is an answer here, not a crash.
 */
function socketAddressOf(c: Context): string | null {
  const bindings = c.env as { server?: unknown; incoming?: unknown } | undefined;
  const node = (bindings?.server ?? bindings) as
    | { incoming?: { socket?: { remoteAddress?: unknown } } }
    | undefined;
  const address = node?.incoming?.socket?.remoteAddress;
  return typeof address === "string" && address.length > 0 ? address : null;
}

/** The body a refusal answers with; the door decides which, since the door's callers read one shape. */
export type RateLimitRefusalBody = (message: string) => Record<string, string>;

/**
 * The JSON API's shape, `{ error, message }` (`api.ts`'s `onError`), which the console's one
 * `fetch` turns into an `ApiError` like any other. `TOO_MANY_REQUESTS` is not a `ServiceErrorCode`
 * on purpose: this is refused before a service is called, and the core's vocabulary is for what
 * its services decide.
 */
export const apiRefusalBody: RateLimitRefusalBody = (message) => ({
  error: "TOO_MANY_REQUESTS",
  message,
});

/**
 * The proxy's shape, `{ error, reason, message }` (`packages/proxy/src/failure.ts`), which the MCP
 * endpoint's own refusals share so an agent's code reads one vocabulary from both doors. Written
 * here rather than through `refusalBody` because the refusal is made in front of both apps: the
 * call never becomes a `ProxyOutcome`, and adding a word to that enum for something the proxy
 * never records would be a lie in the audit trail's vocabulary.
 */
export const proxyRefusalBody: RateLimitRefusalBody = (message) => ({
  error: "too_many_requests",
  reason: "rate_limited",
  message,
});

/**
 * The OAuth endpoints' shape, RFC 6749 §5.2's `{ error, error_description }` (`mcp-oauth.ts`).
 * `temporarily_unavailable` is §4.1.2.1's word and the closest the registry has to "later, not
 * never"; the 429 and the `Retry-After` are what a client actually acts on.
 */
export const oauthRefusalBody: RateLimitRefusalBody = (message) => ({
  error: "temporarily_unavailable",
  error_description: message,
});

export type RateLimitOptions = {
  /** Default `apiRefusalBody`; a door whose callers read another shape names its own. */
  body?: RateLimitRefusalBody;
};

/**
 * One door. `keyOf` answers the key this request counts against, or null for a request this door
 * does not limit at all: a read under a bucket that guards mutations, a path that names no
 * connection, a caller with no address.
 */
export function rateLimit(
  limiter: RateLimiter,
  bucket: RateLimitBucket,
  keyOf: (c: Context) => RateLimitKey | null | Promise<RateLimitKey | null>,
  options: RateLimitOptions = {},
): MiddlewareHandler {
  const body = options.body ?? apiRefusalBody;
  return async (c, next) => {
    if (limiter === UNLIMITED) return next();
    const key = await keyOf(c);
    if (!key) return next();
    // A backing that cannot answer lets the request through: a store's hiccup must not close a
    // door. The same reason `clientAddressOf` answering null does not refuse.
    const verdict = await limiter
      .check({ bucket, key: key.key, now: new Date() })
      .catch(() => ({ allowed: true }) as const);
    if (verdict.allowed) return next();
    noteRefusal(bucket, key.logged);
    const seconds = verdict.retryAfterSeconds;
    return c.body(
      JSON.stringify(body(`Too many requests. Try again in ${seconds} second(s).`)),
      429,
      { "content-type": "application/json", "retry-after": String(seconds) },
    );
  };
}

/**
 * The refusal on the request's wide event, beside the proxy's and the MCP hook's own fields
 * (GRA-100). Guarded because a middleware mounted outside `evlog()` has no event open, which is
 * every bare Hono app a suite builds: a refusal still reaches the caller, and only the line is
 * lost.
 */
function noteRefusal(bucket: RateLimitBucket, key: string): void {
  try {
    useLogger().set({ rateLimited: { bucket, key } });
  } catch {
    // No wide event open.
  }
}

/**
 * The `sign_in` door: every `POST` under `/api/auth/*` but the sign-out, keyed by the caller's
 * address.
 *
 * By method rather than by a list of Better Auth's own path names, because those names are the
 * library's to rename and a list that quietly stopped matching would be a limit that quietly
 * stopped applying. Every `POST` there is a password hash, an email or a token check; the reads
 * (`get-session`, which the console holds open) are `GET` and untouched, and `sign-out` is a
 * person's own action on a session they already have.
 */
export function signInDoorKey(limiting: RateLimiting) {
  return (c: Context): RateLimitKey | null => {
    if (c.req.method !== "POST") return null;
    if (/\/auth\/sign-out\/?$/.test(c.req.path)) return null;
    const address = clientAddressOf(c, limiting.trustedProxyHops);
    return address ? addressKey(address) : null;
  };
}

/** The two OAuth doors, each keyed by the caller's address: no person has been named yet. */
export function addressDoorKey(limiting: RateLimiting) {
  return (c: Context): RateLimitKey | null => {
    const address = clientAddressOf(c, limiting.trustedProxyHops);
    return address ? addressKey(address) : null;
  };
}

/**
 * The `mcp` door, keyed by the caller's address, presented bearer or not.
 *
 * **Never by the bearer.** This check runs before `requireAgent`, which is the point of it: an
 * unknown `grft_` or `grfta_` value still costs a database read, and that read is what the door
 * is here to ration. A key derived from the token would be a key the caller picks, so a caller
 * sending a different invented bearer each time would get a fresh allowance per request and pay
 * for none of them, while every one of those requests still reached the read. The address is the
 * one thing about a pre-authentication request the caller does not choose (`clientAddressOf`).
 *
 * The consequence, and an operator's to weigh: every agent behind one address shares one
 * allowance, so a chat product whose egress is a handful of addresses counts all of its people
 * together. A per-agent count would have to sit *after* `requireAgent`, inside `@graft/mcp`,
 * where it no longer saves the read; the bucket that pays for itself is this one. Unlimited
 * remains the default.
 */
export function mcpDoorKey(limiting: RateLimiting) {
  return addressDoorKey(limiting);
}

/**
 * The connection a proxy call names, out of `/api/proxy/c/<id>/...` (`proxyPathFor` in
 * `@graft/proxy`). Null for `/api/proxy/.well-known/jwks.json`, a cached read that names none.
 */
const PROXY_CONNECTION = /^\/api\/proxy\/c\/([^/]+)/;

/** The `proxy` door: a connection's own allowance, since a sandbox's calls are a connection's calls. */
export function proxyDoorKey() {
  return (c: Context): RateLimitKey | null => {
    const segment = PROXY_CONNECTION.exec(c.req.path)?.[1];
    return segment ? identifiedKey("connection", decodedSegment(segment)) : null;
  };
}

/**
 * A path segment percent-decoded, or as it was spelled when it does not decode. The fallback is
 * not cosmetic: `decodeURIComponent` throws on a lone or truncated escape (`%E0%A4%A`), and a
 * throw here would replace the proxy's own `bad_connection_id` refusal with a 500 from a
 * middleware the caller never addressed. `decodeHostSegment` in `packages/proxy/src/app.ts` is
 * the same rule for the same reason, one rung further in.
 */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The `api` door: a session-authenticated mutation, keyed by the person.
 *
 * Reads are not counted, `/api/auth/*` is the `sign_in` bucket's, and a request with no session is
 * not counted either: the route will refuse it in a line, and the doors that are worth guarding
 * before anyone signs in have buckets of their own. The session is resolved a second time here,
 * the same extra read the analytics middleware makes (`api.ts`), and only when a limit is actually
 * configured, since the middleware returns before this runs under `UNLIMITED`.
 */
const API_MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function apiDoorKey(getSession: (headers: Headers) => Promise<SessionLike>) {
  return async (c: Context): Promise<RateLimitKey | null> => {
    if (!API_MUTATIONS.has(c.req.method)) return null;
    if (/^(\/api)?\/auth(\/|$)/.test(c.req.path)) return null;
    const session = await getSession(c.req.raw.headers).catch(() => null);
    const personId = session?.user.id;
    return personId ? identifiedKey("person", personId) : null;
  };
}
