import { readCapped } from "./body";
import { isPublicHost } from "./public-host";
import {
  DerivedCredentialError,
  InvalidSchemeParameterError,
  MissingSchemeParameterError,
} from "./scheme-errors";
import type { SchemeConfig, UpstreamFetch } from "./types";

/**
 * The one conversation every OAuth2 grant has with a vendor's token endpoint (RFC 6749 §3.2): a
 * form-encoded `POST` with the client authenticated in the `Authorization` header or the body, and
 * §5.1's JSON answer read back to an access token, its lifetime and — for the authorization-code
 * grant — a refresh token. Three grants pass through here: `client_credentials` (the
 * `oauth2_client_credentials` scheme's `derive`), `refresh_token` (the `oauth_authorization_code`
 * scheme's), and `authorization_code` itself, which the host's callback route performs when the
 * person's consent comes back with a code (ADR 0005). One implementation, so the address rule, the
 * body cap, the client-authentication encoding and the "never the body on a rejection" rule are
 * decided once. The fetch is the proxy's guarded one wherever this runs — a token endpoint receives
 * the client secret, so it answers to the same public-address rule as a vendor host (`upstream.ts`).
 */

/** The OAuth2 token is refreshed this far before `expires_in` says it dies — flight time. */
export const OAUTH2_TOKEN_SKEW_MS = 60_000;

/**
 * How long a token is trusted when the endpoint says nothing about its lifetime. Short on purpose:
 * the refresh-on-401 path makes a stale token cost one retried call, so the price of guessing low
 * is one token exchange every five minutes, and the price of guessing high would be a 401 the
 * agent's code sees.
 */
export const OAUTH2_DEFAULT_TOKEN_LIFETIME_MS = 5 * 60_000;

/** A token response is a few hundred bytes; a megabyte from a token endpoint is not a token. */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export const OAUTH2_CLIENT_AUTH = ["basic", "body"] as const;
export type ClientAuth = (typeof OAUTH2_CLIENT_AUTH)[number];

/** `schemeConfig.clientAuth`, or the scheme's own default when it is unset. */
export function clientAuthOf(config: SchemeConfig, fallback: ClientAuth): ClientAuth {
  const value = config.clientAuth;
  if (value === undefined || value === "") return fallback;
  if (!(OAUTH2_CLIENT_AUTH as readonly string[]).includes(value)) {
    throw new InvalidSchemeParameterError("clientAuth", OAUTH2_CLIENT_AUTH.join(" or "));
  }
  return value as ClientAuth;
}

/**
 * RFC 6749 §2.3.1: the id and secret are each form-urlencoded before they are joined and base64'd,
 * so a secret containing `:` or `%` survives. `encodeURIComponent` is the encoding the reference
 * clients use for this; the handful of characters it treats differently from a form body
 * (`!'()*`) do not occur in issued client secrets.
 */
export function basicClientAuthorization(clientId: string, clientSecret: string): string {
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/**
 * The token endpoint as a URL, or the error the configuration earns: absent, not a URL, or — since
 * it receives the client secret — not https on a public host by its literal. What the name resolves
 * to is judged inside the guarded fetch, as for a vendor host.
 */
export function tokenEndpointOf(tokenUrl: string | undefined): URL {
  if (!tokenUrl) throw new MissingSchemeParameterError("tokenUrl");
  let endpoint: URL;
  try {
    endpoint = new URL(tokenUrl);
  } catch {
    throw new InvalidSchemeParameterError("tokenUrl", "an absolute https URL");
  }
  if (endpoint.protocol !== "https:" || !isPublicHost(endpoint.hostname)) {
    throw new DerivedCredentialError(
      `The token endpoint ${endpoint.hostname} is not a public https host`,
      "host_not_public",
    );
  }
  return endpoint;
}

/** RFC 6749 §5.1's success body, reduced to what the schemes and the callback use. */
export type TokenResponse = {
  accessToken: string;
  /** `expires_in`, when the endpoint sent one. */
  expiresInSeconds: number | null;
  /** `refresh_token`, when the grant yielded one — a consent's does; a refresh's may rotate it. */
  refreshToken: string | null;
};

/**
 * Parse a token response. `token_type` is compared case-insensitively because servers disagree on
 * its case; anything but bearer is not a token these schemes know how to send. `expires_in` is
 * optional in the RFC and absent in practice often enough to have a default; a string is accepted
 * because some servers send one.
 */
export function parseTokenResponse(bytes: Uint8Array): TokenResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  if (typeof body.access_token !== "string" || body.access_token === "") return null;
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") {
    return null;
  }
  const expiresIn =
    typeof body.expires_in === "number"
      ? body.expires_in
      : typeof body.expires_in === "string"
        ? Number(body.expires_in)
        : null;
  return {
    accessToken: body.access_token,
    expiresInSeconds: expiresIn !== null && Number.isFinite(expiresIn) ? expiresIn : null,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token !== ""
        ? body.refresh_token
        : null,
  };
}

export type TokenRequest = {
  /** Already through `tokenEndpointOf`, so the address rule was applied before any field was read. */
  endpoint: URL;
  clientId: string;
  clientSecret: string;
  clientAuth: ClientAuth;
  /** The grant's own form fields — `grant_type` first, then its parameters — in the order sent. */
  grant: Record<string, string>;
};

/**
 * One request to the token endpoint, and the token out of its answer. Everything the endpoint does
 * wrong is a `DerivedCredentialError` with `token_exchange_failed`: unreachable (the fetch failure
 * as `cause`), a non-2xx status (the status, **never the body** — a rejected exchange echoes the
 * client id back), an answer that is too large or too slow to be a token, or one with no bearer
 * `access_token` in it.
 */
export async function requestToken(
  request: TokenRequest,
  fetch: UpstreamFetch,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const form = new URLSearchParams(request.grant);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  if (request.clientAuth === "basic") {
    headers.set("authorization", basicClientAuthorization(request.clientId, request.clientSecret));
  } else {
    form.set("client_id", request.clientId);
    form.set("client_secret", request.clientSecret);
  }

  let response: Awaited<ReturnType<UpstreamFetch>>;
  try {
    response = await fetch(
      {
        url: request.endpoint.href,
        method: "POST",
        headers,
        body: new TextEncoder().encode(form.toString()),
      },
      { signal },
    );
  } catch (error) {
    throw new DerivedCredentialError(
      "The token endpoint could not be reached",
      "token_exchange_failed",
      { cause: error },
    );
  }

  const read = await readCapped(response.body, MAX_TOKEN_RESPONSE_BYTES, signal);
  if (response.status < 200 || response.status > 299) {
    throw new DerivedCredentialError(
      `The token endpoint answered ${response.status}`,
      "token_exchange_failed",
      { upstreamStatus: response.status },
    );
  }
  if (!read.ok) {
    throw new DerivedCredentialError(
      read.reason === "aborted"
        ? "The token endpoint did not finish answering within the time limit"
        : "The token endpoint's answer was too large to be a token",
      "token_exchange_failed",
      { upstreamStatus: response.status },
    );
  }

  const token = parseTokenResponse(read.bytes);
  if (!token) {
    throw new DerivedCredentialError(
      "The token endpoint answered without a bearer access_token",
      "token_exchange_failed",
      { upstreamStatus: response.status },
    );
  }
  return token;
}

/**
 * When a token dies, as an ISO instant from `expires_in` and the clock the request was made on —
 * or null when the endpoint said nothing, in which case the stored token is trusted until the
 * vendor refuses it and the 401 path refreshes.
 */
export function tokenExpiresAt(response: TokenResponse, nowMs: number): string | null {
  return response.expiresInSeconds === null
    ? null
    : new Date(nowMs + response.expiresInSeconds * 1000).toISOString();
}

/**
 * Whether a stored token is within the skew of its recorded expiry — the moment the scheme refreshes
 * before sending. Unknown or unparseable expiry is "not expiring": the token is sent, and a 401
 * buys a fresh one.
 */
export function isTokenExpiring(
  expiresAt: string | undefined,
  nowMs: number,
  skewMs: number = OAUTH2_TOKEN_SKEW_MS,
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return false;
  return at - skewMs <= nowMs;
}
