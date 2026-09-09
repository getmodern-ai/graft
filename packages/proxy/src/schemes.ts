import { createHash, createHmac } from "node:crypto";

import {
  clientAuthOf,
  isTokenExpiring,
  OAUTH2_DEFAULT_TOKEN_LIFETIME_MS,
  OAUTH2_TOKEN_SKEW_MS,
  requestToken,
  type TokenResponse,
  tokenEndpointOf,
  tokenExpiresAt,
} from "./oauth";
import {
  CredentialRefreshError,
  DerivedCredentialError,
  InvalidCredentialFieldError,
  MissingCredentialFieldError,
  MissingSchemeParameterError,
} from "./scheme-errors";
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
 * Four send what they hold. Four do work first: `oauth2_client_credentials` *derives* an access
 * token from the client id and secret, `oauth_authorization_code` sends the access token a
 * person's consent yielded and *refreshes* it with the refresh token when it is spent (ADR 0005),
 * `snowflake_keypair_jwt` signs a short-lived JWT with the connection's private key, and
 * `unleashed_hmac` signs the query string per call. The `derive` hook is the shape the first three
 * need — an async step that runs once before the vendor is called and once more, on demand, when
 * the vendor answers 401. Each plugin also *names* the headers it would set (`headerNames`), which
 * is all a dry run needs of it.
 *
 * The field names each plugin reads are the tables in `credential-fields.ts`, not a property here:
 * that file is import-free because the console reaches it, and this one imports `node:crypto`.
 * `schemes.test.ts` holds each plugin to its row. The errors a plugin throws are `scheme-errors.ts`,
 * re-exported below; the token-endpoint conversation two of them share is `oauth.ts`. Copied from
 * Cando (ADR 0011); the Snowflake recipe is Modern's, re-expressed as a plugin.
 */

export { OAUTH2_DEFAULT_TOKEN_LIFETIME_MS, OAUTH2_TOKEN_SKEW_MS } from "./oauth";
export {
  type CredentialIncompleteRefusal,
  CredentialRefreshError,
  credentialIncompleteRefusal,
  DerivedCredentialError,
  InvalidCredentialFieldError,
  InvalidSchemeParameterError,
  isSchemeConfigurationError,
  MissingCredentialFieldError,
  MissingSchemeParameterError,
} from "./scheme-errors";

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

function field(credential: CredentialFields, name: string): string {
  const value = credential[name];
  if (value === undefined || value === "") throw new MissingCredentialFieldError(name);
  return value;
}

/** A field the scheme uses when it is there — the optional and issued tables name them. */
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

/**
 * A digest of the tokens a stored authorization-code credential holds — what a cached refresh is
 * keyed to. A cache entry made *from* one stored pair is answered only to a caller holding that same
 * pair: the call that arrives after the refreshed record was written reads the new tokens and gets
 * nothing stale; the call that decrypted the old record a moment before the write gets the token the
 * refresh bought rather than starting another. Never the tokens themselves in the key.
 */
function storedTokenSignature(accessToken: string | undefined, refreshToken: string | undefined) {
  return createHash("sha256")
    .update(`${accessToken ?? ""}\n${refreshToken ?? ""}`)
    .digest("base64url");
}

/** The cache's lifetime for a token the endpoint just issued: its own, less flight time. */
function cacheLifetimeMs(response: TokenResponse): number {
  const lifetime =
    response.expiresInSeconds === null
      ? OAUTH2_DEFAULT_TOKEN_LIFETIME_MS
      : response.expiresInSeconds * 1000;
  return lifetime - OAUTH2_TOKEN_SKEW_MS;
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

      const endpoint = tokenEndpointOf(config.tokenUrl);
      const clientId = field(credential, "clientId");
      const clientSecret = field(credential, "clientSecret");
      const clientAuth = clientAuthOf(config, "basic");

      const grant: Record<string, string> = { grant_type: "client_credentials" };
      if (config.scopes) grant.scope = config.scopes;
      const token = await requestToken(
        { endpoint, clientId, clientSecret, clientAuth, grant },
        runtime.upstreamFetch,
        runtime.signal,
      );

      const derived: CredentialFields = { accessToken: token.accessToken };
      runtime.cache.set(key, derived, cacheLifetimeMs(token));
      return derived;
    },
  },

  /**
   * RFC 6749 §4.1, with a client the person registered at the vendor (ADR 0005). The stored record
   * is the client secret the person entered plus what the consent yielded — `accessToken`,
   * `refreshToken`, `expiresAt` (`SCHEME_ISSUED_CREDENTIAL_FIELDS`), written by the host's callback
   * route; the client id, the endpoints and the scopes are `schemeConfig`. The wire credential is
   * the stored access token, sent as it is while it is good. When it is within the skew of its
   * expiry, or the vendor answers 401, `derive` buys a fresh one with the refresh token
   * (`grant_type=refresh_token`, the client in the body unless `clientAuth: basic`), hands the
   * rotated record to `runtime.storeCredential` so the next process sends the new token, and caches
   * it keyed to the record it was made from. The refresh runs **single-flight per connection**
   * (`runtime.once`): two concurrent calls that both decrypted the expired token make one request.
   *
   * What it cannot make good it says: no token at all is `consent_required`, refused before the
   * vendor is asked; a token the endpoint will not refresh is `refresh_failed`, and the ladder
   * sends the stale token so the vendor's own 401 reaches the caller (`credential-source.ts`).
   */
  oauth_authorization_code: {
    apply(target, credential) {
      target.headers.set("authorization", `Bearer ${field(credential, "accessToken")}`);
    },
    headerNames() {
      return ["authorization"];
    },
    async derive(credential, config, runtime, { refresh }) {
      // The one field the person entered is read first, so a record missing it refuses by name
      // before anything is said about tokens.
      const clientSecret = field(credential, "clientSecret");
      const accessToken = optionalField(credential, "accessToken");
      const refreshToken = optionalField(credential, "refreshToken");
      const expiresAt = optionalField(credential, "expiresAt");
      const key = `oauth_authorization_code:${runtime.connectionId}`;
      const from = storedTokenSignature(accessToken, refreshToken);

      if (!refresh) {
        const cached = runtime.cache.get(key);
        if (cached && cached.from === from) return { accessToken: field(cached, "accessToken") };
        if (accessToken && !isTokenExpiring(expiresAt, runtime.now())) return { accessToken };
      } else {
        runtime.cache.delete(key);
      }

      if (!accessToken && !refreshToken) {
        throw new CredentialRefreshError(
          "The connection awaits the person's consent at the vendor; complete it in the console",
          "consent_required",
        );
      }
      if (!refreshToken) {
        throw new CredentialRefreshError(
          "The stored access token is past its lifetime and the vendor issued no refresh token",
          "refresh_failed",
        );
      }

      const clientId = parameter(config, "clientId");
      const clientAuth = clientAuthOf(config, "body");
      const endpoint = tokenEndpointOf(config.tokenUrl);

      const rotated = await runtime.once(key, async () => {
        let token: TokenResponse;
        try {
          token = await requestToken(
            {
              endpoint,
              clientId,
              clientSecret,
              clientAuth,
              grant: { grant_type: "refresh_token", refresh_token: refreshToken },
            },
            runtime.upstreamFetch,
            runtime.signal,
          );
        } catch (error) {
          if (error instanceof DerivedCredentialError && error.reason === "token_exchange_failed") {
            throw new CredentialRefreshError(
              `The stored token could not be refreshed: ${error.message}`,
              "refresh_failed",
              { cause: error, upstreamStatus: error.upstreamStatus ?? null },
            );
          }
          throw error;
        }
        // The whole record, rebuilt: a refresh token the endpoint did not rotate is kept, and the old
        // expiry is dropped rather than carried onto a token it says nothing about.
        const nextExpiresAt = tokenExpiresAt(token, runtime.now());
        const record: CredentialFields = {
          clientSecret,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? refreshToken,
          ...(nextExpiresAt ? { expiresAt: nextExpiresAt } : {}),
        };
        runtime.cache.set(key, { accessToken: token.accessToken, from }, cacheLifetimeMs(token));
        await runtime.storeCredential(record);
        return record;
      });
      return { accessToken: field(rotated, "accessToken") };
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
