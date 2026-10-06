import { BLOB_TTL_HOURS, BLOB_TTL_MS } from "@graft/runner";

/**
 * The rules every reader of a `blob` row shares, so the door, the sweep and the live-bytes read
 * cannot drift from one another (GRA-199; ADR 0023).
 */

/** How long a blob lives from its write (ADR 0023): the runner's figure, in milliseconds and in hours. */
export { BLOB_TTL_HOURS, BLOB_TTL_MS };

/**
 * Whether a blob whose row says it expires at `expiresAt` has expired at `now`. At the instant the
 * expiry arrives the blob is expired, `<=`: the door refuses its ref as `blob_expired`
 * (`packages/mcp/src/blob-door.ts`'s `judgeBlobRefs`), the sweep removes it on the same tick
 * (`blob-sweep.decision.ts`), and the live-bytes read stops counting it (`@graft/db`'s
 * `sumLiveBlobBytes`, whose SQL keeps the complement, `expires_at > now`, pinned in
 * `repo/scope.test.ts`). One predicate, so a ref the door refuses is never one the sweep keeps.
 */
export function isBlobExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
