import { createHmac } from "node:crypto";

import { readCapped } from "./body";
import { isPublicHost } from "./public-host";
import {
  SNOWFLAKE_JWT_LIFETIME_SECONDS,
  SNOWFLAKE_JWT_REFRESH_SKEW_SECONDS,
  SnowflakeKeyError,
  signSnowflakeJwt,
  snowflakeCredentialSignature,
} from "./snowflake-jwt";
import type { AuthScheme, CredentialFields, SchemeConfig, SchemeRuntime } from "./types";

/**
 * The scheme plugins. A plugin is code *we* wrote, parameterised by the connection's non-secret
 * `schemeConfig` and fed the credential; the agent chooses a scheme and its parameters and never
 * supplies signing code — a module holds no credential, so it holds no signing recipe either
 * (ADR 0010). Each one mutates the outgoing request in place: a header set, a query parameter set,
 * a signature computed.
 *
 * Four send what they hold. Three do work first: `oauth2_client_credentials` *derives* an access
 * token from the client id and secret, `snowflake_keypair_jwt` signs a short-lived JWT with the
 * connection's private key, and `unleashed_hmac` signs the query string per call. The `derive`
 * hook is the shape the first two need — an async step that runs once before the vendor is called
 * and once more, on demand, when the vendor answers 401 — and it is where an authorization-code
 * refresh goes when GRA-30 adds one. Each plugin also *names* the headers it would set
 * (`headerNames`), which is all a dry run needs of it.
 *
 * The field names each plugin reads are the table in `credential-fields.ts`, not a property here:
 * that file is import-free because the console reaches it, and this one imports `node:crypto`.
 * `schemes.test.ts` holds each plugin to its row. Copied from Cando (ADR 0011); the Snowflake
 * recipe is Modern's, re-expressed as a plugin.
 */

/** The outgoing request as a plugin sees it: the URL and the headers, nothing else. */
export type SchemeTarget = { url: URL; headers: Headers };

export type SchemeApply = (
  target: SchemeTarget,
  credential: CredentialFields,
  config: SchemeConfig,
) => void;

/**
 * Turn the stored credential into the one that goes on the wire — an access token bought with a
 * client id and secret, a JWT signed with a private key. `refresh: false` may answer from
 * `runtime.cache`; `refresh: true` must not, because the proxy asks for it only after the vendor
 * refused what the cache held.
 */
export type SchemeDerive = (
  credential: CredentialFields,
  config: SchemeConfig,
  runtime: SchemeRuntime,
  options: { refresh: boolean },
) => Promise<CredentialFields>;

export type SchemePlugin = {
  /** Attach the wire credential — the stored one, or what `derive` produced when there is one. */
  apply: SchemeApply;
  /**
   * The names of the headers `apply` sets under this configuration — lower-cased, as `Headers`
   * reports them, and exactly that set, so a scheme that writes to the URL answers none. A dry run
   * previews these in place of the request it did not send (`dry-run.ts`): the names say that
   * authentication would have been present, and no credential has to be in hand to list them.
   * Throws the configuration error `apply` would, so a preview refuses where a live call would
   * (`schemes.test.ts` holds each plugin's list to its `apply`).
   */
  headerNames: (config: SchemeConfig) => readonly string[];
  /**
   * Present on a scheme whose wire credential is derived rather than stored. Runs before `apply`,
   * and again with `refresh: true` when the vendor answers 401, after which the call is retried
   * once — so a token revoked before its lifetime is up costs one retried call, not a broken run.
   */
  derive?: SchemeDerive;
  /**
   * Remove what this scheme put on the URL from a vendor `Location` the proxy is about to hand
   * back. A vendor that redirects `/orders?api_key=…` to `/orders/?api_key=…` would otherwise
   * return the injected key to the caller inside the redirect — the one way the proxy's own work
   * could put a credential in front of agent code. Only a scheme that writes to the URL needs one.
   */
  scrubRedirect?: (location: URL, config: SchemeConfig) => void;
};

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

function field(credential: CredentialFields, name: string): string {
  const value = credential[name];
  if (value === undefined || value === "") throw new MissingCredentialFieldError(name);
  return value;
}

/** A field the scheme uses when it is there — `SCHEME_OPTIONAL_CREDENTIAL_FIELDS` names them. */
function optionalField(credential: CredentialFields, name: string): string | undefined {
  const value = credential[name];
  return value === undefined || value === "" ? undefined : value;
}

/** A scheme parameter the plugin cannot run without — read the same way by `apply` and `headerNames`. */
function parameter(config: SchemeConfig, name: string): string {
  const value = config[name];
  if (!value) throw new MissingSchemeParameterError(name);
  return value;
}

/**
 * Unleashed's `client-type` — free text it uses to attribute API traffic, documented as
 * `<account>/<app>`, lowercase, no spaces or punctuation
 * (https://apidocs.unleashedsoftware.com/AuthenticationHelp). One value for every call the proxy
 * signs: what Unleashed sees is that a Graft agent called, whichever agent it was.
 */
export const UNLEASHED_CLIENT_TYPE = "graft/agent";

/**
 * Snowflake's SQL API reads the bearer's kind from this header; `KEYPAIR_JWT` is what tells it the
 * token is a key-pair JWT rather than an OAuth access token
 * (https://docs.snowflake.com/en/developer-guide/sql-api/authenticating).
 */
export const SNOWFLAKE_TOKEN_TYPE_HEADER = "x-snowflake-authorization-token-type";

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

const OAUTH2_CLIENT_AUTH = ["basic", "body"] as const;
type ClientAuth = (typeof OAUTH2_CLIENT_AUTH)[number];

/**
 * RFC 6749 §2.3.1: the id and secret are each form-urlencoded before they are joined and base64'd,
 * so a secret containing `:` or `%` survives. `encodeURIComponent` is the encoding the reference
 * clients use for this; the handful of characters it treats differently from a form body
 * (`!'()*`) do not occur in issued client secrets.
 */
function basicClientAuthorization(clientId: string, clientSecret: string): string {
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

function clientAuthOf(config: SchemeConfig): ClientAuth {
  const value = config.clientAuth;
  if (value === undefined || value === "") return "basic";
  if (!(OAUTH2_CLIENT_AUTH as readonly string[]).includes(value)) {
    throw new InvalidSchemeParameterError("clientAuth", OAUTH2_CLIENT_AUTH.join(" or "));
  }
  return value as ClientAuth;
}

export const SCHEMES: Record<AuthScheme, SchemePlugin> = {
  /**
   * `X-Api-Key: <key>`, or `<Header>: <prefix> <key>` when the vendor wants a word in front —
   * `Token`, `SSWS`, `Api-Key`. The prefix and the key are joined by one space; a vendor whose
   * format is anything else is a `bearer` connection or a new scheme, not a prefix.
   */
  api_key_header: {
    apply(target, credential, config) {
      const headerName = parameter(config, "headerName");
      const key = field(credential, "apiKey");
      target.headers.set(headerName, config.prefix ? `${config.prefix} ${key}` : key);
    },
    headerNames(config) {
      return [parameter(config, "headerName").toLowerCase()];
    },
  },

  /** `?<param>=<key>`, replacing any value the caller put under the same name. */
  api_key_query: {
    apply(target, credential, config) {
      const queryParam = parameter(config, "queryParam");
      target.url.searchParams.set(queryParam, field(credential, "apiKey"));
    },
    headerNames(config) {
      // Nothing goes in a header, but a preview refuses the configuration `apply` would refuse.
      parameter(config, "queryParam");
      return [];
    },
    scrubRedirect(location, config) {
      if (config.queryParam) location.searchParams.delete(config.queryParam);
    },
  },

  bearer: {
    apply(target, credential) {
      target.headers.set("authorization", `Bearer ${field(credential, "token")}`);
    },
    headerNames() {
      return ["authorization"];
    },
  },

  /** RFC 7617: `Basic base64(username:password)`, UTF-8 for anything outside ASCII. */
  basic: {
    apply(target, credential) {
      const pair = `${field(credential, "username")}:${field(credential, "password")}`;
      target.headers.set("authorization", `Basic ${Buffer.from(pair, "utf8").toString("base64")}`);
    },
    headerNames() {
      return ["authorization"];
    },
  },

  /**
   * RFC 6749 §4.4. The stored credential is the client id and secret; the wire credential is the
   * access token `derive` buys from `schemeConfig.tokenUrl` — with the client authenticated in the
   * `Authorization` header (`clientAuth: basic`, the default and the RFC's MUST) or in the form
   * body (`clientAuth: body`, for the servers that only read it there) and `schemeConfig.scopes`
   * sent as `scope` when present. Cached per connection until `expires_in` less a minute; a 401
   * from the vendor throws the cached token away and buys one more before the call is retried.
   */
  oauth2_client_credentials: {
    apply(target, credential) {
      target.headers.set("authorization", `Bearer ${field(credential, "accessToken")}`);
    },
    // As `apply` does, this reads no parameter: `tokenUrl` is `derive`'s, and a dry run never derives.
    headerNames() {
      return ["authorization"];
    },
    async derive(credential, config, runtime, { refresh }) {
      const key = `oauth2_client_credentials:${runtime.connectionId}`;
      if (!refresh) {
        const cached = runtime.cache.get(key);
        if (cached) return cached;
      }
      runtime.cache.delete(key);

      const tokenUrl = config.tokenUrl;
      if (!tokenUrl) throw new MissingSchemeParameterError("tokenUrl");
      let endpoint: URL;
      try {
        endpoint = new URL(tokenUrl);
      } catch {
        throw new InvalidSchemeParameterError("tokenUrl", "an absolute https URL");
      }
      // The token endpoint receives the client secret, so it answers to the vendor's address rule:
      // https, and public by its literal here and by what it resolves to inside
      // `runtime.upstreamFetch`.
      if (endpoint.protocol !== "https:" || !isPublicHost(endpoint.hostname)) {
        throw new DerivedCredentialError(
          `The token endpoint ${endpoint.hostname} is not a public https host`,
          "host_not_public",
        );
      }

      const clientId = field(credential, "clientId");
      const clientSecret = field(credential, "clientSecret");
      const clientAuth = clientAuthOf(config);

      const form = new URLSearchParams({ grant_type: "client_credentials" });
      if (config.scopes) form.set("scope", config.scopes);
      const headers = new Headers({
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      });
      if (clientAuth === "basic") {
        headers.set("authorization", basicClientAuthorization(clientId, clientSecret));
      } else {
        form.set("client_id", clientId);
        form.set("client_secret", clientSecret);
      }

      let response: Awaited<ReturnType<SchemeRuntime["upstreamFetch"]>>;
      try {
        response = await runtime.upstreamFetch(
          {
            url: endpoint.href,
            method: "POST",
            headers,
            body: new TextEncoder().encode(form.toString()),
          },
          { signal: runtime.signal },
        );
      } catch (error) {
        throw new DerivedCredentialError(
          "The token endpoint could not be reached",
          "token_exchange_failed",
          { cause: error },
        );
      }

      const read = await readCapped(response.body, MAX_TOKEN_RESPONSE_BYTES, runtime.signal);
      if (response.status < 200 || response.status > 299) {
        // Never the body: a rejected client-credentials exchange echoes the client id back.
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

      const derived: CredentialFields = { accessToken: token.accessToken };
      const lifetimeMs =
        token.expiresInSeconds === null
          ? OAUTH2_DEFAULT_TOKEN_LIFETIME_MS
          : token.expiresInSeconds * 1000;
      runtime.cache.set(key, derived, lifetimeMs - OAUTH2_TOKEN_SKEW_MS);
      return derived;
    },
  },

  /**
   * Unleashed's signing recipe (https://apidocs.unleashedsoftware.com/AuthenticationHelp): the
   * query string — what follows `?`, or the empty string when there is none — HMAC-SHA256'd with
   * the API key and base64'd, beside the API id and a `client-type`. Signed as the URL serialises
   * it, which is exactly what goes on the wire, so caller and proxy cannot disagree about encoding.
   * `Accept` and `Content-Type` are Unleashed's other two required headers, defaulted to JSON and
   * left alone when the caller set them. Kept as the worked example of a signing recipe: a scheme
   * that computes something per call rather than attaching what it holds.
   */
  unleashed_hmac: {
    apply(target, credential) {
      const apiId = field(credential, "apiId");
      const apiKey = field(credential, "apiKey");
      const search = target.url.search;
      const query = search.startsWith("?") ? search.slice(1) : search;
      const signature = createHmac("sha256", apiKey).update(query, "utf8").digest("base64");
      target.headers.set("api-auth-id", apiId);
      target.headers.set("api-auth-signature", signature);
      target.headers.set("client-type", UNLEASHED_CLIENT_TYPE);
      if (!target.headers.has("accept")) target.headers.set("accept", "application/json");
      if (!target.headers.has("content-type")) {
        target.headers.set("content-type", "application/json");
      }
    },
    // The two defaults are listed too: `apply` sets them when the caller did not, so either way
    // they leave with the request.
    headerNames() {
      return ["api-auth-id", "api-auth-signature", "client-type", "accept", "content-type"];
    },
  },

  /**
   * Snowflake key-pair authentication (`snowflake-jwt.ts` has the recipe and the PEM tolerance).
   * The stored credential is the private key, with a passphrase when the PEM is encrypted; the
   * account and user are `schemeConfig` — they are in the claims, not secret. The wire credential
   * is the RS256 JWT `derive` signs, sent as a bearer beside the header that tells Snowflake what
   * kind of bearer it is. Cached per connection for the token's life less a minute, and dropped
   * early when the account, user or key on the row changes: the cache entry carries a digest of
   * the three, and a mismatch on read is a rotated key whose old token Snowflake would now refuse.
   * A vendor 401 buys a fresh token and retries once, as for OAuth2.
   */
  snowflake_keypair_jwt: {
    apply(target, credential) {
      target.headers.set("authorization", `Bearer ${field(credential, "token")}`);
      target.headers.set(SNOWFLAKE_TOKEN_TYPE_HEADER, "KEYPAIR_JWT");
    },
    // As for OAuth2, no parameter is read here: `account` and `user` are `derive`'s.
    headerNames() {
      return ["authorization", SNOWFLAKE_TOKEN_TYPE_HEADER];
    },
    async derive(credential, config, runtime, { refresh }) {
      const account = parameter(config, "account");
      const user = parameter(config, "user");
      const privateKeyPem = field(credential, "privateKey");
      const passphrase = optionalField(credential, "privateKeyPassphrase");
      const signature = snowflakeCredentialSignature(account, user, privateKeyPem);

      const key = `snowflake_keypair_jwt:${runtime.connectionId}`;
      if (!refresh) {
        const cached = runtime.cache.get(key);
        if (cached && cached.signature === signature) return cached;
      }
      runtime.cache.delete(key);

      let signed: ReturnType<typeof signSnowflakeJwt>;
      try {
        signed = signSnowflakeJwt({
          account,
          user,
          privateKeyPem,
          passphrase,
          nowSeconds: Math.floor(runtime.now() / 1000),
        });
      } catch (error) {
        // The connection's fault — a key that is not a key — never the proxy's.
        if (error instanceof SnowflakeKeyError) {
          throw new InvalidCredentialFieldError("privateKey", error.message);
        }
        throw error;
      }

      const derived: CredentialFields = { token: signed.token, signature };
      runtime.cache.set(
        key,
        derived,
        (SNOWFLAKE_JWT_LIFETIME_SECONDS - SNOWFLAKE_JWT_REFRESH_SKEW_SECONDS) * 1000,
      );
      return derived;
    },
  },
};

/**
 * RFC 6749 §5.1's success body, reduced to what the plugin uses. `token_type` is compared
 * case-insensitively because servers disagree on its case; anything but bearer is not a token
 * this scheme knows how to send. `expires_in` is optional in the RFC and absent in practice often
 * enough to have a default.
 */
function parseTokenResponse(
  bytes: Uint8Array,
): { accessToken: string; expiresInSeconds: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
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
  };
}
