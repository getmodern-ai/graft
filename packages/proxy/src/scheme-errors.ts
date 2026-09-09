/**
 * What a scheme plugin throws when the connection, not the proxy, is at fault — a field or a
 * parameter missing or unusable — and what the token-minting schemes throw when the vendor's token
 * endpoint did not hand over a token. Their own module so the plugins (`schemes.ts`) and the
 * token-endpoint code they share (`oauth.ts`) both import them without importing each other;
 * `schemes.ts` re-exports every name here, so a reader who starts there sees one vocabulary.
 */

/** A credential field the scheme needs is absent from the decrypted record. */
export class MissingCredentialFieldError extends Error {
  constructor(public readonly field: string) {
    super(`credential is missing the ${field} field`);
    this.name = "MissingCredentialFieldError";
  }
}

/** A credential field is present but not something the scheme can use — a key that is not a key. */
export class InvalidCredentialFieldError extends Error {
  constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`credential field ${field} is unusable: ${reason}`);
    this.name = "InvalidCredentialFieldError";
  }
}

/** A parameter the scheme is parameterised by is absent from the connection's `schemeConfig`. */
export class MissingSchemeParameterError extends Error {
  constructor(public readonly parameter: string) {
    super(`scheme configuration is missing ${parameter}`);
    this.name = "MissingSchemeParameterError";
  }
}

/** A parameter is present but not one of the values the scheme accepts. */
export class InvalidSchemeParameterError extends Error {
  constructor(
    public readonly parameter: string,
    expected: string,
  ) {
    super(`scheme configuration has an invalid ${parameter}: expected ${expected}`);
    this.name = "InvalidSchemeParameterError";
  }
}

/** The four errors above, as one predicate: the connection is misconfigured, not the proxy. */
export function isSchemeConfigurationError(
  error: unknown,
): error is
  | MissingCredentialFieldError
  | InvalidCredentialFieldError
  | MissingSchemeParameterError
  | InvalidSchemeParameterError {
  return (
    error instanceof MissingCredentialFieldError ||
    error instanceof InvalidCredentialFieldError ||
    error instanceof MissingSchemeParameterError ||
    error instanceof InvalidSchemeParameterError
  );
}

/** The refusal a scheme configuration error earns; the ladder puts the status (409) on it. */
export type CredentialIncompleteRefusal = { reason: "credential_incomplete"; message: string };

/**
 * A scheme configuration error as the caller's refusal — `credential_incomplete`, carrying the
 * error's own message, which names the missing or unusable field or parameter and never a value —
 * or null for any other error, which is not the connection's fault and is the caller's to rethrow.
 * One mapping, because the ladder meets these errors in three places — `apply` on a live call,
 * `derive`, and the dry run's preview (`dry-run.ts`).
 */
export function credentialIncompleteRefusal(error: unknown): CredentialIncompleteRefusal | null {
  if (!isSchemeConfigurationError(error)) return null;
  return { reason: "credential_incomplete", message: error.message };
}

/**
 * The `derive` step could not produce a wire credential. `host_not_public` when the token endpoint
 * fails the address rule before it is called; `token_exchange_failed` when it was called and did
 * not answer with a token — `cause` carries the fetch failure, `upstreamStatus` the endpoint's
 * status, and neither ever carries the endpoint's body, which echoes the client id on a rejection.
 */
export class DerivedCredentialError extends Error {
  readonly upstreamStatus: number | undefined;
  constructor(
    message: string,
    public readonly reason: "host_not_public" | "token_exchange_failed",
    options: { cause?: unknown; upstreamStatus?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DerivedCredentialError";
    this.upstreamStatus = options.upstreamStatus;
  }
}

/**
 * An authorization-code connection's stored token could not be made good (ADR 0005). Two reasons,
 * two answers from the ladder. `consent_required`: there is nothing to send — no access token was
 * ever stored, or the one stored is dead and no refresh token came with it — so the call is refused
 * with that word and the person completes the consent in the console. `refresh_failed`: an access
 * token *is* stored and the refresh the proxy attempted was refused or unreachable, so the stored
 * token is sent as it is and the vendor's own answer — its 401, in the usual case — goes back to
 * the caller untouched, while the host marks the connection for re-consent. `cause` is the fetch
 * failure or the `DerivedCredentialError` the exchange raised; `upstreamStatus` the endpoint's
 * status; neither carries a body.
 */
export class CredentialRefreshError extends Error {
  readonly upstreamStatus: number | null;
  constructor(
    message: string,
    public readonly reason: "consent_required" | "refresh_failed",
    options: { cause?: unknown; upstreamStatus?: number | null } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CredentialRefreshError";
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}
