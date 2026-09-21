import type { ServiceErrorCode } from "@graft/core";

/**
 * The console's one way to the JSON API (`apps/server/src/api.ts`): same-origin `fetch`, cookies
 * along, JSON in and out. The server answers a refusal as `{ error, message, details? }` at the
 * `ServiceError`'s status, and this turns that into an `ApiError` so a caller — and the mutation
 * cache's toast — reads one shape.
 *
 * Types flow from the server without codegen (`AGENTS.md`): the wire shapes are imported from
 * `@graft/server/api` and `@graft/core` as types, never written a second time here. One transform
 * is applied on the way, `Jsonified<T>`: a `Date` on the server is a string on the wire, and a type
 * that said otherwise would be a lie every `new Date(value)` had to remember.
 *
 * Two things this sends are what the API checks for (GRA-148). Every state-changing request under
 * `/api` has to name an origin the deployment serves the console on
 * (`apps/server/src/origin-guard.ts`), and a browser puts `Origin` on every request but `GET` and
 * `HEAD` by the Fetch standard, so nothing is set here for it. And a body has to declare itself
 * JSON or the route answers 415, which the header below does for every call that sends one; a
 * call with no body reaches no route that reads one.
 */

export const API_BASE = "/api";

/** The wire form of a server type: every `Date` a string, recursively. */
export type Jsonified<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ServiceErrorCode | "INTERNAL" | string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  let body: { error?: string; message?: string; details?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON — the server's static handler or a proxy in front of it; the status says enough.
  }
  throw new ApiError(
    response.status,
    body.error ?? "INTERNAL",
    body.message ?? `The server answered ${response.status}`,
    body.details,
  );
}
