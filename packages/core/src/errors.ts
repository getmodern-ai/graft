/**
 * How a service refuses. One class with a code, so a transport — the JSON API today, the MCP server
 * later (GRA-19) — maps a refusal to its own vocabulary in one place rather than pattern-matching
 * messages. The codes are the handful of situations a service can be in, named as HTTP names them
 * because that is the first transport and the names are widely understood.
 */
export type ServiceErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "GONE";

export const HTTP_STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  GONE: 410,
};

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceError";
    this.details = options.details;
  }

  /** Structured facts about the refusal a caller may relay — never a secret. */
  readonly details: Record<string, unknown> | undefined;

  get status(): number {
    return HTTP_STATUS_BY_CODE[this.code];
  }
}

/**
 * `null` from a repo means "no such row for you", and deliberately does not say whether the row is
 * missing or another person's — telling those apart confirms an id exists somewhere the caller
 * cannot see (ADR 0007). This is that translation as one expression. The message is required
 * rather than defaulted, because the noun is the part the answer turns on.
 */
export function orNotFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new ServiceError("NOT_FOUND", message);
  return value;
}
