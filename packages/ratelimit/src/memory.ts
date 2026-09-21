import type {
  RateLimitBucket,
  RateLimitCheck,
  RateLimiter,
  RateLimitVerdict,
} from "./rate-limiter";

/**
 * The open form's backing: a token bucket per key, held in this process and nowhere else. It is
 * what a self-hoster switches on with the `GRAFT_RATE_LIMIT_*` group, and it is off until they do
 * (`UNLIMITED` is the default; ADR 0002 as amended 2026-09-19).
 *
 * **In this process and nowhere else** is the honest bound on it. One server behind one address is
 * exactly what it protects; two replicas behind a load balancer each hold their own counts, so the
 * effective limit is the configured one times the number of replicas. A deployment that needs one
 * shared count across replicas writes a backing against `RateLimiter` with a store of its own,
 * which is what the seam is for, and the hosted form does exactly that from its private package.
 *
 * A token bucket rather than a window of timestamps: constant memory per key, a burst up to the
 * limit, and a refill that is smooth rather than a cliff at the top of the minute, which is where
 * a fixed window lets twice the limit through across the boundary.
 */

/** One bucket's rule: `limit` requests per `windowSeconds`, refilled continuously over the window. */
export type BucketPolicy = { limit: number; windowSeconds: number };

/**
 * Every bucket's rule, or `null` for one this deployment does not limit. Total on
 * `RateLimitBucket`, so a bucket added to the vocabulary has to be given a policy here, and in the
 * environment that builds one, before this compiles.
 */
export type RateLimitPolicy = Readonly<Record<RateLimitBucket, BucketPolicy | null>>;

/**
 * How many keys one bucket may hold before the oldest are forgotten.
 *
 * Safe because of the direction of the failure: forgetting a key forgives whatever it had spent,
 * so the cap can only ever let a request through that would otherwise have been refused, never
 * refuse one that should have passed. It bites when a caller invents keys faster than they expire,
 * which for the address-keyed buckets means a flood from tens of thousands of distinct addresses,
 * and an in-process counter is not what stops that in any case: a distributed flood is stopped in
 * front of the process. What the cap buys is that such a flood cannot grow this process's heap
 * without bound while it fails to stop it. Ten thousand entries of two numbers and a string key is
 * on the order of a megabyte per bucket.
 */
export const MEMORY_RATE_LIMIT_MAX_KEYS = 10_000;

/** One key's state: tokens left as of `updatedAtMs`, refilled from there on the next look. */
type Bucket = { tokens: number; updatedAtMs: number };

export type MemoryRateLimiterOptions = {
  /** Default `MEMORY_RATE_LIMIT_MAX_KEYS`; a suite sets it low to watch the eviction. */
  maxKeys?: number;
};

export function createMemoryRateLimiter(
  policy: RateLimitPolicy,
  options: MemoryRateLimiterOptions = {},
): RateLimiter {
  const maxKeys = options.maxKeys ?? MEMORY_RATE_LIMIT_MAX_KEYS;
  // One map per bucket, so a flood at one door cannot evict the keys another door is counting.
  const buckets = new Map<RateLimitBucket, Map<string, Bucket>>();

  return {
    name: describePolicy(policy),
    check: async ({ bucket, key, now }: RateLimitCheck): Promise<RateLimitVerdict> => {
      const rule = policy[bucket];
      if (!rule) return { allowed: true };

      let keys = buckets.get(bucket);
      if (!keys) {
        keys = new Map();
        buckets.set(bucket, keys);
      }

      const nowMs = now.getTime();
      const perMs = rule.limit / (rule.windowSeconds * 1000);
      const held = keys.get(key);
      // A clock that went backwards refills nothing rather than draining the bucket, and the
      // stamp written back is the *later* of the two, never the earlier one: a bucket stamped at
      // the rolled-back time would be credited the same interval a second time the moment the
      // clock caught up, which is a caller handed a free window by an NTP correction. The
      // high-water mark costs a rollback nothing it was owed, because nothing refilled during it.
      const elapsed = held ? Math.max(0, nowMs - held.updatedAtMs) : 0;
      const tokens = held ? Math.min(rule.limit, held.tokens + elapsed * perMs) : rule.limit;
      const stampMs = held ? Math.max(held.updatedAtMs, nowMs) : nowMs;

      if (tokens < 1) {
        // Nothing is spent on a refusal: a caller that keeps knocking waits the same time it would
        // have waited had it stopped, rather than pushing its own recovery further out.
        touch(keys, key, { tokens, updatedAtMs: stampMs });
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)),
        };
      }

      if (!held) evictIfFull(keys, maxKeys, nowMs, rule);
      touch(keys, key, { tokens: tokens - 1, updatedAtMs: stampMs });
      return { allowed: true };
    },
  };
}

/**
 * Write a key's state, deleted first so it lands at the back. A `Map` iterates in insertion order
 * and `set` on a key it already holds does not move it, so this one delete is what makes the
 * iteration order least-recently-seen first, which is what lets the eviction below cost what it
 * evicts rather than a walk of the whole map on every new key under a flood.
 */
function touch(keys: Map<string, Bucket>, key: string, state: Bucket): void {
  keys.delete(key);
  keys.set(key, state);
}

/**
 * Make room for one more key. First the expired: a bucket that has had a whole window to refill is
 * full, and a full bucket is indistinguishable from one that was never there, so dropping it loses
 * nothing at all. They are a prefix of the least-recently-seen order `touch` keeps, so the walk
 * stops at the first key that is not expired. Only if that was not enough does the front of the
 * same order go, which is the forgiving eviction the cap's comment describes.
 */
function evictIfFull(
  keys: Map<string, Bucket>,
  maxKeys: number,
  nowMs: number,
  rule: BucketPolicy,
): void {
  if (keys.size < maxKeys) return;
  const windowMs = rule.windowSeconds * 1000;
  for (const [key, held] of keys) {
    if (nowMs - held.updatedAtMs < windowMs) break;
    keys.delete(key);
  }
  while (keys.size >= maxKeys) {
    const oldest = keys.keys().next().value;
    if (oldest === undefined) return;
    keys.delete(oldest);
  }
}

/**
 * The name the boot line carries: the backing and the buckets it actually limits, so an operator
 * reads back what they set. A policy with nothing in it never reaches here (the selector answers
 * `UNLIMITED` instead), but a caller that builds one by hand gets a name that says so.
 */
function describePolicy(policy: RateLimitPolicy): string {
  const configured = Object.entries(policy)
    .filter((entry): entry is [string, BucketPolicy] => entry[1] !== null)
    .map(([bucket, rule]) => `${bucket} ${rule.limit}/${rule.windowSeconds}`);
  return configured.length === 0
    ? "in-process, no bucket set"
    : `in-process ${configured.join(", ")}`;
}
