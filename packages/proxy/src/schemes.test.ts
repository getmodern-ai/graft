import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDerivedCredentialCache } from "./cache";
import { SCHEME_CREDENTIAL_FIELDS, SCHEME_OPTIONAL_CREDENTIAL_FIELDS } from "./credential-fields";
import {
  DerivedCredentialError,
  InvalidCredentialFieldError,
  InvalidSchemeParameterError,
  MissingCredentialFieldError,
  MissingSchemeParameterError,
  OAUTH2_DEFAULT_TOKEN_LIFETIME_MS,
  OAUTH2_TOKEN_SKEW_MS,
  SCHEMES,
  type SchemeTarget,
  SNOWFLAKE_TOKEN_TYPE_HEADER,
  UNLEASHED_CLIENT_TYPE,
} from "./schemes";
import {
  SNOWFLAKE_JWT_LIFETIME_SECONDS,
  SNOWFLAKE_JWT_REFRESH_SKEW_SECONDS,
} from "./snowflake-jwt";
import type { SchemeRuntime, UpstreamRequest, UpstreamResponse } from "./types";
import { AUTH_SCHEMES } from "./types";

/**
 * Each plugin as a pure mutation of a URL and a header set — the scheme table GRA-1 lists, with the
 * field names the handoff form collects pinned alongside. The three schemes that do work first get
 * their own blocks below: Unleashed's signature against a golden vector, the OAuth2 derive step
 * against a recorded upstream, and the Snowflake JWT against its own public key.
 */

function target(url = "https://api.vendor.example/v1/orders?limit=5"): SchemeTarget {
  return { url: new URL(url), headers: new Headers() };
}

function apply(
  scheme: keyof typeof SCHEMES,
  credential: Record<string, string>,
  config = {},
  url?: string,
) {
  const t = target(url);
  SCHEMES[scheme].apply(t, credential, config);
  return t;
}

const RSA = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("scheme plugins", () => {
  it("declares every scheme the connection column knows, and implements each", () => {
    expect(Object.keys(SCHEMES).sort()).toEqual([...AUTH_SCHEMES].sort());
    for (const plugin of Object.values(SCHEMES)) expect(typeof plugin.apply).toBe("function");
  });

  it("api_key_header sets the named header, bare or prefixed", () => {
    expect(
      apply("api_key_header", { apiKey: "k" }, { headerName: "X-Api-Key" }).headers.get(
        "x-api-key",
      ),
    ).toBe("k");
    expect(
      apply(
        "api_key_header",
        { apiKey: "k" },
        { headerName: "Authorization", prefix: "SSWS" },
      ).headers.get("authorization"),
    ).toBe("SSWS k");
  });

  it("api_key_header refuses to run without its header name", () => {
    expect(() => apply("api_key_header", { apiKey: "k" }, {})).toThrow(MissingSchemeParameterError);
  });

  it("api_key_query sets the parameter and keeps the caller's", () => {
    const { url } = apply("api_key_query", { apiKey: "k" }, { queryParam: "key" });
    expect(url.searchParams.get("key")).toBe("k");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("api_key_query knows how to take its parameter back out of a redirect", () => {
    const location = new URL("https://api.vendor.example/v1/orders/?key=k&page=2");
    SCHEMES.api_key_query.scrubRedirect?.(location, { queryParam: "key" });
    expect(location.href).toBe("https://api.vendor.example/v1/orders/?page=2");
  });

  it("bearer and basic set Authorization", () => {
    expect(apply("bearer", { token: "t" }).headers.get("authorization")).toBe("Bearer t");
    expect(apply("basic", { username: "u", password: "p" }).headers.get("authorization")).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
  });

  it("names the credential field that is missing", () => {
    expect(() => apply("basic", { username: "u" })).toThrow(MissingCredentialFieldError);
    expect(() => apply("bearer", { token: "" })).toThrow(/token/);
  });

  it("pins the credential fields each scheme reads from storage", () => {
    expect(SCHEME_CREDENTIAL_FIELDS).toEqual({
      api_key_header: ["apiKey"],
      api_key_query: ["apiKey"],
      bearer: ["token"],
      basic: ["username", "password"],
      oauth2_client_credentials: ["clientId", "clientSecret"],
      unleashed_hmac: ["apiId", "apiKey"],
      snowflake_keypair_jwt: ["privateKey"],
    });
    expect(SCHEME_OPTIONAL_CREDENTIAL_FIELDS).toEqual({
      snowflake_keypair_jwt: ["privateKeyPassphrase"],
    });
  });

  /**
   * The table lives in `credential-fields.ts`, away from the plugins, so the console can take it
   * without the runtime. What keeps the two honest is behavioural: fed exactly the fields its row
   * names, a plugin gets past its field checks; missing any one of them, it refuses and names it. A
   * plugin reading a required field the table does not name fails the first half; a row naming a
   * field the plugin never reads fails the second.
   */
  it("holds every plugin to its row in the table — no field unnamed, none unread", async () => {
    const CONFIG: Partial<Record<keyof typeof SCHEMES, Record<string, string>>> = {
      api_key_header: { headerName: "X-Api-Key" },
      api_key_query: { queryParam: "key" },
      oauth2_client_credentials: { tokenUrl: "https://auth.vendor.example/oauth/token" },
      snowflake_keypair_jwt: { account: "acct", user: "svc" },
    };
    // Past its field checks, a deriving scheme runs into the next thing: the network stub for
    // OAuth2, an unparseable key for Snowflake. Either proves the fields were read first.
    const PAST_THE_FIELDS: Partial<Record<keyof typeof SCHEMES, new (...args: never[]) => Error>> =
      {
        oauth2_client_credentials: DerivedCredentialError,
        snowflake_keypair_jwt: InvalidCredentialFieldError,
      };
    const credentialOf = (fields: readonly string[]) =>
      Object.fromEntries(fields.map((name) => [name, `${name}-value`]));
    const runtime: SchemeRuntime = {
      connectionId: "conn_drift",
      upstreamFetch: async () => {
        throw new Error("network reached");
      },
      signal: new AbortController().signal,
      cache: createDerivedCredentialCache(() => 0),
      now: () => 0,
    };

    for (const scheme of AUTH_SCHEMES) {
      const plugin = SCHEMES[scheme];
      const fields = SCHEME_CREDENTIAL_FIELDS[scheme];
      const config = CONFIG[scheme] ?? {};
      const run = async (credential: Record<string, string>) => {
        if (plugin.derive) return plugin.derive(credential, config, runtime, { refresh: true });
        plugin.apply(target(), credential, config);
      };
      const outcomeOf = (credential: Record<string, string>) =>
        run(credential).then(
          () => null,
          (error: unknown) => error,
        );

      // Every field present: `apply` completes; `derive` gets past the fields.
      const complete = await outcomeOf(credentialOf(fields));
      expect(complete, scheme).not.toBeInstanceOf(MissingCredentialFieldError);
      const expected = PAST_THE_FIELDS[scheme];
      if (expected) expect(complete, scheme).toBeInstanceOf(expected);
      else expect(complete, scheme).toBeNull();

      // Any one field absent: refused before anything else happens, and the refusal names it.
      for (const missing of fields) {
        const error = await outcomeOf(credentialOf(fields.filter((name) => name !== missing)));
        expect(error, `${scheme} without ${missing}`).toBeInstanceOf(MissingCredentialFieldError);
        expect((error as MissingCredentialFieldError).field).toBe(missing);
      }
    }
  });

  it("the two token-minting schemes are the ones that derive their wire credential", () => {
    const deriving = Object.entries(SCHEMES)
      .filter(([, plugin]) => plugin.derive !== undefined)
      .map(([scheme]) => scheme)
      .sort();
    expect(deriving).toEqual(["oauth2_client_credentials", "snowflake_keypair_jwt"]);
  });

  /**
   * `headerNames` is what a dry run previews in place of the request it did not send
   * (`dry-run.ts`), so it is held to `apply`: under the same configuration, the names it lists are
   * exactly the names `apply` sets on a request that arrived with no headers of its own, and a
   * configuration `apply` would refuse it refuses the same way — with no credential in hand.
   */
  it("headerNames lists exactly the headers apply sets, and refuses what apply refuses", () => {
    const CONFIG: Partial<Record<keyof typeof SCHEMES, Record<string, string>>> = {
      api_key_header: { headerName: "X-Vendor-Auth", prefix: "Token" },
      api_key_query: { queryParam: "key" },
      oauth2_client_credentials: { tokenUrl: "https://auth.vendor.example/oauth/token" },
      snowflake_keypair_jwt: { account: "acct", user: "svc" },
    };
    const WIRE: Record<keyof typeof SCHEMES, Record<string, string>> = {
      api_key_header: { apiKey: "k" },
      api_key_query: { apiKey: "k" },
      bearer: { token: "t" },
      basic: { username: "u", password: "p" },
      oauth2_client_credentials: { accessToken: "tok" },
      unleashed_hmac: { apiId: "i", apiKey: "k" },
      snowflake_keypair_jwt: { token: "jwt", signature: "sig" },
    };

    for (const scheme of AUTH_SCHEMES) {
      const config = CONFIG[scheme] ?? {};
      const applied = apply(scheme, WIRE[scheme], config);
      expect([...SCHEMES[scheme].headerNames(config)].sort(), scheme).toEqual(
        [...applied.headers.keys()].sort(),
      );
    }

    expect(() => SCHEMES.api_key_header.headerNames({})).toThrow(MissingSchemeParameterError);
    expect(() => SCHEMES.api_key_query.headerNames({})).toThrow(MissingSchemeParameterError);
  });
});

/**
 * Unleashed's documentation (https://apidocs.unleashedsoftware.com/AuthenticationHelp) gives the
 * recipe and a C# sample but no worked values, so the vector is ours, with the inputs shown: key
 * `unleashed-example-api-key`, query `customerCode=ACME&pageSize=1`. Computed independently with
 * `printf '%s' '<query>' | openssl dgst -sha256 -hmac '<key>' -binary | base64` and with Node's
 * `crypto.createHmac`, agreeing.
 */
describe("unleashed_hmac", () => {
  const KEY = "unleashed-example-api-key";
  const CREDENTIAL = { apiId: "api-id-1", apiKey: KEY };

  it("matches the golden vector for a query string", () => {
    const t = apply(
      "unleashed_hmac",
      CREDENTIAL,
      {},
      "https://api.unleashedsoftware.com/Customers?customerCode=ACME&pageSize=1",
    );
    expect(t.headers.get("api-auth-signature")).toBe(
      "Y8rMI7xJQTwJ3JAvgr94SCCrFI/JyDfmhgUAsoLZipw=",
    );
    expect(t.headers.get("api-auth-id")).toBe("api-id-1");
  });

  it("signs the empty string when there is no query", () => {
    const t = apply(
      "unleashed_hmac",
      CREDENTIAL,
      {},
      "https://api.unleashedsoftware.com/Customers",
    );
    expect(t.headers.get("api-auth-signature")).toBe(
      "jbDoFrVfrPoFJL0syi1G7zvkVWlhGilujZXQ9cZu244=",
    );
  });

  it("signs the query exactly as the URL serialises it, without the ?", () => {
    const t = apply(
      "unleashed_hmac",
      CREDENTIAL,
      {},
      "https://api.unleashedsoftware.com/Products?productCode=A%20B&pageSize=1",
    );
    const wire = t.url.search.slice(1);
    expect(wire).toBe("productCode=A%20B&pageSize=1");
    expect(t.headers.get("api-auth-signature")).toBe(
      createHmac("sha256", KEY).update(wire, "utf8").digest("base64"),
    );
  });

  it("sets Graft's client-type and defaults Accept and Content-Type to JSON", () => {
    const t = apply("unleashed_hmac", CREDENTIAL);
    expect(UNLEASHED_CLIENT_TYPE).toBe("graft/agent");
    expect(t.headers.get("client-type")).toBe(UNLEASHED_CLIENT_TYPE);
    expect(t.headers.get("accept")).toBe("application/json");
    expect(t.headers.get("content-type")).toBe("application/json");
  });

  it("leaves a caller's own Accept and Content-Type alone", () => {
    const t = target();
    t.headers.set("accept", "application/xml");
    t.headers.set("content-type", "application/xml");
    SCHEMES.unleashed_hmac.apply(t, CREDENTIAL, {});
    expect(t.headers.get("accept")).toBe("application/xml");
    expect(t.headers.get("content-type")).toBe("application/xml");
  });

  it("names the field that is missing", () => {
    expect(() => apply("unleashed_hmac", { apiId: "i" })).toThrow(/apiKey/);
    expect(() => apply("unleashed_hmac", { apiKey: KEY })).toThrow(/apiId/);
  });
});

describe("oauth2_client_credentials", () => {
  const TOKEN_URL = "https://auth.vendor.example/oauth/token";
  const CONFIG = { tokenUrl: TOKEN_URL, scopes: "orders.read orders.write" };
  const CREDENTIAL = { clientId: "client-id-value", clientSecret: "secret:with/odd%chars" };

  type Responder = (request: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>;

  const tokenResponse = (token: string, expiresIn?: number | string, tokenType = "Bearer") =>
    new Response(
      JSON.stringify({
        access_token: token,
        token_type: tokenType,
        ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  function runtime(responder: Responder, clock: () => number = () => 0) {
    const requests: UpstreamRequest[] = [];
    const rt: SchemeRuntime = {
      connectionId: "conn_1",
      upstreamFetch: async (request) => {
        requests.push(request);
        return responder(request);
      },
      signal: new AbortController().signal,
      cache: createDerivedCredentialCache(clock),
      now: clock,
    };
    return { runtime: rt, requests };
  }

  const derive = (
    rt: SchemeRuntime,
    options: { refresh: boolean } = { refresh: false },
    config: Record<string, string> = CONFIG,
    credential: Record<string, string> = CREDENTIAL,
  ) => {
    const plugin = SCHEMES.oauth2_client_credentials;
    if (!plugin.derive) throw new Error("oauth2_client_credentials has no derive step");
    return plugin.derive(credential, config, rt, options);
  };

  const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

  it("posts a client_credentials grant with the client in a Basic header, form-encoded per RFC 6749 §2.3.1", async () => {
    const h = runtime(() => tokenResponse("tok-1", 3600));

    const wire = await derive(h.runtime);

    expect(wire).toEqual({ accessToken: "tok-1" });
    const request = h.requests[0];
    expect(request?.url).toBe(TOKEN_URL);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(decode(request?.body ?? null)).toBe(
      "grant_type=client_credentials&scope=orders.read+orders.write",
    );
    const expected = `${encodeURIComponent(CREDENTIAL.clientId)}:${encodeURIComponent(CREDENTIAL.clientSecret)}`;
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(expected, "utf8").toString("base64")}`,
    );
  });

  it("puts the client in the form body when clientAuth is body", async () => {
    const h = runtime(() => tokenResponse("tok-1", 3600));

    await derive(h.runtime, { refresh: false }, { tokenUrl: TOKEN_URL, clientAuth: "body" });

    const request = h.requests[0];
    expect(request?.headers.get("authorization")).toBeNull();
    const form = new URLSearchParams(decode(request?.body ?? null) ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CREDENTIAL.clientId);
    expect(form.get("client_secret")).toBe(CREDENTIAL.clientSecret);
    expect(form.has("scope")).toBe(false);
  });

  it("apply sends the derived access token as Bearer, and names it when absent", () => {
    expect(
      apply("oauth2_client_credentials", { accessToken: "tok-1" }).headers.get("authorization"),
    ).toBe("Bearer tok-1");
    expect(() => apply("oauth2_client_credentials", CREDENTIAL)).toThrow(/accessToken/);
  });

  it("answers from the cache inside the token's lifetime and buys again once it is up, less the skew", async () => {
    let clock = 1_000_000;
    let issued = 0;
    const h = runtime(
      () => tokenResponse(`tok-${++issued}`, 120),
      () => clock,
    );

    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
    clock += 120_000 - OAUTH2_TOKEN_SKEW_MS - 1;
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
    expect(h.requests).toHaveLength(1);

    clock += 1;
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-2" });
    expect(h.requests).toHaveLength(2);
  });

  it("a refresh bypasses the cache and replaces what it held", async () => {
    let issued = 0;
    const h = runtime(() => tokenResponse(`tok-${++issued}`, 3600));

    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
    expect(await derive(h.runtime, { refresh: true })).toEqual({ accessToken: "tok-2" });
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-2" });
    expect(h.requests).toHaveLength(2);
  });

  it("trusts a token with no expires_in for the default lifetime, and reads a string expires_in", async () => {
    let clock = 0;
    let issued = 0;
    const h = runtime(
      () => tokenResponse(`tok-${++issued}`, issued === 1 ? undefined : "120"),
      () => clock,
    );

    await derive(h.runtime);
    clock += OAUTH2_DEFAULT_TOKEN_LIFETIME_MS - OAUTH2_TOKEN_SKEW_MS - 1;
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
    clock += 1;
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-2" });
    clock += 120_000 - OAUTH2_TOKEN_SKEW_MS;
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-3" });
  });

  it("caches per connection, not per scheme", async () => {
    let issued = 0;
    const h = runtime(() => tokenResponse(`tok-${++issued}`, 3600));
    const other: SchemeRuntime = { ...h.runtime, connectionId: "conn_2" };

    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
    expect(await derive(other)).toEqual({ accessToken: "tok-2" });
    expect(await derive(h.runtime)).toEqual({ accessToken: "tok-1" });
  });

  it("refuses a rejection from the endpoint with its status and without its body", async () => {
    const h = runtime(
      () =>
        new Response(JSON.stringify({ error: "invalid_client", client_id: CREDENTIAL.clientId }), {
          status: 401,
        }),
    );

    const failure = await derive(h.runtime).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DerivedCredentialError);
    const error = failure as DerivedCredentialError;
    expect(error.reason).toBe("token_exchange_failed");
    expect(error.upstreamStatus).toBe(401);
    expect(error.message).not.toContain(CREDENTIAL.clientId);
    expect(error.message).not.toContain("invalid_client");
  });

  it("refuses an answer that is not a bearer token", async () => {
    const mac = runtime(() => tokenResponse("tok", 3600, "MAC"));
    await expect(derive(mac.runtime)).rejects.toMatchObject({ reason: "token_exchange_failed" });

    const html = runtime(() => new Response("<html>login</html>", { status: 200 }));
    await expect(derive(html.runtime)).rejects.toMatchObject({ reason: "token_exchange_failed" });

    const empty = runtime(
      () => new Response(JSON.stringify({ access_token: "" }), { status: 200 }),
    );
    await expect(derive(empty.runtime)).rejects.toMatchObject({ reason: "token_exchange_failed" });
  });

  it.each([
    "http://auth.vendor.example/token",
    "https://10.0.0.7/token",
    "https://localhost/token",
  ])("refuses the token endpoint %s before calling it", async (tokenUrl) => {
    const h = runtime(() => tokenResponse("tok", 3600));

    await expect(derive(h.runtime, { refresh: false }, { tokenUrl })).rejects.toMatchObject({
      reason: "host_not_public",
    });
    expect(h.requests).toHaveLength(0);
  });

  it("wraps a fetch failure as token_exchange_failed, with the failure as the cause", async () => {
    const cause = new TypeError("fetch failed");
    const h = runtime(() => {
      throw cause;
    });

    const failure = (await derive(h.runtime).catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(DerivedCredentialError);
    expect(failure.cause).toBe(cause);
  });

  it("names a missing tokenUrl, a malformed one, and an invalid clientAuth", async () => {
    const h = runtime(() => tokenResponse("tok", 3600));

    await expect(derive(h.runtime, { refresh: false }, {})).rejects.toBeInstanceOf(
      MissingSchemeParameterError,
    );
    await expect(
      derive(h.runtime, { refresh: false }, { tokenUrl: "not a url" }),
    ).rejects.toBeInstanceOf(InvalidSchemeParameterError);
    await expect(
      derive(h.runtime, { refresh: false }, { tokenUrl: TOKEN_URL, clientAuth: "header" }),
    ).rejects.toBeInstanceOf(InvalidSchemeParameterError);
    expect(h.requests).toHaveLength(0);
  });

  it("names the credential field that is missing before reaching the endpoint", async () => {
    const h = runtime(() => tokenResponse("tok", 3600));

    await expect(
      derive(h.runtime, { refresh: false }, CONFIG, { clientId: "only-an-id" }),
    ).rejects.toBeInstanceOf(MissingCredentialFieldError);
    expect(h.requests).toHaveLength(0);
  });
});

/**
 * The plugin around Modern's Snowflake recipe (ADR 0011): when it signs, what it caches, and what
 * throws a cached token away. The JWT itself — claims, signature, the PEM tolerance — is
 * `snowflake-jwt.test.ts`'s.
 */
describe("snowflake_keypair_jwt", () => {
  const CONFIG = { account: "myorg-myaccount", user: "svc_user" };
  const CREDENTIAL = { privateKey: RSA.privateKey };

  function runtime(clock: () => number = () => 1_700_000_000_000) {
    const rt: SchemeRuntime = {
      connectionId: "conn_s",
      upstreamFetch: async () => {
        throw new Error("the network is never reached");
      },
      signal: new AbortController().signal,
      cache: createDerivedCredentialCache(clock),
      now: clock,
    };
    return rt;
  }

  const derive = (
    rt: SchemeRuntime,
    options: { refresh: boolean } = { refresh: false },
    credential: Record<string, string> = CREDENTIAL,
    config: Record<string, string> = CONFIG,
  ) => {
    const plugin = SCHEMES.snowflake_keypair_jwt;
    if (!plugin.derive) throw new Error("snowflake_keypair_jwt has no derive step");
    return plugin.derive(credential, config, rt, options);
  };

  function decodeJwt(token: string) {
    const [header, payload, signature] = token.split(".");
    return {
      header: JSON.parse(Buffer.from(header ?? "", "base64url").toString()) as { alg: string },
      payload: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
        iss: string;
        sub: string;
        iat: number;
        exp: number;
      },
      verifies: (publicKeyPem: string) =>
        createVerify("RSA-SHA256")
          .update(`${header}.${payload}`)
          .verify(publicKeyPem, Buffer.from(signature ?? "", "base64url")),
    };
  }

  it("signs an RS256 JWT with the account and user from schemeConfig, dated by the runtime's clock", async () => {
    const wire = await derive(runtime(() => 1_700_000_000_000));

    const jwt = decodeJwt(wire.token ?? "");
    expect(jwt.header.alg).toBe("RS256");
    expect(jwt.payload.sub).toBe("MYORG-MYACCOUNT.SVC_USER");
    expect(jwt.payload.iat).toBe(1_700_000_000);
    expect(jwt.payload.exp).toBe(1_700_000_000 + SNOWFLAKE_JWT_LIFETIME_SECONDS);
    expect(jwt.verifies(RSA.publicKey)).toBe(true);
    expect(typeof wire.signature).toBe("string");
  });

  it("apply sends the derived token as a bearer beside the token-type header", () => {
    const t = apply("snowflake_keypair_jwt", { token: "jwt-value", signature: "s" });
    expect(t.headers.get("authorization")).toBe("Bearer jwt-value");
    expect(t.headers.get(SNOWFLAKE_TOKEN_TYPE_HEADER)).toBe("KEYPAIR_JWT");
    expect(() => apply("snowflake_keypair_jwt", CREDENTIAL)).toThrow(/token/);
  });

  it("reuses the cached token inside its lifetime instead of re-signing", async () => {
    let clock = 1_700_000_000_000;
    const rt = runtime(() => clock);

    const first = await derive(rt);
    clock += 100_000;
    const second = await derive(rt);

    expect(second.token).toBe(first.token);
  });

  it("re-signs once the cached token is within the refresh skew of expiry", async () => {
    let clock = 1_700_000_000_000;
    const rt = runtime(() => clock);

    const first = await derive(rt);
    clock += (SNOWFLAKE_JWT_LIFETIME_SECONDS - SNOWFLAKE_JWT_REFRESH_SKEW_SECONDS) * 1000;
    const second = await derive(rt);

    expect(second.token).not.toBe(first.token);
  });

  it("drops the cached token the moment the private key rotates on the same connection", async () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const rt = runtime();

    const before = await derive(rt);
    const after = await derive(rt, { refresh: false }, { privateKey: other.privateKey });

    expect(after.token).not.toBe(before.token);
    expect(decodeJwt(after.token ?? "").verifies(other.publicKey)).toBe(true);
    expect(decodeJwt(after.token ?? "").verifies(RSA.publicKey)).toBe(false);
  });

  it("drops the cached token when the account or user changes on the same connection", async () => {
    const rt = runtime();

    const before = await derive(rt);
    const after = await derive(rt, { refresh: false }, CREDENTIAL, {
      ...CONFIG,
      user: "other_user",
    });

    expect(after.token).not.toBe(before.token);
    expect(decodeJwt(after.token ?? "").payload.sub).toBe("MYORG-MYACCOUNT.OTHER_USER");
  });

  it("a refresh bypasses the cache and replaces what it held", async () => {
    let clock = 1_700_000_000_000;
    const rt = runtime(() => (clock += 1000));

    const first = await derive(rt);
    const refreshed = await derive(rt, { refresh: true });
    const again = await derive(rt);

    expect(refreshed.token).not.toBe(first.token);
    expect(again.token).toBe(refreshed.token);
  });

  it("reads the passphrase when the key is encrypted, and does without it otherwise", async () => {
    const encrypted = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "sekret",
      },
    });

    const wire = await derive(
      runtime(),
      { refresh: false },
      {
        privateKey: encrypted.privateKey,
        privateKeyPassphrase: "sekret",
      },
    );
    expect(decodeJwt(wire.token ?? "").verifies(encrypted.publicKey)).toBe(true);
    await expect(
      derive(runtime(), { refresh: false }, { privateKey: encrypted.privateKey }),
    ).rejects.toBeInstanceOf(InvalidCredentialFieldError);
  });

  it("names a missing account or user, a missing key, and a key that is not a key", async () => {
    await expect(derive(runtime(), { refresh: false }, CREDENTIAL, { user: "u" })).rejects.toThrow(
      MissingSchemeParameterError,
    );
    await expect(
      derive(runtime(), { refresh: false }, CREDENTIAL, { account: "a" }),
    ).rejects.toThrow(MissingSchemeParameterError);
    await expect(derive(runtime(), { refresh: false }, {})).rejects.toBeInstanceOf(
      MissingCredentialFieldError,
    );
    const bad = await derive(runtime(), { refresh: false }, { privateKey: "not-a-pem" }).catch(
      (error: unknown) => error,
    );
    expect(bad).toBeInstanceOf(InvalidCredentialFieldError);
    expect((bad as InvalidCredentialFieldError).field).toBe("privateKey");
    expect((bad as Error).message).not.toContain("not-a-pem");
  });
});
