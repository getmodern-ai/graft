import { describe, expect, it } from "vitest";

import { createMemoryRateLimiter, type RateLimitPolicy } from "./memory";
import { RATE_LIMIT_BUCKETS, type RateLimitBucket, UNLIMITED } from "./rate-limiter";

/**
 * The open backing, on a clock the test holds (GRA-149). Every assertion here is about the rule
 * and none about the wire: the middleware's half is `apps/server/src/rate-limit.test.ts`.
 */

const UNSET: RateLimitPolicy = {
  sign_in: null,
  oauth_register: null,
  oauth_token: null,
  mcp: null,
  proxy: null,
  api: null,
};

function policy(overrides: Partial<RateLimitPolicy>): RateLimitPolicy {
  return { ...UNSET, ...overrides };
}

const AT = (seconds: number) => new Date(1_600_000_000_000 + seconds * 1000);

describe("createMemoryRateLimiter", () => {
  it("allows up to the limit and refuses the one past it, with whole seconds to wait", async () => {
    const limiter = createMemoryRateLimiter(policy({ sign_in: { limit: 3, windowSeconds: 60 } }));
    for (let i = 0; i < 3; i++) {
      expect(await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) })).toEqual({
        allowed: true,
      });
    }
    const refused = await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) });
    // Three a minute is one every twenty seconds, so the fourth waits twenty.
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it("never answers a Retry-After of zero, however fast the refill", async () => {
    const limiter = createMemoryRateLimiter(policy({ api: { limit: 1000, windowSeconds: 1 } }));
    for (let i = 0; i < 1000; i++) {
      await limiter.check({ bucket: "api", key: "a", now: AT(0) });
    }
    expect(await limiter.check({ bucket: "api", key: "a", now: AT(0) })).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("refills as the window rolls, and a spent key is whole again a window later", async () => {
    const limiter = createMemoryRateLimiter(policy({ mcp: { limit: 2, windowSeconds: 10 } }));
    await limiter.check({ bucket: "mcp", key: "a", now: AT(0) });
    await limiter.check({ bucket: "mcp", key: "a", now: AT(0) });
    expect((await limiter.check({ bucket: "mcp", key: "a", now: AT(0) })).allowed).toBe(false);
    // Half a window back is one token back.
    expect((await limiter.check({ bucket: "mcp", key: "a", now: AT(5) })).allowed).toBe(true);
    expect((await limiter.check({ bucket: "mcp", key: "a", now: AT(5) })).allowed).toBe(false);
    expect((await limiter.check({ bucket: "mcp", key: "a", now: AT(15) })).allowed).toBe(true);
    expect((await limiter.check({ bucket: "mcp", key: "a", now: AT(15) })).allowed).toBe(true);
  });

  it("spends nothing on a refusal, so knocking again does not push the wait further out", async () => {
    const limiter = createMemoryRateLimiter(policy({ sign_in: { limit: 1, windowSeconds: 60 } }));
    await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) });
    const first = await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) });
    for (let i = 0; i < 50; i++) await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) });
    const last = await limiter.check({ bucket: "sign_in", key: "a", now: AT(0) });
    expect(last).toEqual(first);
  });

  it("counts each key on its own", async () => {
    const limiter = createMemoryRateLimiter(policy({ proxy: { limit: 1, windowSeconds: 60 } }));
    expect((await limiter.check({ bucket: "proxy", key: "conn_1", now: AT(0) })).allowed).toBe(
      true,
    );
    expect((await limiter.check({ bucket: "proxy", key: "conn_1", now: AT(0) })).allowed).toBe(
      false,
    );
    expect((await limiter.check({ bucket: "proxy", key: "conn_2", now: AT(0) })).allowed).toBe(
      true,
    );
  });

  it("counts each bucket on its own, and allows every bucket the policy leaves null", async () => {
    const limiter = createMemoryRateLimiter(
      policy({ oauth_register: { limit: 1, windowSeconds: 60 } }),
    );
    expect((await limiter.check({ bucket: "oauth_register", key: "a", now: AT(0) })).allowed).toBe(
      true,
    );
    expect((await limiter.check({ bucket: "oauth_register", key: "a", now: AT(0) })).allowed).toBe(
      false,
    );
    for (const bucket of RATE_LIMIT_BUCKETS.filter((name) => name !== "oauth_register")) {
      for (let i = 0; i < 5; i++) {
        expect((await limiter.check({ bucket, key: "a", now: AT(0) })).allowed).toBe(true);
      }
    }
  });

  it("drops a key that has had a whole window to refill, which loses nothing", async () => {
    const limiter = createMemoryRateLimiter(policy({ api: { limit: 2, windowSeconds: 10 } }), {
      maxKeys: 2,
    });
    await limiter.check({ bucket: "api", key: "a", now: AT(0) });
    await limiter.check({ bucket: "api", key: "b", now: AT(0) });
    // `c` arrives a window later, by which time `a` and `b` are full and forgettable; `a` then
    // starts again from a full bucket, which is what it would have had anyway.
    expect((await limiter.check({ bucket: "api", key: "c", now: AT(20) })).allowed).toBe(true);
    expect((await limiter.check({ bucket: "api", key: "a", now: AT(20) })).allowed).toBe(true);
    expect((await limiter.check({ bucket: "api", key: "a", now: AT(20) })).allowed).toBe(true);
  });

  it("forgets the least recently seen key when the cap is reached inside one window", async () => {
    const limiter = createMemoryRateLimiter(policy({ api: { limit: 2, windowSeconds: 600 } }), {
      maxKeys: 2,
    });
    await limiter.check({ bucket: "api", key: "a", now: AT(0) });
    await limiter.check({ bucket: "api", key: "a", now: AT(0) });
    await limiter.check({ bucket: "api", key: "b", now: AT(1) });
    // `c` needs room, and `a` is the oldest, so `a` is forgiven rather than `b` or `c` refused.
    expect((await limiter.check({ bucket: "api", key: "c", now: AT(2) })).allowed).toBe(true);
    expect((await limiter.check({ bucket: "api", key: "a", now: AT(3) })).allowed).toBe(true);
  });

  it("keeps the key it saw most recently, refusals included, and forgives the one it did not", async () => {
    const limiter = createMemoryRateLimiter(policy({ api: { limit: 1, windowSeconds: 600 } }), {
      maxKeys: 2,
    });
    const check = (key: string, at: number) => limiter.check({ bucket: "api", key, now: AT(at) });
    await check("a", 0);
    await check("b", 1);
    // A refusal is still a sighting: `a` moves to the back of the order, so `b` is now the oldest
    // and `b` is what `c` costs. Were the order the one keys were first inserted in, `a` would have
    // gone here and its spend would have been forgiven with it.
    expect((await check("a", 2)).allowed).toBe(false);
    expect((await check("c", 3)).allowed).toBe(true);
    expect((await check("a", 4)).allowed).toBe(false);
  });

  it("names the buckets it limits, for the boot line", async () => {
    const limiter = createMemoryRateLimiter(
      policy({ sign_in: { limit: 20, windowSeconds: 60 }, mcp: { limit: 600, windowSeconds: 60 } }),
    );
    expect(limiter.name).toBe("in-process sign_in 20/60, mcp 600/60");
  });

  it("is a bucket vocabulary the policy must cover in full", () => {
    // The `satisfies` is the assertion: a bucket added to `RATE_LIMIT_BUCKETS` without a line here
    // does not compile, which is what keeps the environment, the policy and the mounts together.
    const total = {
      sign_in: null,
      oauth_register: null,
      oauth_token: null,
      mcp: null,
      proxy: null,
      api: null,
    } satisfies Record<RateLimitBucket, null>;
    expect(Object.keys(total).sort()).toEqual([...RATE_LIMIT_BUCKETS].sort());
  });
});

describe("UNLIMITED", () => {
  it("allows every bucket, forever, and says so by name", async () => {
    expect(UNLIMITED.name).toBe("off");
    for (const bucket of RATE_LIMIT_BUCKETS) {
      for (let i = 0; i < 100; i++) {
        expect(await UNLIMITED.check({ bucket, key: "a", now: AT(0) })).toEqual({ allowed: true });
      }
    }
  });
});
