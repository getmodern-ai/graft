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
