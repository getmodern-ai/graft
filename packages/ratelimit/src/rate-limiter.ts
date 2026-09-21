/**
 * The rate-limit seam (GRA-149; ADR 0002 as amended 2026-09-19): what a door asks before it lets a
 * request through, knowing nothing of any vendor and nothing of where a count is kept.
 *
 * **Unlimited is the decision, not an oversight.** The open, self-hosted form ships with
 * `UNLIMITED` behind this seam and stays there until an operator sets a `GRAFT_RATE_LIMIT_*`
 * variable; the hosted form sets its own numbers, high, from the private backings package. ADR 0018
 * is what asked for the seam: open dynamic client registration is an unauthenticated write, and
 * "the mitigation when it is needed is a rate limit at the edge, not a change to the protocol".
 *
 * **Its own package rather than a module of `@graft/observability`.** The three observability
 * seams observe and never change an answer; this one refuses. Putting a seam that can turn a
 * request into a 429 behind the same import as the drain that records it would make a dependency
 * on "observability" a dependency on being refused, and the boot line would have to explain why
 * `logs stdout, analytics off` also decides who gets in. So: same shape (a plain interface, a name
 * for the boot line, a no-op that is exactly the absence of the feature), separate package.
 *
 * The open backing lives beside this file (`memory.ts`); `apps/server/src/rate-limit.ts` is the
 * Hono middleware and the key each door uses, since a door is the server's and not the seam's.
 */

/**
 * The doors, one bucket each. A fixed vocabulary, because a bucket is a promise to an operator:
 * every bucket has a `GRAFT_RATE_LIMIT_*` variable (`packages/env/src/schema.ts`), a policy entry
 * (`RateLimitPolicy` below) and a mount (`apps/server/src/rate-limit.ts`), and the three are held
 * together by this list being total in each of them.
 */
export const RATE_LIMIT_BUCKETS = [
  /** Better Auth under `/api/auth/*`: sign-in, sign-up, password reset, verification resend. */
  "sign_in",
  /** `POST /mcp/oauth/register`: dynamic client registration, which is open by protocol (ADR 0018). */
  "oauth_register",
  /** `POST /mcp/oauth/token`: the two grants, each a credential check. */
  "oauth_token",
  /** `POST /mcp`: a harness's or a chat product's whole conversation with Graft. */
  "mcp",
  /** `/api/proxy/*`: a sandbox's vendor calls, the one route out (ADR 0010). */
  "proxy",
  /** The JSON API's mutations, for a person who already has a session. */
  "api",
] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/**
 * Allowed, or refused with the whole seconds the caller should wait. `retryAfterSeconds` is what
 * goes on `Retry-After`, so a backing answers at least 1: a header of 0 tells a client to retry now,
 * which is what it just did.
 */
export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type RateLimitCheck = {
  bucket: RateLimitBucket;
  /**
   * What the bucket counts: a person, an agent, a connection, or a client address where nobody has
   * authenticated yet (`apps/server/src/rate-limit.ts` mints them). Opaque here; a backing only
   * ever compares it.
   */
  key: string;
  /** The clock is the caller's, so a suite drives a window without waiting for one. */
  now: Date;
};

export type RateLimiter = {
  /** The name the boot line carries: the backing's, or `off`. */
  name: string;
  /**
   * Fail open on the backing's own trouble: a limiter that cannot answer must let the request
   * through rather than close a door on a store's hiccup. A backing that throws is the middleware's
   * problem to survive, not the caller's to see.
   */
  check(input: RateLimitCheck): Promise<RateLimitVerdict>;
};

/**
 * No backing: every request is allowed, nothing is counted, nothing is held in memory. The default
 * in both forms, and what a self-host that sets no `GRAFT_RATE_LIMIT_*` variable runs with. The
 * middleware compares against this object by identity to skip the key work entirely, so the
 * default costs a pointer comparison per request.
 */
export const UNLIMITED: RateLimiter = {
  name: "off",
  check: async () => ({ allowed: true }),
};
