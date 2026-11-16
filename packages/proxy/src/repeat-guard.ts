import { createHash } from "node:crypto";

import { type Refused, refuse } from "./failure";
import type { ProxyRepeatTrace, RepeatLimit } from "./types";

/**
 * Repeat detection (GRA-351; ADR 0019 as amended 2026-11-14). The relay budget bounds a loop over
 * hours; this bounds it over minutes, by its signature: one agent sending the same relayed request,
 * byte for byte, again and again. In October one agent re-exported the same file thousands of times
 * through a relay. An honest run fans out over distinct requests, and an honest poll is slower than
 * the limit, so an identical request past `ProxyOptions.repeatLimit` in its window is refused as a
 * probable loop.
 *
 * **The count lives in this app instance**, a sliding window per request held as timestamps under a
 * sha256 digest of the request. Two limits follow and are accepted: a restart forgets at most one
 * window, and two replicas count their own shares. Memory is bounded twice: a key's entries stay
 * near the limit, since a refused call is not recorded, and the number of keys is capped at
 * `REPEAT_GUARD_MAX_KEYS`, the least recently recorded evicted first. Expired keys are pruned as
 * calls arrive, oldest first, so the map holds at most one window of traffic.
 */

/**
 * The most distinct requests held at once. At thirty entries a key, about five megabytes of
 * timestamps at worst. A burst of more distinct requests than this inside one window evicts the
 * oldest keys and so forgets their counts; the relay budget still bounds what such a burst costs.
 */
export const REPEAT_GUARD_MAX_KEYS = 20_000;

/** What makes two relayed requests the same one. The URL is the vendor's, query included. */
export type RepeatRequest = {
  agentId: string;
  /** The connection, so one agent's identical reads of two accounts are two requests. */
  connectionId: string;
  tool: string;
  method: string;
  url: string;
  body: Uint8Array | null;
};

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The request's key: a sha256 over the agent, the connection, the tool, the method, the full
 * vendor URL and a sha256 of the body. Only this digest is held, never the URL or the body. A JSON
 * array so no field's content can spell another's boundary; no body and an empty body are the same
 * request.
 */
export function repeatKey(request: RepeatRequest): string {
  return sha256(
    JSON.stringify([
      request.agentId,
      request.connectionId,
      request.tool,
      request.method.toUpperCase(),
      request.url,
      sha256(request.body ?? new Uint8Array()),
    ]),
  );
}

export type RepeatVerdict =
  | { allowed: true }
  | { allowed: false; count: number; retryAfterSeconds: number };

export type RepeatGuard = {
  limit: RepeatLimit;
  /** Judge one request at `nowMs`, recording nothing: a refusal never fills the window. */
  check: (key: string, nowMs: number) => RepeatVerdict;
  /**
   * Record one request that is leaving, at `nowMs`. Called when the request's first hop is let
   * through, so only calls that leave are counted. Calls judged together may each pass the check
   * before any records, and so pass the limit by as many as are in flight, as the budget's may; a
   * loop sends one at a time.
   */
  record: (key: string, nowMs: number) => void;
  /** How many distinct requests are held: for the tests of the memory bound. */
  size: () => number;
};

export function createRepeatGuard(
  limit: RepeatLimit,
  maxKeys: number = REPEAT_GUARD_MAX_KEYS,
): RepeatGuard {
  const windowMs = limit.windowSeconds * 1000;
  // Insertion order is the order of last record, since a record re-inserts its key at the proxy's
  // clock, which only moves forward: the first key is the least recently recorded, and its newest
  // entry the oldest newest of them all. Nothing removes an entry but its age, so the order holds.
  const seen = new Map<string, number[]>();

  /** Drop every key whose newest entry has left the window, from the front, stopping at a live one. */
  function pruneExpired(nowMs: number): void {
    for (const [key, times] of seen) {
      const newest = times.at(-1);
      if (newest !== undefined && newest > nowMs - windowMs) break;
      seen.delete(key);
    }
  }

  /** The key's entries still inside the window, oldest first. */
  function live(key: string, nowMs: number): number[] {
    return (seen.get(key) ?? []).filter((at) => at > nowMs - windowMs);
  }

  return {
    limit,
    check(key, nowMs) {
      pruneExpired(nowMs);
      const times = live(key, nowMs);
      if (times.length < limit.limit) return { allowed: true };
      // Put back in place, trimmed: a check is not a record and does not move the key up the
      // eviction order.
      seen.set(key, times);
      // The call may go once enough of the oldest entries age out to leave room for one more.
      const freeing = times[times.length - limit.limit] ?? nowMs;
      return {
        allowed: false,
        count: times.length,
        retryAfterSeconds: Math.max(1, Math.ceil((freeing + windowMs - nowMs) / 1000)),
      };
    },
    record(key, nowMs) {
      const times = live(key, nowMs);
      times.push(nowMs);
      seen.delete(key);
      seen.set(key, times);
      while (seen.size > maxKeys) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
    size: () => seen.size,
  };
}

/** `15 minutes`, `1 minute`, `90 seconds`: the window as the sentence names it. */
function duration(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** `in 12 seconds`, `in about 4 minutes`: when the same request may be sent again. */
function after(seconds: number): string {
  if (seconds < 60) return `in ${duration(seconds)}`;
  const minutes = Math.ceil(seconds / 60);
  return `in about ${minutes === 1 ? "1 minute" : `${minutes} minutes`}`;
}

/**
 * The refusal's sentence, in `relayBudgetMessage`'s form: what was counted, the limit, when it lifts,
 * and the likely cause. A result, not a description, so the advice to stop is allowed here. It names
 * no URL: the agent knows which request it sent, and the event must not learn it.
 */
export function repeatedRequestMessage(verdict: {
  count: number;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
}): string {
  return `This agent has made this same relayed request ${verdict.count} times in the last ${duration(verdict.windowSeconds)}, the limit of ${verdict.limit}; it may be sent again ${after(verdict.retryAfterSeconds)}. An agent that sends one request this often is usually looping: stop, and tell the person what you were doing.`;
}

/**
 * An admitted request, and how to count it once its first hop is let through: `forward`'s
 * `beforeSend` calls `record` then, at the proxy's clock, so a call refused by the budget or one
 * that fails before it leaves is never counted.
 */
export type RepeatAdmission = { kind: "admitted"; record: () => void };

/**
 * The rung: admit one relayed request, or refuse it `429 repeated_request` with `Retry-After` and
 * note the refusal on `trace.repeat`. The guard never throws; it is the proxy's own memory.
 */
export function admitRepeat(
  guard: RepeatGuard,
  request: RepeatRequest,
  now: () => number,
  trace: { repeat: ProxyRepeatTrace | null },
  requestBytes: number,
): Refused | RepeatAdmission {
  const key = repeatKey(request);
  const verdict = guard.check(key, now());
  if (verdict.allowed) return { kind: "admitted", record: () => guard.record(key, now()) };
  trace.repeat = {
    count: verdict.count,
    limit: guard.limit.limit,
    windowSeconds: guard.limit.windowSeconds,
  };
  return refuse(
    429,
    "repeated_request",
    repeatedRequestMessage({
      count: verdict.count,
      limit: guard.limit.limit,
      windowSeconds: guard.limit.windowSeconds,
      retryAfterSeconds: verdict.retryAfterSeconds,
    }),
    { requestBytes, retryAfterSeconds: verdict.retryAfterSeconds },
  );
}
