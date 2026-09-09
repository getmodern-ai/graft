import type { SingleFlight } from "./types";

/**
 * The in-memory single-flight: one asynchronous step per key at a time, every concurrent caller of
 * the same key awaiting the first caller's promise — settled or rejected alike, so a refused refresh
 * is refused once to everyone rather than retried once per caller. One per `createProxyApp`, like
 * the derived-credential cache: per process in production, per harness in a test. The entry is
 * dropped as its step settles, so the next caller after that starts a step of its own.
 *
 * This is what makes ADR 0005's "two concurrent calls refresh once" true for an authorization-code
 * connection: both decrypted the same expired token, both ask for a refresh, one token request
 * leaves (`schemes.ts`).
 */
export function createSingleFlight(): SingleFlight {
  const flights = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const inFlight = flights.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const flight = run().finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  };
}
