import type { CredentialFields, DerivedCredentialCache } from "./types";

/**
 * The in-memory `DerivedCredentialCache` — what an OAuth2 client-credentials token or a Snowflake
 * JWT lives in between calls. One per `createProxyApp`, so it is per process in production and per
 * harness in a test. Expiry is checked on read rather than swept, because the population is
 * bounded by the number of connections that made a call and every entry is small.
 */
export function createDerivedCredentialCache(now: () => number = Date.now): DerivedCredentialCache {
  const entries = new Map<string, { value: CredentialFields; expiresAtMs: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAtMs <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      // A non-positive lifetime is "do not cache", not "cache and expire at once" — the difference
      // is one map entry that would never be read.
      if (ttlMs <= 0) {
        entries.delete(key);
        return;
      }
      entries.set(key, { value, expiresAtMs: now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}
