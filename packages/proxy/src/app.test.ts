import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createProxyApp, DEFAULT_PROXY_OPTIONS, proxyPathFor } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import { CREDENTIAL_REDACTED, REDACTED_HEADER } from "./echo";
import { REFUSAL_HEADER } from "./failure";
import { MAX_REDIRECT_HOPS } from "./redirects";
import { SNOWFLAKE_TOKEN_TYPE_HEADER, UNLEASHED_CLIENT_TYPE } from "./schemes";
import type {
  CapabilityClaims,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  TokenVerdict,
  UpstreamRequest,
  UpstreamResponse,
} from "./types";
import { PrivateAddressError } from "./upstream";

/**
 * The proxy's HTTP boundary — GRA-1's matrix, driven through `app.request()` with a fake
 * connection store, a fake vault and a fake upstream that records what it was handed. What these
 * pin is observable behaviour: a status, a header present or absent on the forwarded request, a
 * body that came back unchanged, one event with the right words on it. The real vault and a real
 * key pair are exercised against this same app in `apps/server`'s suite, where they are bound; here
 * the token verifier is a map so that every refusal category can be reached by name.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const SECRET = "sk_demo_secret_value";
const GOOD = "good-token";
const EXPIRED = "expired-token";
const OTHER_PERSON = "other-person-token";
const OTHER_AGENT = "other-agent-token";
const DRY = "dry-run-token";
const DRY_OTHER_PERSON = "dry-run-other-person-token";
const DRY_OTHER_AGENT = "dry-run-other-agent-token";

const CONNECTION: ProxyConnection = {
  id: "conn_1",
  personId: PERSON,
  authScheme: "api_key_header",
  primaryHost: "https://api.vendor.example/v1",
  hosts: ["api.vendor.example", "files.vendor.example"],
  schemeConfig: { headerName: "x-demo-key" },
  credentialCiphertext: cipherFor("conn_1"),
};

function cipherFor(connectionId: string): Uint8Array {
  return new TextEncoder().encode(`cipher:${connectionId}`);
}

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_1"],
    tool: "execute",
    jti: "jti_1",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    ...overrides,
  };
}

type Responder = (request: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-vendor-request-id": "req_abc" },
    ...init,
  });
}

/**
 * Every token names the connection under test, so a test about some other refusal is not tripped
 * by the scope check; `OTHER_AGENT` is the one whose scope names something else — another agent's
 * connection — which is what a token minted for another agent looks like to the proxy (ADR 0007).
 */
function harness(
  options: Partial<ProxyOptions> = {},
  connection: ProxyConnection = CONNECTION,
  overrides: Partial<ProxyDeps> = {},
) {
  const events: ProxyEvent[] = [];
  const forwarded: UpstreamRequest[] = [];
  const connections = new Map<string, ProxyConnection>([[connection.id, connection]]);
  const credentials = new Map<string, Record<string, string>>([
    [`cipher:${connection.id}`, { apiKey: SECRET }],
  ]);
  const scope = [connection.id];
  const ok = (c: CapabilityClaims): TokenVerdict => ({ ok: true, claims: c });
  const tokens = new Map<string, TokenVerdict>([
    [GOOD, ok(claims({ connections: scope }))],
    [EXPIRED, { ok: false, reason: "expired" }],
    [OTHER_PERSON, ok(claims({ person: "person_2", connections: scope }))],
    [OTHER_AGENT, ok(claims({ agent: "agent_2", connections: ["conn_of_agent_2"] }))],
    [DRY, ok(claims({ dryRun: true, connections: scope }))],
    [DRY_OTHER_PERSON, ok(claims({ dryRun: true, person: "person_2", connections: scope }))],
    [
      DRY_OTHER_AGENT,
      ok(claims({ dryRun: true, agent: "agent_2", connections: ["conn_of_agent_2"] })),
    ],
  ]);
  let responder: Responder = () => jsonResponse({ ok: true });
  let unconfigured = false;

  const deps: ProxyDeps = {
    verifyToken: async (token) =>
      unconfigured
        ? { ok: false, reason: "unconfigured" }
        : (tokens.get(token) ?? { ok: false, reason: "invalid" }),
    jwks: async () => (unconfigured ? null : { keys: [{ kty: "OKP", crv: "Ed25519", x: "x" }] }),
    connections: { get: async (id) => connections.get(id) ?? null },
    decryptCredential: async (ciphertext, scope) => {
      const key = new TextDecoder().decode(ciphertext);
      if (key !== `cipher:${scope.connectionId}`) throw new Error("ciphertext is not this row's");
      const fields = credentials.get(key);
      if (!fields) throw new Error("unknown ciphertext");
      return fields;
    },
    upstreamFetch: async (request) => {
      forwarded.push(request);
      return responder(request);
    },
    log: (event) => events.push(event),
    options,
    ...overrides,
  };

  return {
    app: createProxyApp(deps),
    deps,
    events,
    forwarded,
    connections,
    credentials,
    tokens,
    respond(next: Responder) {
      responder = next;
    },
    unconfigure() {
      unconfigured = true;
    },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const basic = (user: string, password: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`,
});

async function body(response: Response) {
  return response.json() as Promise<{ error: string; reason: string; message: string }>;
}

function decode(bytes: Uint8Array | null) {
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/** Everything the vendor would have seen, as one string, to assert a value is nowhere in it. */
function wire(request: UpstreamRequest | undefined): string {
  if (!request) return "";
  return JSON.stringify({ url: request.url, headers: [...request.headers.entries()] });
}

describe("token carriage", () => {
  it.each([
    ["Authorization: Bearer", { authorization: `Bearer ${GOOD}` }],
    ["Authorization: raw", { authorization: GOOD }],
    ["Authorization: Basic, token as the user", basic(GOOD, "")],
    ["Authorization: Basic, token as the password", basic("", GOOD)],
    ["x-api-key", { "x-api-key": GOOD }],
    ["x-graft-token", { "x-graft-token": GOOD }],
  ])("accepts the token from %s", async (_position, headers) => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", { headers });

    expect(res.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    expect(h.events[0]?.outcome).toBe("forwarded");
    expect(wire(h.forwarded[0])).not.toContain(GOOD);
  });

  it("falls past an Authorization carrying a real basic pair to the Graft header", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", {
      headers: { ...basic("user", "pass"), "x-graft-token": GOOD },
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.headers.get("authorization")).toBeNull();
  });

  it("refuses a request with no token, without touching the store or the vendor", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders");

    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ error: "unauthorized", reason: "token_missing" });
    expect(h.forwarded).toHaveLength(0);
    expect(h.events).toEqual([expect.objectContaining({ outcome: "token_missing", status: 401 })]);
  });

  it("refuses an expired token as expired, so the caller knows to mint again", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(EXPIRED) });

    expect(res.status).toBe(401);
    expect((await body(res)).reason).toBe("token_expired");
    expect(h.events[0]?.outcome).toBe("token_expired");
  });

  it("refuses a malformed or forged token as invalid", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer("not.a.jwt") });

    expect(res.status).toBe(401);
    expect((await body(res)).reason).toBe("token_invalid");
    expect(h.forwarded).toHaveLength(0);
  });

  /** The body is a category, never the credential the caller sent. */
  it("never echoes the token in a refusal", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", {
      headers: bearer("secret-token-value-xyz"),
    });

    expect(await res.text()).not.toContain("secret-token-value-xyz");
    expect(JSON.stringify(h.events)).not.toContain("secret-token-value-xyz");
  });

  it("answers 503 when the deployment has no key pair", async () => {
    const h = harness();
    h.unconfigure();
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(503);
    expect((await body(res)).reason).toBe("proxy_unconfigured");
  });
});

describe("the token must fit the connection", () => {
  it("refuses a token minted for another person", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(OTHER_PERSON) });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("person_mismatch");
    expect(h.forwarded).toHaveLength(0);
    // The event names the connection it was tried against and the person the token claimed.
    expect(h.events[0]).toMatchObject({ connectionId: "conn_1", personId: "person_2" });
  });

  /**
   * ADR 0007: a connection is the person's, and an agent reaches it only when its scope names it.
   * A token minted for another agent of the same person names that agent's connections, so the
   * refusal is that this one is not among them.
   */
  it("refuses a token minted for another agent, whose scope does not name this connection", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(OTHER_AGENT) });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("connection_not_in_token");
    expect(h.forwarded).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ connectionId: "conn_1", agentId: "agent_2" });
  });

  it("refuses a token whose scope names other connections of the same person", async () => {
    const h = harness();
    h.tokens.set("narrow", { ok: true, claims: claims({ connections: ["conn_2", "conn_3"] }) });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer("narrow") });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("connection_not_in_token");
  });

  it("accepts a token whose scope names this connection among others", async () => {
    const h = harness();
    h.tokens.set("wide", { ok: true, claims: claims({ connections: ["conn_0", "conn_1"] }) });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer("wide") });

    expect(res.status).toBe(200);
  });

  it("answers 404 for a connection id that does not exist", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_missing/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(404);
    expect((await body(res)).reason).toBe("connection_unknown");
  });

  it("answers 400 for a connection id that could never be one", async () => {
    const h = harness();
    const res = await h.app.request("/c/bad%20id/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(400);
    expect((await body(res)).reason).toBe("bad_connection_id");
  });

  it("answers 409 for a connection that has no credential yet", async () => {
    const h = harness({}, { ...CONNECTION, credentialCiphertext: null });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect((await body(res)).reason).toBe("connection_not_ready");
  });

  it("answers 409 for a connection with no primary host yet", async () => {
    const h = harness({}, { ...CONNECTION, primaryHost: null });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect((await body(res)).reason).toBe("connection_not_ready");
  });
});

describe("inbound credentials are stripped", () => {
  it("forwards none of the caller's authentication-shaped headers, and does forward the rest", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD}`,
        "x-api-key": "caller-key",
        "x-graft-token": "caller-token",
        "proxy-authorization": "Basic abc",
        cookie: "session=abc",
        host: "evil.example",
        connection: "keep-alive, x-hop",
        "x-hop": "hop",
        "accept-encoding": "gzip",
        "content-type": "application/json",
        "x-request-id": "req_1",
        accept: "application/json",
      },
      body: "{}",
    });

    const sent = h.forwarded[0]?.headers;
    expect(sent).toBeDefined();
    for (const name of [
      "authorization",
      "x-api-key",
      "x-graft-token",
      "proxy-authorization",
      "cookie",
      "host",
      "connection",
      "x-hop",
    ]) {
      expect(sent?.get(name), name).toBeNull();
    }
    expect(sent?.get("accept-encoding")).toBe("identity");
    expect(sent?.get("content-type")).toBe("application/json");
    expect(sent?.get("x-request-id")).toBe("req_1");
    expect(sent?.get("accept")).toBe("application/json");
    // The one credential on the wire is the injected one.
    expect(sent?.get("x-demo-key")).toBe(SECRET);
  });

  it("does not let a caller pre-set the header the scheme owns", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", {
      headers: { ...bearer(GOOD), "x-demo-key": "callers-own-value" },
    });

    expect(h.forwarded[0]?.headers.get("x-demo-key")).toBe(SECRET);
  });
});

/**
 * ADR 0010: an SDK is constructed with a placeholder credential and the proxy as its base, and the
 * placeholder is the capability token itself. Wherever that SDK puts its key — a header, a query
 * parameter, one half of a basic pair — the proxy strips it and the scheme writes the real
 * credential into the position the vendor expects. What these pin is that the vendor receives the
 * real credential and never the token, for a header scheme, a query scheme and basic.
 */
describe("the token is the placeholder credential", () => {
  it("header scheme writing the header the token rode in: the vendor gets the key, never the token", async () => {
    const h = harness({}, { ...CONNECTION, schemeConfig: { headerName: "x-api-key" } });
    const res = await h.app.request("/c/conn_1/orders", { headers: { "x-api-key": GOOD } });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.headers.get("x-api-key")).toBe(SECRET);
    expect(wire(h.forwarded[0])).not.toContain(GOOD);
  });

  it("query scheme, with the token in Authorization and in the caller's own query too", async () => {
    const h = harness(
      {},
      { ...CONNECTION, authScheme: "api_key_query", schemeConfig: { queryParam: "api_key" } },
    );
    const res = await h.app.request(`/c/conn_1/orders?api_key=${GOOD}&limit=5`, {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(200);
    const url = new URL(h.forwarded[0]?.url ?? "");
    expect(url.searchParams.get("api_key")).toBe(SECRET);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.forwarded[0]?.headers.get("authorization")).toBeNull();
    expect(wire(h.forwarded[0])).not.toContain(GOOD);
  });

  it("basic scheme, with the token in Authorization: the vendor gets the real pair", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "basic", schemeConfig: null });
    h.credentials.set("cipher:conn_1", { username: "acme", password: "p@ss" });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("acme:p@ss").toString("base64")}`,
    );
    expect(wire(h.forwarded[0])).not.toContain(GOOD);
  });

  it("the token as one half of a Basic pair, bearer scheme: the vendor gets its bearer", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "bearer", schemeConfig: {} });
    h.credentials.set("cipher:conn_1", { token: "vendor_bearer" });
    for (const headers of [basic(GOOD, ""), basic("", GOOD)]) {
      h.forwarded.length = 0;
      const res = await h.app.request("/c/conn_1/orders", { headers });

      expect(res.status).toBe(200);
      expect(h.forwarded[0]?.headers.get("authorization")).toBe("Bearer vendor_bearer");
      expect(wire(h.forwarded[0])).not.toContain(GOOD);
    }
  });

  /** A public API's connection has no credential to be ready with, and the vendor gets the call as made (GRA-66). */
  it("a none connection with no ciphertext is forwarded as the module sent it, the token swept and nothing injected", async () => {
    const h = harness(
      {},
      { ...CONNECTION, authScheme: "none", schemeConfig: {}, credentialCiphertext: null },
    );
    const res = await h.app.request(
      "/c/conn_1/v1/forecast?latitude=52.52&daily=temperature_2m_max",
      {
        headers: bearer(GOOD),
      },
    );

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.headers.get("authorization")).toBeNull();
    expect(new URL(h.forwarded[0]?.url ?? "").search).toBe(
      "?latitude=52.52&daily=temperature_2m_max",
    );
    expect(wire(h.forwarded[0])).not.toContain(GOOD);
  });

  /** An SDK the proxy has no header name for still cannot leak the token: the sweep is by value. */
  it("sweeps the token out of a header and a query parameter the proxy has no name for", async () => {
    const h = harness();
    const res = await h.app.request(`/c/conn_1/orders?key=${GOOD}&limit=5`, {
      headers: {
        ...bearer(GOOD),
        apikey: GOOD,
        "x-auth-token": `Token ${GOOD}`,
        "x-keep": "keep",
      },
    });

    expect(res.status).toBe(200);
    const sent = h.forwarded[0];
    expect(sent?.headers.get("apikey")).toBeNull();
    expect(sent?.headers.get("x-auth-token")).toBeNull();
    expect(sent?.headers.get("x-keep")).toBe("keep");
    expect(sent?.url).toBe("https://api.vendor.example/v1/orders?limit=5");
    expect(sent?.headers.get("x-demo-key")).toBe(SECRET);
    expect(wire(sent)).not.toContain(GOOD);
  });

  it("keeps the caller's query byte for byte when the token is not in it", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders?x=%2F&y=a%20b&z", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/v1/orders?x=%2F&y=a%20b&z");
  });

  it("names no header the token rode in on a dry-run preview", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: { ...bearer(DRY), apikey: DRY, "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(202);
    const preview = (await res.json()) as { request: { headerNames: string[] } };
    expect(preview.request.headerNames).toEqual(["accept-encoding", "content-type", "x-demo-key"]);
  });
});

describe("the sandbox's instrumentation is stripped", () => {
  it("forwards none of the runtime's tracing, provider or hop-by-hop headers, and does forward the caller's own", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: {
        ...bearer(GOOD),
        // Cased as a sandbox's Node runtime sends them.
        Traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "X-Blaxel-Request-Id": "req_blaxel_1",
        tracestate: "congo=t61rcWkgMzE",
        baggage: "userId=alice",
        "x-blaxel-workspace": "graft",
        "proxy-authentication-info": "nextnonce=abc",
        "keep-alive": "timeout=5",
        te: "trailers",
        "transfer-encoding": "chunked",
        trailer: "Expires",
        upgrade: "h2c",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "node",
        "x-vendor-tenant": "acme",
      },
      body: "{}",
    });

    const sent = h.forwarded[0]?.headers;
    expect(sent).toBeDefined();
    for (const name of [
      "traceparent",
      "tracestate",
      "baggage",
      "x-blaxel-request-id",
      "x-blaxel-workspace",
      "proxy-authentication-info",
      "keep-alive",
      "te",
      "transfer-encoding",
      "trailer",
      "upgrade",
      "authorization",
    ]) {
      expect(sent?.get(name), name).toBeNull();
    }
    expect(sent?.get("content-type")).toBe("application/json");
    expect(sent?.get("accept")).toBe("application/json");
    expect(sent?.get("user-agent")).toBe("node");
    expect(sent?.get("x-vendor-tenant")).toBe("acme");
    // The scheme plugin's header is set after the strip, so it is untouched by it.
    expect(sent?.get("x-demo-key")).toBe(SECRET);
  });
});

describe("an edge's request headers are stripped", () => {
  it("forwards none of a CDN's or a load balancer's stamps, and does forward the caller's own", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: {
        ...bearer(GOOD),
        "X-Amz-Cf-Id": "hV3aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijklmn==",
        "X-Amzn-Trace-Id": "Root=1-68b8a1c2-0123456789abcdef01234567",
        "X-Forwarded-For": "203.0.113.7, 130.176.0.1",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Port": "443",
        "X-Forwarded-Host": "app.graft.example",
        Via: "2.0 abcdef0123456789.cloudfront.net (CloudFront)",
        "CloudFront-Viewer-Country": "GB",
        "CloudFront-Forwarded-Proto": "https",
        "cloudfront-is-mobile-viewer": "false",
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "node",
        "x-vendor-tenant": "acme",
      },
      body: "{}",
    });

    const sent = h.forwarded[0]?.headers;
    expect(sent).toBeDefined();
    for (const name of [
      "x-amz-cf-id",
      "x-amzn-trace-id",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-forwarded-host",
      "via",
      "cloudfront-viewer-country",
      "cloudfront-forwarded-proto",
      "cloudfront-is-mobile-viewer",
      "authorization",
    ]) {
      expect(sent?.get(name), name).toBeNull();
    }
    expect(sent?.get("content-type")).toBe("application/json");
    expect(sent?.get("accept")).toBe("application/json");
    expect(sent?.get("user-agent")).toBe("node");
    expect(sent?.get("x-vendor-tenant")).toBe("acme");
    expect(sent?.get("x-demo-key")).toBe(SECRET);
  });
});

describe("scheme plugins, observable on the forwarded request", () => {
  it("api_key_header with a prefix", async () => {
    const h = harness(
      {},
      { ...CONNECTION, schemeConfig: { headerName: "X-Vendor-Auth", prefix: "Token" } },
    );
    await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.headers.get("x-vendor-auth")).toBe(`Token ${SECRET}`);
  });

  it("api_key_query, beside the caller's own query", async () => {
    const h = harness(
      {},
      { ...CONNECTION, authScheme: "api_key_query", schemeConfig: { queryParam: "api_key" } },
    );
    await h.app.request("/c/conn_1/orders?limit=5&api_key=callers", { headers: bearer(GOOD) });

    const url = new URL(h.forwarded[0]?.url ?? "");
    expect(url.searchParams.get("api_key")).toBe(SECRET);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.forwarded[0]?.headers.get("authorization")).toBeNull();
  });

  it("bearer", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "bearer", schemeConfig: {} });
    h.credentials.set("cipher:conn_1", { token: "vendor_bearer" });
    await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.headers.get("authorization")).toBe("Bearer vendor_bearer");
  });

  it("basic, RFC 7617 over UTF-8", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "basic", schemeConfig: null });
    h.credentials.set("cipher:conn_1", { username: "acme", password: "p@ss wörd" });
    await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    const expected = Buffer.from("acme:p@ss wörd", "utf8").toString("base64");
    expect(h.forwarded[0]?.headers.get("authorization")).toBe(`Basic ${expected}`);
  });

  it("unleashed_hmac, signing the query the vendor receives", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "unleashed_hmac", schemeConfig: null });
    h.credentials.set("cipher:conn_1", { apiId: "api-id-1", apiKey: "unleashed-example-api-key" });
    await h.app.request("/c/conn_1/Customers?customerCode=ACME&pageSize=1", {
      headers: bearer(GOOD),
    });

    const sent = h.forwarded[0];
    expect(sent?.url).toBe("https://api.vendor.example/v1/Customers?customerCode=ACME&pageSize=1");
    expect(sent?.headers.get("api-auth-id")).toBe("api-id-1");
    // The golden vector `schemes.test.ts` pins, seen end to end.
    expect(sent?.headers.get("api-auth-signature")).toBe(
      "Y8rMI7xJQTwJ3JAvgr94SCCrFI/JyDfmhgUAsoLZipw=",
    );
    expect(sent?.headers.get("client-type")).toBe(UNLEASHED_CLIENT_TYPE);
    expect(sent?.headers.get("authorization")).toBeNull();
  });

  it("answers 409 when the decrypted record lacks the field the scheme reads", async () => {
    const h = harness();
    h.credentials.set("cipher:conn_1", { token: "wrong-field" });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect((await body(res)).reason).toBe("credential_incomplete");
  });

  it("answers 500 when the vault refuses the ciphertext, naming the failure's class on the event", async () => {
    const h = harness({}, { ...CONNECTION, credentialCiphertext: cipherFor("conn_other") });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(500);
    expect((await body(res)).reason).toBe("credential_unreadable");
    // The vault's class name and never its message, which is the host's to compose.
    expect(h.events[0]?.failure).toBe("HostDependencyError: decryptCredential threw Error");
    expect(h.forwarded).toHaveLength(0);
  });

  /**
   * `ProxyEvent.failure` never carries a body — and a host dependency's message is the one thing on
   * the failure path the proxy cannot inspect for one, so the guarantee is made by construction:
   * the dependency and the class names, nothing the host wrote (`guardHostDeps`). The store and
   * the vault each throw a message holding a secret here. None of it reaches the event or the
   * caller.
   */
  it("keeps a message a host dependency threw off the event and out of the answer", async () => {
    const LEAK = "sk_live_leaked_in_a_host_message";
    const cases: [string, Partial<ProxyDeps>, string][] = [
      [
        "connections.get",
        {
          connections: {
            get: async () => {
              throw new Error(`row read failed for ${LEAK}`);
            },
          },
        },
        "proxy_error",
      ],
      [
        "decryptCredential",
        {
          decryptCredential: async () => {
            throw new RangeError(`plaintext was ${LEAK}`, { cause: new Error(LEAK) });
          },
        },
        "credential_unreadable",
      ],
    ];

    for (const [dependency, overrides, outcome] of cases) {
      const h = harness({}, CONNECTION, overrides);
      const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

      const text = await res.text();
      expect(h.events[0]?.outcome, dependency).toBe(outcome);
      expect(h.events[0]?.failure, dependency).toContain(
        `HostDependencyError: ${dependency} threw`,
      );
      expect(JSON.stringify(h.events), dependency).not.toContain(LEAK);
      expect(text, dependency).not.toContain(LEAK);
    }
  });

  /** The proxy's own errors and the network's keep their messages: an operator needs the code. */
  it("keeps the message of a failure that is the proxy's or the network's own", async () => {
    const h = harness();
    h.respond(() => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 93.184.216.34"),
      });
    });
    await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(h.events[0]?.failure).toBe(
      "TypeError: fetch failed <- Error: connect ECONNREFUSED 93.184.216.34",
    );
  });
});

describe("host pinning", () => {
  it("prepends the primary host's base path and carries the vendor path and query", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders/42?expand=lines&x=%2F", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/v1/orders/42?expand=lines&x=%2F");
    expect(h.events[0]).toMatchObject({ host: "api.vendor.example", path: "/orders/42" });
  });

  it("a bare connection path reaches the primary host's base URL itself", async () => {
    const h = harness();
    await h.app.request("/c/conn_1", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/v1/");
  });

  it("a protocol-relative vendor path cannot move the host", async () => {
    const h = harness();
    await h.app.request("/c/conn_1//evil.example/steal", { headers: bearer(GOOD) });

    expect(new URL(h.forwarded[0]?.url ?? "").host).toBe("api.vendor.example");
  });

  it("a spoofed Host header is discarded", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", { headers: { ...bearer(GOOD), host: "evil.example" } });

    expect(new URL(h.forwarded[0]?.url ?? "").host).toBe("api.vendor.example");
    expect(h.forwarded[0]?.headers.get("host")).toBeNull();
  });

  it("answers 400 for a primary host that is not a URL", async () => {
    const h = harness({}, { ...CONNECTION, primaryHost: "not a url" });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(400);
    expect((await body(res)).reason).toBe("bad_target");
    expect(h.forwarded).toHaveLength(0);
  });

  it("works mounted under a prefix, as the server mounts it", async () => {
    const h = harness();
    const server = new Hono().route("/api/proxy", h.app);
    const res = await server.request("/api/proxy/c/conn_1/orders?limit=1", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/v1/orders?limit=1");
    expect(h.events[0]?.path).toBe("/orders");
  });
});

/**
 * ADR 0010's host set: one connection declares the hosts it may reach, and the explicit form
 * `/c/<id>/h/<host>/<path>` names one of them — what an SDK pointed at `ctx.proxyBase(host)` sends.
 * A host outside the set is refused by name; the primary form is untouched.
 */
describe("the host segment", () => {
  it("forwards to a declared secondary host from its root, carrying the path and query", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/h/files.vendor.example/v2/upload?part=1", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.url).toBe("https://files.vendor.example/v2/upload?part=1");
    expect(h.forwarded[0]?.headers.get("x-demo-key")).toBe(SECRET);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      host: "files.vendor.example",
      path: "/v2/upload",
      hasQuery: true,
    });
  });

  /** An SDK knows its own paths, so the explicit form never prepends the primary's base path. */
  it("resolves the primary host explicitly from its origin, not its base path", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/h/api.vendor.example/orders", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/orders");
  });

  it("a bare host segment reaches that host's root", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/h/files.vendor.example", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://files.vendor.example/");
    expect(h.events[0]?.path).toBe("/");
  });

  it("refuses a host outside the set, before touching the vendor, naming the reason", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/h/evil.example/steal", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ error: "forbidden", reason: "host_not_in_set" });
    expect(h.forwarded).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      outcome: "host_not_in_set",
      status: 403,
      connectionId: "conn_1",
      host: null,
      path: "/steal",
    });
  });

  it("refuses the marker with no host after it", async () => {
    for (const path of ["/c/conn_1/h", "/c/conn_1/h/", "/c/conn_1/h//orders"]) {
      const h = harness();
      const res = await h.app.request(path, { headers: bearer(GOOD) });

      expect(res.status, path).toBe(403);
      expect((await body(res)).reason, path).toBe("host_not_in_set");
      expect(h.forwarded, path).toHaveLength(0);
    }
  });

  it("compares the host segment case-insensitively", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/h/FILES.Vendor.Example/x", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.url).toBe("https://files.vendor.example/x");
  });

  it("refuses a segment that is not a hostname, whatever it decodes to", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/h/files.vendor.example%2Fevil/x", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("host_not_in_set");
  });

  /** The marker's one cost, and its remedy: `/h/...` on the primary is spelled explicitly. */
  it("reaches a vendor path whose first segment is the marker through the explicit form", async () => {
    const h = harness();
    const implicit = await h.app.request("/c/conn_1/h/items", { headers: bearer(GOOD) });
    expect(implicit.status).toBe(403);
    expect((await body(implicit)).reason).toBe("host_not_in_set");

    const explicit = await h.app.request("/c/conn_1/h/api.vendor.example/h/items", {
      headers: bearer(GOOD),
    });
    expect(explicit.status).toBe(200);
    expect(h.forwarded[0]?.url).toBe("https://api.vendor.example/h/items");
  });

  it("refuses a declared host that is a private literal as not public", async () => {
    const h = harness({}, { ...CONNECTION, hosts: ["api.vendor.example", "10.0.0.5"] });
    const res = await h.app.request("/c/conn_1/h/10.0.0.5/admin", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("host_not_public");
    expect(h.forwarded).toHaveLength(0);
  });

  it("works under a mount prefix, with the event carrying the vendor path alone", async () => {
    const h = harness();
    const server = new Hono().route("/api/proxy", h.app);
    const res = await server.request("/api/proxy/c/conn_1/h/files.vendor.example/x?y=1", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[0]?.url).toBe("https://files.vendor.example/x?y=1");
    expect(h.events[0]).toMatchObject({ host: "files.vendor.example", path: "/x" });
  });

  it("proxyPathFor builds the paths the proxy parses", async () => {
    expect(proxyPathFor("conn_1")).toBe("/c/conn_1");
    expect(proxyPathFor("conn_1", "Files.Vendor.Example")).toBe("/c/conn_1/h/files.vendor.example");
    const h = harness();
    await h.app.request(`${proxyPathFor("conn_1", "files.vendor.example")}/v2/x`, {
      headers: bearer(GOOD),
    });
    expect(h.forwarded[0]?.url).toBe("https://files.vendor.example/v2/x");
  });

  it("previews the explicit host on a dry-run write", async () => {
    const h = harness();
    const res = await h.app.request("/c/conn_1/h/files.vendor.example/upload", {
      method: "POST",
      headers: bearer(DRY),
      body: "{}",
    });

    expect(res.status).toBe(202);
    const preview = (await res.json()) as { request: { host: string; path: string } };
    expect(preview.request).toMatchObject({ host: "files.vendor.example", path: "/upload" });
    expect(h.events[0]).toMatchObject({ host: "files.vendor.example", path: "/upload" });
  });
});

describe("private ranges are refused", () => {
  it.each([
    "https://10.0.0.5/api",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost:8443",
    "https://[::1]/",
    "https://db.internal/",
  ])("refuses a primary host of %s before reaching the network", async (primaryHost) => {
    const h = harness({}, { ...CONNECTION, primaryHost });
    const res = await h.app.request("/c/conn_1/anything", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("host_not_public");
    expect(h.forwarded).toHaveLength(0);
  });

  /** The resolver's refusal surfaces through the fetch's `cause` chain (undici wraps it). */
  it("refuses a public name that resolves to a private address", async () => {
    const h = harness();
    h.respond(() => {
      throw new TypeError("fetch failed", {
        cause: new PrivateAddressError("api.vendor.example", "10.1.2.3"),
      });
    });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect(res.headers.get(REFUSAL_HEADER)).toBe("host_not_public");
    expect(await body(res)).toEqual({
      error: "forbidden",
      reason: "host_not_public",
      message: "The vendor host resolves to a private address",
      code: "PrivateAddressError",
      host: "api.vendor.example",
    });
    expect(h.events[0]?.outcome).toBe("host_not_public");
  });

  /** The literal check refuses before any fetch: no vendor went unanswered, so no mark (GRA-79). */
  it("does not mark the literal check's host_not_public: no vendor was asked", async () => {
    const h = harness({}, { ...CONNECTION, hosts: ["api.vendor.example", "10.0.0.5"] });
    const res = await h.app.request("/c/conn_1/h/10.0.0.5/admin", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({
      error: "forbidden",
      reason: "host_not_public",
      message: "The vendor host is not a public address",
    });
    expect(res.headers.get(REFUSAL_HEADER)).toBeNull();
  });
});

describe("redirects", () => {
  const redirectTo = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  it("returns a vendor redirect to the caller rather than following it", async () => {
    const h = harness();
    h.respond(() => redirectTo("https://elsewhere.example/steal"));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.example/steal");
    expect(h.forwarded).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ outcome: "redirect_returned", upstreamStatus: 302 });
  });

  it("does not follow even a same-host redirect while the flag is off", async () => {
    const h = harness();
    h.respond(() => redirectTo("/v1/orders-v2"));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(h.forwarded).toHaveLength(1);
  });

  it("returns a redirect to another host in the set while the flag is off", async () => {
    const h = harness();
    h.respond(() => redirectTo("https://files.vendor.example/download/1"));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://files.vendor.example/download/1");
    expect(h.forwarded).toHaveLength(1);
  });

  it("follows a same-host redirect under the flag, re-applying the credential", async () => {
    const h = harness({ followRedirects: true });
    h.respond((request) =>
      request.url.endsWith("/v1/orders")
        ? redirectTo("/v1/orders-v2?page=2")
        : jsonResponse({ moved: true }),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: true });
    expect(h.forwarded.map((r) => r.url)).toEqual([
      "https://api.vendor.example/v1/orders",
      "https://api.vendor.example/v1/orders-v2?page=2",
    ]);
    expect(h.forwarded[1]?.headers.get("x-demo-key")).toBe(SECRET);
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", redirectHops: 1 });
  });

  /** ADR 0010: the set is what the person agreed to, so a hop inside it is still pinned. */
  it("follows a redirect to another host in the set under the flag, re-applying the credential", async () => {
    const h = harness({ followRedirects: true });
    h.respond((request) =>
      request.url.startsWith("https://api.vendor.example/")
        ? redirectTo("https://files.vendor.example/download/1")
        : jsonResponse({ bytes: "..." }),
    );
    const res = await h.app.request("/c/conn_1/orders/1/export", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(h.forwarded.map((r) => r.url)).toEqual([
      "https://api.vendor.example/v1/orders/1/export",
      "https://files.vendor.example/download/1",
    ]);
    expect(h.forwarded[1]?.headers.get("x-demo-key")).toBe(SECRET);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      redirectHops: 1,
      host: "api.vendor.example",
    });
  });

  it("still refuses a redirect to a host outside the set under the flag", async () => {
    const h = harness({ followRedirects: true });
    h.respond(() => redirectTo("https://elsewhere.example/steal"));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(h.forwarded).toHaveLength(1);
  });

  it("stops after the hop limit and returns the last redirect", async () => {
    const h = harness({ followRedirects: true });
    h.respond(() => redirectTo("/v1/loop"));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(h.forwarded).toHaveLength(MAX_REDIRECT_HOPS + 1);
    expect(h.events[0]?.redirectHops).toBe(MAX_REDIRECT_HOPS);
  });

  it("returns a 307 rather than resending a body", async () => {
    const h = harness({ followRedirects: true });
    h.respond(() => redirectTo("/v1/orders", 307));
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: "{}",
    });

    expect(res.status).toBe(307);
    expect(h.forwarded).toHaveLength(1);
  });

  it("turns a 303 after a POST into a GET, as a browser would", async () => {
    const h = harness({ followRedirects: true });
    h.respond((request) =>
      request.method === "POST" ? redirectTo("/v1/orders/42", 303) : jsonResponse({ id: 42 }),
    );
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(h.forwarded[1]).toMatchObject({ method: "GET", body: null });
  });
});

describe("verbatim pass-through", () => {
  it("returns the vendor's non-2xx status, headers and body unchanged", async () => {
    const h = harness();
    h.respond(
      () =>
        new Response('{"error":"no such order"}', {
          status: 404,
          statusText: "Not Found",
          headers: {
            "content-type": "application/problem+json",
            "x-ratelimit-remaining": "41",
            connection: "close",
            "transfer-encoding": "chunked",
          },
        }),
    );
    const res = await h.app.request("/c/conn_1/orders/9", { headers: bearer(GOOD) });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"no such order"}');
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("41");
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", status: 404, upstreamStatus: 404 });
  });

  it("forwards the request method and body, and counts both directions", async () => {
    const h = harness();
    h.respond(() => jsonResponse({ id: 1 }));
    const payload = JSON.stringify({ lines: [{ sku: "A", qty: 2 }] });
    await h.app.request("/c/conn_1/orders", {
      method: "PUT",
      headers: { ...bearer(GOOD), "content-type": "application/json" },
      body: payload,
    });

    expect(h.forwarded[0]?.method).toBe("PUT");
    expect(decode(h.forwarded[0]?.body ?? null)).toBe(payload);
    expect(h.events[0]).toMatchObject({
      requestBytes: Buffer.byteLength(payload),
      responseBytes: Buffer.byteLength(JSON.stringify({ id: 1 })),
    });
  });

  it("sends no body on GET even if the caller attached one", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", { method: "GET", headers: bearer(GOOD) });

    expect(h.forwarded[0]?.body).toBeNull();
    expect(h.events[0]?.requestBytes).toBe(0);
  });

  it("drops a content-encoding the fetch already decoded", async () => {
    const h = harness();
    h.respond(
      () =>
        new Response("plain bytes", {
          status: 200,
          headers: { "content-encoding": "gzip", "content-length": "9999" },
        }),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(await res.text()).toBe("plain bytes");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("passes a 204 through with no body", async () => {
    const h = harness();
    h.respond(() => new Response(null, { status: 204 }));
    const res = await h.app.request("/c/conn_1/orders/9", {
      method: "DELETE",
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers a HEAD with the vendor's headers and no body", async () => {
    const h = harness();
    h.respond(() => new Response(null, { status: 200, headers: { "x-total": "12" } }));
    const res = await h.app.request("/c/conn_1/orders", { method: "HEAD", headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-total")).toBe("12");
    expect(h.forwarded[0]?.method).toBe("HEAD");
  });
});

describe("limits", () => {
  it("refuses a request body over the cap on its declared length alone", async () => {
    const h = harness({ maxBodyBytes: 16 });
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: { ...bearer(GOOD), "content-length": "17" },
      body: "x".repeat(17),
    });

    expect(res.status).toBe(413);
    expect((await body(res)).reason).toBe("request_too_large");
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses a request body over the cap while reading it", async () => {
    const h = harness({ maxBodyBytes: 16 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(10)));
        controller.enqueue(new TextEncoder().encode("x".repeat(10)));
        controller.close();
      },
    });
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: stream,
      // Required by the fetch spec for a streamed request body.
      duplex: "half",
    });

    expect(res.status).toBe(413);
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses a vendor response over the cap as a 502, on its declared length", async () => {
    const h = harness({ maxBodyBytes: 16 });
    let read = false;
    h.respond(() => ({
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": "1000000" }),
      // `highWaterMark: 0`, or the stream machinery would call `pull` at construction to fill
      // its queue and the probe would fire before the proxy had touched the body.
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            read = true;
          },
        },
        { highWaterMark: 0 },
      ),
    }));
    const res = await h.app.request("/c/conn_1/export", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    expect((await body(res)).reason).toBe("response_too_large");
    expect(read).toBe(false);
    expect(h.events[0]).toMatchObject({ outcome: "response_too_large", upstreamStatus: 200 });
  });

  it("refuses a vendor response over the cap while reading it", async () => {
    const h = harness({ maxBodyBytes: 16 });
    h.respond(() => new Response("y".repeat(17), { status: 200 }));
    const res = await h.app.request("/c/conn_1/export", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    expect((await body(res)).reason).toBe("response_too_large");
  });

  it("times out a caller that never finishes sending its body, before touching the vendor", async () => {
    const h = harness({ upstreamTimeoutMs: 20 });
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
    });
    const res = await h.app.request("/c/conn_1/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: stalled,
      duplex: "half",
    });

    expect(res.status).toBe(408);
    expect((await body(res)).reason).toBe("request_timeout");
    expect(h.forwarded).toHaveLength(0);
    expect(h.events).toEqual([
      expect.objectContaining({ outcome: "request_timeout", status: 408 }),
    ]);
  });

  it("times out an upstream that never answers", async () => {
    const h = harness({ upstreamTimeoutMs: 20 });
    h.deps.upstreamFetch = (_request, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const app = createProxyApp(h.deps);
    const res = await app.request("/c/conn_1/slow", { headers: bearer(GOOD) });

    expect(res.status).toBe(504);
    expect(res.headers.get(REFUSAL_HEADER)).toBe("upstream_timeout");
    expect(await body(res)).toEqual({
      error: "gateway_timeout",
      reason: "upstream_timeout",
      message: "The vendor did not answer within the time limit",
      code: "TimeoutError",
      host: "api.vendor.example",
    });
    expect(h.events[0]?.outcome).toBe("upstream_timeout");
  });

  it("answers 502 when the vendor cannot be reached, marked as the proxy's with the cause's code and the host", async () => {
    const h = harness();
    h.respond(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.9:443"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    expect(res.headers.get(REFUSAL_HEADER)).toBe("upstream_unreachable");
    expect(await body(res)).toEqual({
      error: "bad_gateway",
      reason: "upstream_unreachable",
      message: "The vendor could not be reached",
      code: "ECONNREFUSED",
      host: "api.vendor.example",
    });
    expect(h.events[0]?.failure).toContain("ECONNREFUSED");
  });

  /**
   * The `x-graft-` response namespace is the proxy's alone (Greptile on #59): a vendor that speaks
   * in it — to end an acquire job as `vendor_unreachable`, or to pass its answer off as a dry-run
   * preview — is stripped before the proxy sets its own, and the proxy's own still arrive.
   */
  it("drops every x-graft-* header a vendor sends, and keeps the proxy's own", async () => {
    const h = harness();
    h.respond(() =>
      jsonResponse(
        { items: [] },
        {
          headers: {
            "content-type": "application/json",
            "X-Graft-Refusal": "upstream_unreachable",
            [DRY_RUN_HEADER]: "intercepted",
            "x-graft-anything-later": "1",
            "x-vendor-request-id": "req_abc",
          },
        },
      ),
    );
    const plain = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(plain.status).toBe(200);
    expect(plain.headers.get(REFUSAL_HEADER)).toBeNull();
    expect(plain.headers.get(DRY_RUN_HEADER)).toBeNull();
    expect([...plain.headers.keys()].filter((name) => name.startsWith("x-graft-"))).toEqual([]);
    expect(plain.headers.get("x-vendor-request-id")).toBe("req_abc");
    expect(await plain.json()).toEqual({ items: [] });

    // Under the dry-run claim the marker is the proxy's `forwarded`, never the vendor's word.
    const dry = await h.app.request("/c/conn_1/orders", { headers: bearer(DRY) });
    expect(dry.headers.get(DRY_RUN_HEADER)).toBe("forwarded");
    expect(dry.headers.get(REFUSAL_HEADER)).toBeNull();

    // The proxy's own refusal still carries its mark once the vendor is out of the picture.
    h.respond(() => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    });
    const refused = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(refused.status).toBe(502);
    expect(refused.headers.get(REFUSAL_HEADER)).toBe("upstream_unreachable");
  });

  /** The vendor answered: its 5xx is its own, and so is a status the proxy could not hand back. */
  it("marks neither a vendor's own 502 nor the proxy's refusal of an unusable status", async () => {
    const h = harness();
    h.respond(() => jsonResponse({ error: "upstream down" }, { status: 502 }));
    const own = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(own.status).toBe(502);
    expect(own.headers.get(REFUSAL_HEADER)).toBeNull();
    expect(await own.json()).toEqual({ error: "upstream down" });

    h.respond(() => ({ status: 999, statusText: "", headers: new Headers(), body: null }));
    const unusable = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(unusable.status).toBe(502);
    expect(unusable.headers.get(REFUSAL_HEADER)).toBeNull();
    expect(await body(unusable)).toEqual({
      error: "bad_gateway",
      reason: "upstream_unreachable",
      message: "The vendor answered an unusable status",
    });
  });

  it("has the documented defaults", () => {
    expect(DEFAULT_PROXY_OPTIONS).toEqual({
      followRedirects: false,
      upstreamTimeoutMs: 30_000,
      maxBodyBytes: 10 * 1024 * 1024,
    });
  });
});

/**
 * The dry-run claim (CONTEXT.md, *Dry run*). Reads pass to the vendor exactly as a normal call and
 * come back marked; writes stop after every existing check and before a credential is touched, and
 * the caller gets a preview of what would have left. The claim is enforced from the token, so
 * nothing a sandbox does can write through a dry run.
 */
describe("the dry-run claim", () => {
  type Preview = {
    dryRun: boolean;
    intercepted: boolean;
    request: {
      method: string;
      host: string;
      path: string;
      hasQuery: boolean;
      headerNames: string[];
      bodyBytes: number;
      body: string;
      bodyEncoding: string;
    };
  };
  const preview = (response: Response) => response.json() as Promise<Preview>;

  describe("reads are forwarded", () => {
    it("forwards a GET with the credential injected, marks the answer, and passes the vendor's body verbatim", async () => {
      const h = harness();
      h.respond(() => jsonResponse({ orders: [1, 2] }));
      const res = await h.app.request("/c/conn_1/orders?limit=2", { headers: bearer(DRY) });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orders: [1, 2] });
      expect(res.headers.get("x-graft-dry-run")).toBe("forwarded");
      // The vendor's own headers still pass through beside the marker.
      expect(res.headers.get("x-vendor-request-id")).toBe("req_abc");
      expect(h.forwarded).toHaveLength(1);
      expect(h.forwarded[0]).toMatchObject({
        method: "GET",
        url: "https://api.vendor.example/v1/orders?limit=2",
      });
      expect(h.forwarded[0]?.headers.get("x-demo-key")).toBe(SECRET);
      expect(h.events[0]).toMatchObject({
        outcome: "forwarded",
        status: 200,
        upstreamStatus: 200,
        dryRun: true,
        dryRunOutcome: "forwarded",
      });
    });

    it("forwards a HEAD the same way, with the vendor's headers and no body", async () => {
      const h = harness();
      h.respond(() => new Response(null, { status: 200, headers: { "x-total": "12" } }));
      const res = await h.app.request("/c/conn_1/orders", { method: "HEAD", headers: bearer(DRY) });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-total")).toBe("12");
      expect(res.headers.get("x-graft-dry-run")).toBe("forwarded");
      expect(await res.text()).toBe("");
      expect(h.forwarded[0]?.method).toBe("HEAD");
      expect(h.events[0]).toMatchObject({ dryRun: true, dryRunOutcome: "forwarded" });
    });

    it("returns a vendor redirect on a read as it always has, marked forwarded", async () => {
      const h = harness();
      h.respond(() => new Response(null, { status: 302, headers: { location: "/v1/orders-v2" } }));
      const res = await h.app.request("/c/conn_1/orders", { headers: bearer(DRY) });

      expect(res.status).toBe(302);
      expect(res.headers.get("x-graft-dry-run")).toBe("forwarded");
      expect(h.events[0]).toMatchObject({
        outcome: "redirect_returned",
        dryRun: true,
        dryRunOutcome: "forwarded",
      });
    });

    /** Set as the request leaves: a read the vendor never answered was still forwarded. */
    it("records a read as forwarded even when the vendor cannot be reached", async () => {
      const h = harness();
      h.respond(() => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      });
      const res = await h.app.request("/c/conn_1/orders", { headers: bearer(DRY) });

      expect(res.status).toBe(502);
      expect(h.events[0]).toMatchObject({
        outcome: "upstream_unreachable",
        dryRun: true,
        dryRunOutcome: "forwarded",
      });
    });
  });

  describe("writes are intercepted", () => {
    const payload = JSON.stringify({ lines: [{ sku: "A", qty: 2 }] });

    it.each(["POST", "PUT", "PATCH", "DELETE"])(
      "answers a %s with the 202 preview and never reaches the vendor",
      async (method) => {
        const h = harness();
        const res = await h.app.request("/c/conn_1/orders/42?expand=lines", {
          method,
          headers: {
            ...bearer(DRY),
            "content-type": "application/json",
            "x-request-id": "req_1",
            accept: "application/json",
          },
          body: payload,
        });

        expect(res.status).toBe(202);
        expect(res.headers.get("x-graft-dry-run")).toBe("intercepted");
        expect(res.headers.get("content-type")).toBe("application/json");
        const body = await preview(res);
        expect(body).toEqual({
          dryRun: true,
          intercepted: true,
          request: {
            method,
            host: "api.vendor.example",
            // The resolved path at the vendor: the primary's base path plus the caller's.
            path: "/v1/orders/42",
            hasQuery: true,
            headerNames: [
              "accept",
              "accept-encoding",
              "content-type",
              "x-demo-key",
              "x-request-id",
            ],
            bodyBytes: Buffer.byteLength(payload),
            body: payload,
            bodyEncoding: "utf-8",
          },
        });
        expect(h.forwarded).toHaveLength(0);
        expect(h.events).toHaveLength(1);
        expect(h.events[0]).toMatchObject({
          outcome: "dry_run_intercepted",
          status: 202,
          upstreamStatus: null,
          method,
          path: "/orders/42",
          hasQuery: true,
          connectionId: "conn_1",
          personId: PERSON,
          agentId: AGENT,
          tool: "execute",
          host: "api.vendor.example",
          requestBytes: Buffer.byteLength(payload),
          redirectHops: 0,
          dryRun: true,
          dryRunOutcome: "intercepted",
          failure: null,
        });
        expect(h.events[0]?.responseBytes).toBeGreaterThan(0);
      },
    );

    /** Names, never values: not the caller's, not the token's, and not the credential's. */
    it("puts header names in the preview and no header value anywhere", async () => {
      const h = harness();
      const res = await h.app.request("/c/conn_1/orders", {
        method: "POST",
        headers: {
          ...bearer(DRY),
          "x-request-id": "req_secret_value",
          "x-vendor-tenant": "acme-tenant",
          cookie: "session=abc",
          "x-demo-key": "callers-own-value",
        },
        body: '{"note":"do-not-log"}',
      });

      const text = await res.text();
      for (const forbidden of [
        "req_secret_value",
        "acme-tenant",
        "session=abc",
        "callers-own-value",
        DRY,
        SECRET,
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
      const body = JSON.parse(text) as Preview;
      expect(body.request.headerNames).toContain("x-request-id");
      expect(body.request.headerNames).toContain("x-vendor-tenant");
      // Stripped inbound credentials do not come back as names either — they were never going out.
      expect(body.request.headerNames).not.toContain("authorization");
      expect(body.request.headerNames).not.toContain("cookie");
      // The scheme's header appears once, by name, whatever the caller tried to pre-set.
      expect(body.request.headerNames.filter((name) => name === "x-demo-key")).toHaveLength(1);
      // And the event carries none of it.
      const event = JSON.stringify(h.events);
      for (const forbidden of ["req_secret_value", "do-not-log", "x-request-id", SECRET]) {
        expect(event, forbidden).not.toContain(forbidden);
      }
    });

    it("never decrypts or exchanges a credential for an intercepted write", async () => {
      let decrypts = 0;
      const h = harness({}, CONNECTION, {
        decryptCredential: async () => {
          decrypts += 1;
          throw new Error("the vault must not be asked during an intercepted write");
        },
      });
      const res = await h.app.request("/c/conn_1/orders", {
        method: "POST",
        headers: bearer(DRY),
        body: "{}",
      });

      expect(res.status).toBe(202);
      expect(decrypts).toBe(0);
      expect(h.forwarded).toHaveLength(0);
    });

    it("previews a signing scheme's write without decrypting, naming the signed headers", async () => {
      const h = harness({}, { ...CONNECTION, authScheme: "unleashed_hmac", schemeConfig: null });
      const res = await h.app.request("/c/conn_1/SalesOrders?pageSize=1", {
        method: "POST",
        headers: bearer(DRY),
        body: '{"OrderNumber":"SO-1"}',
      });

      expect(res.status).toBe(202);
      const body = await preview(res);
      expect(body.request.path).toBe("/v1/SalesOrders");
      for (const name of ["api-auth-id", "api-auth-signature", "client-type"]) {
        expect(body.request.headerNames).toContain(name);
      }
      expect(h.forwarded).toHaveLength(0);
    });

    it("previews an OAuth2 connection's write without buying a token", async () => {
      const h = harness(
        {},
        {
          ...CONNECTION,
          authScheme: "oauth2_client_credentials",
          schemeConfig: { tokenUrl: "https://auth.vendor.example/oauth/token" },
        },
      );
      const res = await h.app.request("/c/conn_1/orders", {
        method: "POST",
        headers: bearer(DRY),
        body: "{}",
      });

      expect(res.status).toBe(202);
      expect((await preview(res)).request.headerNames).toContain("authorization");
      // Neither the token endpoint nor the vendor saw anything.
      expect(h.forwarded).toHaveLength(0);
    });

    it("returns a body that is not text as base64, and an absent body as empty", async () => {
      const h = harness();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
      const binary = await h.app.request("/c/conn_1/upload", {
        method: "PUT",
        headers: { ...bearer(DRY), "content-type": "application/octet-stream" },
        body: bytes,
      });
      const empty = await h.app.request("/c/conn_1/orders/9", {
        method: "DELETE",
        headers: bearer(DRY),
      });

      expect((await preview(binary)).request).toMatchObject({
        body: Buffer.from(bytes).toString("base64"),
        bodyEncoding: "base64",
        bodyBytes: 6,
      });
      expect((await preview(empty)).request).toMatchObject({
        method: "DELETE",
        body: "",
        bodyEncoding: "utf-8",
        bodyBytes: 0,
        hasQuery: false,
      });
    });

    it("previews the vendor's path, not the mount's, when mounted under a prefix", async () => {
      const h = harness();
      const server = new Hono().route("/api/proxy", h.app);
      const res = await server.request("/api/proxy/c/conn_1/orders", {
        method: "POST",
        headers: bearer(DRY),
        body: "{}",
      });

      expect(res.status).toBe(202);
      expect((await preview(res)).request.path).toBe("/v1/orders");
      expect(h.events[0]?.path).toBe("/orders");
    });
  });

  describe("every existing refusal still fires first", () => {
    const post = (h: ReturnType<typeof harness>, token: string, path = "/c/conn_1/orders") =>
      h.app.request(path, { method: "POST", headers: bearer(token), body: "{}" });

    it("a token that cannot be verified", async () => {
      const h = harness();
      const res = await post(h, "not.a.jwt");

      expect(res.status).toBe(401);
      expect((await body(res)).reason).toBe("token_invalid");
      expect(res.headers.get("x-graft-dry-run")).toBeNull();
      expect(h.forwarded).toHaveLength(0);
    });

    it("a dry-run token minted for another person", async () => {
      const h = harness();
      const res = await post(h, DRY_OTHER_PERSON);

      expect(res.status).toBe(403);
      expect((await body(res)).reason).toBe("person_mismatch");
      expect(res.headers.get("x-graft-dry-run")).toBeNull();
      expect(h.events[0]).toMatchObject({ dryRun: true, dryRunOutcome: null });
    });

    it("a dry-run token whose scope does not name the connection", async () => {
      const h = harness();
      const res = await post(h, DRY_OTHER_AGENT);

      expect(res.status).toBe(403);
      expect((await body(res)).reason).toBe("connection_not_in_token");
      expect(h.forwarded).toHaveLength(0);
    });

    it("a connection nobody has", async () => {
      const h = harness();
      const res = await post(h, DRY, "/c/conn_missing/orders");

      expect(res.status).toBe(404);
      expect((await body(res)).reason).toBe("connection_unknown");
    });

    it("a host outside the set", async () => {
      const h = harness();
      const res = await post(h, DRY, "/c/conn_1/h/evil.example/orders");

      expect(res.status).toBe(403);
      expect((await body(res)).reason).toBe("host_not_in_set");
      expect(h.events[0]).toMatchObject({ dryRun: true, dryRunOutcome: null });
    });

    it("a primary host that is not public", async () => {
      const h = harness({}, { ...CONNECTION, primaryHost: "https://10.0.0.5/api" });
      const res = await post(h, DRY);

      expect(res.status).toBe(403);
      expect((await body(res)).reason).toBe("host_not_public");
      expect(h.events[0]).toMatchObject({ dryRun: true, dryRunOutcome: null });
    });

    it("a connection whose scheme is not yet set", async () => {
      const h = harness({}, { ...CONNECTION, authScheme: null });
      const res = await post(h, DRY);

      expect(res.status).toBe(409);
      expect((await body(res)).reason).toBe("connection_not_ready");
    });

    it("a scheme whose configuration is incomplete, as the live call would after decrypting", async () => {
      const h = harness({}, { ...CONNECTION, schemeConfig: {} });
      const res = await post(h, DRY);

      expect(res.status).toBe(409);
      expect((await body(res)).reason).toBe("credential_incomplete");
      expect(h.events[0]).toMatchObject({ outcome: "credential_incomplete", dryRun: true });
    });

    it("a request body over the cap", async () => {
      const h = harness({ maxBodyBytes: 16 });
      const res = await h.app.request("/c/conn_1/orders", {
        method: "POST",
        headers: bearer(DRY),
        body: "x".repeat(17),
      });

      expect(res.status).toBe(413);
      expect((await body(res)).reason).toBe("request_too_large");
      expect(res.headers.get("x-graft-dry-run")).toBeNull();
    });
  });

  describe("without the claim", () => {
    it("a write is forwarded exactly as before, with no marker on the answer", async () => {
      const h = harness();
      const res = await h.app.request("/c/conn_1/orders", {
        method: "POST",
        headers: bearer(GOOD),
        body: "{}",
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-graft-dry-run")).toBeNull();
      expect(h.forwarded).toHaveLength(1);
      expect(h.events[0]).toMatchObject({
        outcome: "forwarded",
        dryRun: false,
        dryRunOutcome: null,
      });
    });

    it("a read carries no marker either", async () => {
      const h = harness();
      const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

      expect(res.headers.get("x-graft-dry-run")).toBeNull();
      expect(h.events[0]).toMatchObject({ dryRun: false, dryRunOutcome: null });
    });
  });
});

describe("the wide event", () => {
  const EVENT_KEYS = [
    "outcome",
    "status",
    "upstreamStatus",
    "method",
    "path",
    "hasQuery",
    "connectionId",
    "personId",
    "agentId",
    "tool",
    "host",
    "latencyMs",
    "requestBytes",
    "responseBytes",
    "redirectHops",
    "dryRun",
    "dryRunOutcome",
    "oauth",
    "relay",
    "credentialEchoed",
    "failure",
  ].sort();

  it("writes exactly one event per forwarded call, with ids and counts and nothing secret", async () => {
    const h = harness(
      {},
      { ...CONNECTION, authScheme: "api_key_query", schemeConfig: { queryParam: "api_key" } },
    );
    await h.app.request("/c/conn_1/orders?customer=acme", {
      method: "POST",
      headers: { ...bearer(GOOD), "x-request-id": "req_1" },
      body: '{"secret-body":"do-not-log"}',
    });

    expect(h.events).toHaveLength(1);
    const event = h.events[0] as ProxyEvent;
    expect(Object.keys(event).sort()).toEqual(EVENT_KEYS);
    expect(event).toMatchObject({
      outcome: "forwarded",
      status: 200,
      upstreamStatus: 200,
      method: "POST",
      path: "/orders",
      hasQuery: true,
      connectionId: "conn_1",
      personId: PERSON,
      agentId: AGENT,
      tool: "execute",
      host: "api.vendor.example",
      redirectHops: 0,
      dryRun: false,
      dryRunOutcome: null,
      failure: null,
    });
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    const serialised = JSON.stringify(event);
    for (const forbidden of [SECRET, GOOD, "req_1", "customer=acme", "acme", "do-not-log"]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("writes exactly one event per refused call, with what it had learned", async () => {
    const h = harness();
    await h.app.request("/c/conn_1/orders", { headers: bearer(OTHER_AGENT) });

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      outcome: "connection_not_in_token",
      status: 403,
      upstreamStatus: null,
      connectionId: "conn_1",
      personId: PERSON,
      agentId: "agent_2",
      tool: "execute",
      host: null,
      requestBytes: null,
      responseBytes: null,
    });
  });

  it("writes one event even when the proxy itself fails", async () => {
    const h = harness();
    h.deps.connections.get = async () => {
      throw new Error("store exploded");
    };
    const app = createProxyApp(h.deps);
    const res = await app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(500);
    expect((await body(res)).reason).toBe("proxy_error");
    expect(h.events).toHaveLength(1);
    // The store is the host's: its class name reaches the event, its message does not.
    expect(h.events[0]).toMatchObject({
      outcome: "proxy_error",
      failure: "HostDependencyError: connections.get threw Error",
    });
  });
});

describe("/.well-known/jwks.json", () => {
  it("publishes the verification keys", async () => {
    const h = harness();
    const res = await h.app.request("/.well-known/jwks.json");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [{ kty: "OKP", crv: "Ed25519", x: "x" }] });
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  it("answers 503 when the deployment has no key pair", async () => {
    const h = harness();
    h.unconfigure();
    const res = await h.app.request("/.well-known/jwks.json");

    expect(res.status).toBe(503);
  });

  it("needs no token — the key is public", async () => {
    const h = harness();
    expect((await h.app.request("/.well-known/jwks.json")).status).toBe(200);
    expect(h.events).toHaveLength(0);
  });
});

/**
 * The one way the proxy's own work could put a credential in front of agent code: a vendor that
 * reflects what it received. A returned redirect loses the query parameter the scheme injected,
 * and a header value that carries a credential verbatim comes back redacted. Bodies are the
 * vendor's and pass through — a vendor that echoes a key in a body is the vendor's doing, not the
 * proxy's.
 */
describe("a vendor that reflects the credential", () => {
  it("scrubs the injected query parameter from a returned redirect's Location", async () => {
    const h = harness(
      {},
      { ...CONNECTION, authScheme: "api_key_query", schemeConfig: { queryParam: "api_key" } },
    );
    h.respond(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: `/v1/orders/?api_key=${SECRET}&page=2` },
        }),
    );
    const res = await h.app.request("/c/conn_1/orders?page=2", { headers: bearer(GOOD) });

    expect(res.status).toBe(301);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain(SECRET);
    expect(new URL(location).searchParams.get("page")).toBe("2");
    expect(new URL(location).searchParams.has("api_key")).toBe(false);
  });

  it("leaves a redirect Location alone when there is nothing of ours in it", async () => {
    const h = harness();
    h.respond(() => new Response(null, { status: 302, headers: { location: "/v1/orders-v2" } }));
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.headers.get("location")).toBe("/v1/orders-v2");
  });

  it("redacts a credential value a vendor echoes back in a header", async () => {
    const h = harness();
    h.respond(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "x-echo-key": SECRET, "x-echo-auth": `Token ${SECRET}`, "x-other": "keep" },
        }),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.headers.get("x-echo-key")).toBe(CREDENTIAL_REDACTED);
    expect(res.headers.get("x-echo-auth")).toBe(`Token ${CREDENTIAL_REDACTED}`);
    expect(res.headers.get("x-other")).toBe("keep");
    expect(res.headers.get(REDACTED_HEADER)).toBe("credential");
    expect(await res.text()).toBe("ok");
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", credentialEchoed: true });
  });

  /**
   * The body too (GRA-29; ADR 0010, amended): the proxy is the only component holding the plaintext,
   * so a vendor's 401 that quotes the key it refused is redacted here by value, before it reaches
   * the sandbox and `acquire`'s trace. Text-like bodies only; a binary body is never rewritten.
   */
  it("redacts a credential value a vendor echoes in a 401 JSON body, marks the response, and says so on the event", async () => {
    const h = harness();
    h.respond(() =>
      jsonResponse(
        { error: "unauthorized", message: `Invalid API key provided: ${SECRET}`, apiKey: SECRET },
        { status: 401 },
      ),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({
      error: "unauthorized",
      message: `Invalid API key provided: ${CREDENTIAL_REDACTED}`,
      apiKey: CREDENTIAL_REDACTED,
    });
    expect(res.headers.get(REDACTED_HEADER)).toBe("credential");
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      upstreamStatus: 401,
      credentialEchoed: true,
      responseBytes: Buffer.byteLength(text),
    });
  });

  it("redacts an echo in a 200 text body and in a body with no declared type, and leaves a clean body unmarked", async () => {
    const h = harness();
    h.respond(
      () =>
        new Response(`echo: ${SECRET} and again ${SECRET}`, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const echoed = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(await echoed.text()).toBe(
      `echo: ${CREDENTIAL_REDACTED} and again ${CREDENTIAL_REDACTED}`,
    );
    expect(echoed.headers.get(REDACTED_HEADER)).toBe("credential");

    h.respond(() => new Response(`untyped ${SECRET}`, { status: 200 }));
    const untyped = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(await untyped.text()).toBe(`untyped ${CREDENTIAL_REDACTED}`);

    h.respond(() => jsonResponse({ ok: true }));
    const clean = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(await clean.json()).toEqual({ ok: true });
    expect(clean.headers.has(REDACTED_HEADER)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ credentialEchoed: false });
  });

  it("redacts the base64 pair a vendor echoes from a Basic Authorization header", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "basic", schemeConfig: {} });
    h.credentials.set("cipher:conn_1", { username: "ops@example.com", password: "p4ssw0rd-long" });
    const pair = Buffer.from("ops@example.com:p4ssw0rd-long", "utf8").toString("base64");
    h.respond(() =>
      jsonResponse({ saw: `Basic ${pair}`, password: "p4ssw0rd-long" }, { status: 401 }),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    const text = await res.text();
    expect(text).not.toContain(pair);
    expect(text).not.toContain("p4ssw0rd-long");
    expect(JSON.parse(text)).toEqual({
      saw: `Basic ${CREDENTIAL_REDACTED}`,
      password: CREDENTIAL_REDACTED,
    });
  });

  it("passes a binary body through untouched even when its bytes spell the key", async () => {
    const h = harness();
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(SECRET)]);
    h.respond(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const res = await h.app.request("/c/conn_1/orders", { headers: bearer(GOOD) });
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(res.headers.has(REDACTED_HEADER)).toBe(false);
    expect(h.events[0]).toMatchObject({ credentialEchoed: false, responseBytes: bytes.byteLength });
  });
});

/**
 * The derived-credential path, end to end. A token is bought before the vendor is called, held
 * across calls, and bought again exactly once when the vendor says 401.
 */
describe("oauth2_client_credentials through the proxy", () => {
  const TOKEN_URL = "https://auth.vendor.example/oauth/token";
  const OAUTH: ProxyConnection = {
    ...CONNECTION,
    id: "conn_o",
    authScheme: "oauth2_client_credentials",
    schemeConfig: { tokenUrl: TOKEN_URL, scopes: "orders.read" },
    credentialCiphertext: cipherFor("conn_o"),
  };
  const CLIENT = { clientId: "client-id-value", clientSecret: "client-secret-value" };

  const isTokenRequest = (request: UpstreamRequest) => request.url === TOKEN_URL;

  function oauthHarness(
    vendor: (request: UpstreamRequest, token: string | null) => UpstreamResponse,
    options: { connection?: ProxyConnection; now?: () => number; tokenStatus?: number } = {},
  ) {
    const h = harness({}, options.connection ?? OAUTH, options.now ? { now: options.now } : {});
    h.credentials.set(`cipher:${(options.connection ?? OAUTH).id}`, CLIENT);
    let issued = 0;
    h.respond((request) => {
      if (isTokenRequest(request)) {
        issued += 1;
        return new Response(
          JSON.stringify({
            access_token: `token-${issued}-value`,
            token_type: "Bearer",
            expires_in: 120,
          }),
          { status: options.tokenStatus ?? 200, headers: { "content-type": "application/json" } },
        );
      }
      const authorization = request.headers.get("authorization");
      return vendor(request, authorization ? authorization.replace(/^Bearer /, "") : null);
    });
    return { ...h, tokenRequests: () => h.forwarded.filter(isTokenRequest) };
  }

  it("buys a token once and sends it as Bearer on every call inside its lifetime", async () => {
    const h = oauthHarness(() => jsonResponse({ ok: true }));

    const first = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });
    const second = await h.app.request("/c/conn_o/orders/2", { headers: bearer(GOOD) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.tokenRequests()).toHaveLength(1);
    const exchange = h.tokenRequests()[0];
    expect(exchange?.method).toBe("POST");
    expect(decode(exchange?.body ?? null)).toBe("grant_type=client_credentials&scope=orders.read");
    expect(exchange?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString("base64")}`,
    );
    const vendorCalls = h.forwarded.filter((r) => !isTokenRequest(r));
    expect(vendorCalls.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer token-1-value",
      "Bearer token-1-value",
    ]);
    expect(h.events.map((e) => e.outcome)).toEqual(["forwarded", "forwarded"]);
  });

  it("puts the client in the body when clientAuth is body", async () => {
    const h = oauthHarness(() => jsonResponse({ ok: true }), {
      connection: { ...OAUTH, schemeConfig: { tokenUrl: TOKEN_URL, clientAuth: "body" } },
    });

    await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    const exchange = h.tokenRequests()[0];
    expect(exchange?.headers.get("authorization")).toBeNull();
    expect(new URLSearchParams(decode(exchange?.body ?? null) ?? "").get("client_secret")).toBe(
      CLIENT.clientSecret,
    );
  });

  it("on a vendor 401 buys a fresh token and retries the same call once", async () => {
    const h = oauthHarness((request, token) =>
      token === "token-1-value"
        ? new Response('{"error":"expired"}', { status: 401 })
        : jsonResponse({ ok: true, echo: request.method }),
    );

    const res = await h.app.request("/c/conn_o/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: '{"lines":2}',
    });

    expect(res.status).toBe(200);
    expect(
      h.forwarded.map((r) =>
        isTokenRequest(r) ? "token" : `vendor:${r.headers.get("authorization")}`,
      ),
    ).toEqual(["token", "vendor:Bearer token-1-value", "token", "vendor:Bearer token-2-value"]);
    // The retried hop carries the same body the first one did.
    expect(decode(h.forwarded[3]?.body ?? null)).toBe('{"lines":2}');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", status: 200, redirectHops: 0 });
  });

  it("passes a second 401 through as the vendor's answer, with exactly two exchanges", async () => {
    const h = oauthHarness(() => new Response('{"error":"nope"}', { status: 401 }));

    const res = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"nope"}');
    expect(h.tokenRequests()).toHaveLength(2);
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", status: 401, upstreamStatus: 401 });
  });

  it("buys again once expires_in less the skew has passed", async () => {
    let clock = 5_000_000;
    const h = oauthHarness(() => jsonResponse({ ok: true }), { now: () => clock });

    await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });
    clock += 59_000;
    await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });
    expect(h.tokenRequests()).toHaveLength(1);

    clock += 1_000;
    await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });
    expect(h.tokenRequests()).toHaveLength(2);
  });

  it("answers 502 when the token endpoint rejects the client, and neither the body nor the event carries the client id", async () => {
    const h = oauthHarness(() => jsonResponse({ ok: true }), { tokenStatus: 401 });

    const res = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    const refusal = await body(res);
    expect(refusal.reason).toBe("token_exchange_failed");
    expect(JSON.stringify(refusal)).not.toContain(CLIENT.clientId);
    expect(h.events[0]).toMatchObject({ outcome: "token_exchange_failed", upstreamStatus: 401 });
    expect(JSON.stringify(h.events)).not.toContain(CLIENT.clientId);
    expect(JSON.stringify(h.events)).not.toContain(CLIENT.clientSecret);
    expect(h.forwarded.filter((r) => !isTokenRequest(r))).toHaveLength(0);
  });

  it("refuses a token endpoint on a private host before calling it", async () => {
    const h = oauthHarness(() => jsonResponse({ ok: true }), {
      connection: { ...OAUTH, schemeConfig: { tokenUrl: "https://10.0.0.7/oauth/token" } },
    });

    const res = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(403);
    expect((await body(res)).reason).toBe("host_not_public");
    expect(h.forwarded).toHaveLength(0);
  });

  it("answers 409 for a clientAuth the scheme does not know", async () => {
    const h = oauthHarness(() => jsonResponse({ ok: true }), {
      connection: { ...OAUTH, schemeConfig: { tokenUrl: TOKEN_URL, clientAuth: "header" } },
    });

    const res = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect((await body(res)).reason).toBe("credential_incomplete");
    expect(h.forwarded).toHaveLength(0);
  });

  it("redacts the derived token when the vendor echoes it in a header", async () => {
    const h = oauthHarness(
      (_request, token) =>
        new Response("ok", { status: 200, headers: { "x-echo": `got ${token}` } }),
    );

    const res = await h.app.request("/c/conn_o/orders", { headers: bearer(GOOD) });

    expect(res.headers.get("x-echo")).toBe(`got ${CREDENTIAL_REDACTED}`);
  });
});

/**
 * The other derived-credential scheme, end to end: the JWT is signed once with the connection's
 * private key, held across calls, and signed again exactly once when the vendor says 401. The
 * recipe itself is pinned in `snowflake-jwt.test.ts`; this is the plugin through the ladder.
 */
describe("snowflake_keypair_jwt through the proxy", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const SNOWFLAKE: ProxyConnection = {
    ...CONNECTION,
    id: "conn_s",
    authScheme: "snowflake_keypair_jwt",
    primaryHost: "https://myorg-myaccount.snowflakecomputing.com",
    hosts: ["myorg-myaccount.snowflakecomputing.com"],
    schemeConfig: { account: "myorg-myaccount", user: "svc_user" },
    credentialCiphertext: cipherFor("conn_s"),
  };

  function verifies(bearerValue: string | null): boolean {
    const token = bearerValue?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = token.split(".");
    return createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
  }

  function snowflakeHarness(overrides: Partial<ProxyDeps> = {}) {
    const h = harness({}, SNOWFLAKE, overrides);
    h.credentials.set("cipher:conn_s", { privateKey });
    return h;
  }

  it("signs a JWT once, sends it as a bearer with the token-type header, and reuses it", async () => {
    const h = snowflakeHarness();
    const first = await h.app.request("/c/conn_s/api/v2/statements", {
      method: "POST",
      headers: bearer(GOOD),
      body: '{"statement":"select 1"}',
    });
    const second = await h.app.request("/c/conn_s/api/v2/statements/abc", {
      headers: bearer(GOOD),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [a, b] = h.forwarded;
    expect(a?.headers.get("authorization")).toMatch(/^Bearer /);
    expect(a?.headers.get("authorization")).toBe(b?.headers.get("authorization"));
    expect(a?.headers.get(SNOWFLAKE_TOKEN_TYPE_HEADER)).toBe("KEYPAIR_JWT");
    expect(verifies(a?.headers.get("authorization") ?? null)).toBe(true);
    const payload = JSON.parse(
      Buffer.from(
        (a?.headers.get("authorization") ?? "").split(".")[1] ?? "",
        "base64url",
      ).toString(),
    ) as { sub: string; iss: string };
    expect(payload.sub).toBe("MYORG-MYACCOUNT.SVC_USER");
    expect(payload.iss.startsWith("MYORG-MYACCOUNT.SVC_USER.SHA256:")).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE KEY");
  });

  it("on a vendor 401 signs a fresh token and retries once; a second 401 passes through", async () => {
    let clock = 1_700_000_000_000;
    const h = snowflakeHarness({ now: () => (clock += 1000) });
    let calls = 0;
    h.respond(() => {
      calls += 1;
      return calls === 1
        ? new Response('{"code":"390144"}', { status: 401 })
        : jsonResponse({ ok: true });
    });

    const res = await h.app.request("/c/conn_s/api/v2/statements", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(h.forwarded).toHaveLength(2);
    expect(h.forwarded[0]?.headers.get("authorization")).not.toBe(
      h.forwarded[1]?.headers.get("authorization"),
    );
    expect(verifies(h.forwarded[1]?.headers.get("authorization") ?? null)).toBe(true);

    h.respond(() => new Response('{"code":"390144"}', { status: 401 }));
    const again = await h.app.request("/c/conn_s/api/v2/statements", { headers: bearer(GOOD) });
    expect(again.status).toBe(401);
    expect(await again.text()).toBe('{"code":"390144"}');
  });

  it("answers 409 credential_incomplete for a key that is not a key, without calling the vendor", async () => {
    const h = snowflakeHarness();
    h.credentials.set("cipher:conn_s", { privateKey: "not-a-pem" });
    const res = await h.app.request("/c/conn_s/api/v2/statements", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    const refusal = await body(res);
    expect(refusal.reason).toBe("credential_incomplete");
    expect(refusal.message).toContain("privateKey");
    expect(h.forwarded).toHaveLength(0);
  });

  it("previews a dry-run write naming both headers, without decrypting or signing", async () => {
    let decrypts = 0;
    const h = snowflakeHarness({
      decryptCredential: async () => {
        decrypts += 1;
        throw new Error("must not decrypt");
      },
    });
    const res = await h.app.request("/c/conn_s/api/v2/statements", {
      method: "POST",
      headers: bearer(DRY),
      body: '{"statement":"insert"}',
    });

    expect(res.status).toBe(202);
    const preview = (await res.json()) as { request: { headerNames: string[] } };
    expect(preview.request.headerNames).toContain("authorization");
    expect(preview.request.headerNames).toContain(SNOWFLAKE_TOKEN_TYPE_HEADER);
    expect(decrypts).toBe(0);
    expect(h.forwarded).toHaveLength(0);
  });

  it("still signs the query for the Unleashed recipe beside it — the two signing schemes coexist", async () => {
    const h = harness({}, { ...CONNECTION, authScheme: "unleashed_hmac", schemeConfig: null });
    h.credentials.set("cipher:conn_1", { apiId: "api-id-1", apiKey: "unleashed-example-api-key" });
    await h.app.request("/c/conn_1/Customers?pageSize=1", { headers: bearer(GOOD) });

    expect(h.forwarded[0]?.headers.get("api-auth-signature")).toBe(
      createHmac("sha256", "unleashed-example-api-key").update("pageSize=1").digest("base64"),
    );
  });
});

/**
 * The authorization-code scheme through the ladder (ADR 0005): the stored token injected and the
 * capability token stripped; an expired token refreshed once under two concurrent calls, the
 * rotated record handed to the host's `storeCredential` once, and the refresh recorded on the one
 * event that made it; a vendor 401 refreshed and retried once; a refresh the endpoint refuses
 * letting the vendor's own 401 through untouched while `credentialRefreshFailed` marks the
 * connection for re-consent; a connection awaiting consent refused before the vendor is asked.
 */
describe("oauth_authorization_code through the proxy", () => {
  const TOKEN_URL = "https://oauth2.vendor.example/token";
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const EXPIRES_AT = new Date(T0 + 3600_000).toISOString();
  const STORED = {
    clientSecret: "client-secret-value",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: EXPIRES_AT,
  };
  const AUTH_CODE: ProxyConnection = {
    ...CONNECTION,
    id: "conn_a",
    authScheme: "oauth_authorization_code",
    primaryHost: "https://gmail.googleapis.com",
    hosts: ["gmail.googleapis.com"],
    schemeConfig: {
      clientId: "client-id-value",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: TOKEN_URL,
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    },
    credentialCiphertext: cipherFor("conn_a"),
  };

  const isTokenRequest = (request: UpstreamRequest) => request.url === TOKEN_URL;

  function authCodeHarness(
    vendor: (request: UpstreamRequest, token: string | null) => UpstreamResponse,
    options: {
      credential?: Record<string, string>;
      now?: () => number;
      token?: (issued: number) => UpstreamResponse | Promise<UpstreamResponse>;
      storeCredential?: ProxyDeps["storeCredential"];
    } = {},
  ) {
    const stored: {
      scope: { personId: string; connectionId: string };
      fields: Record<string, string>;
    }[] = [];
    const failed: { scope: { personId: string; connectionId: string }; detail: unknown }[] = [];
    const h = harness({}, AUTH_CODE, {
      now: options.now ?? (() => T0),
      storeCredential:
        options.storeCredential ??
        (async (scope, fields) => {
          stored.push({ scope, fields: { ...fields } });
        }),
      credentialRefreshFailed: async (scope, detail) => {
        failed.push({ scope, detail });
      },
    });
    h.credentials.set("cipher:conn_a", options.credential ?? STORED);
    let issued = 0;
    h.respond((request) => {
      if (isTokenRequest(request)) {
        issued += 1;
        return options.token
          ? options.token(issued)
          : new Response(
              JSON.stringify({
                access_token: `access-${issued + 1}`,
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: `refresh-${issued + 1}`,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      }
      const authorization = request.headers.get("authorization");
      return vendor(request, authorization ? authorization.replace(/^Bearer /, "") : null);
    });
    return {
      ...h,
      stored,
      failed,
      tokenRequests: () => h.forwarded.filter(isTokenRequest),
      vendorCalls: () => h.forwarded.filter((r) => !isTokenRequest(r)),
    };
  }

  const messages = { messages: [{ id: "m1", threadId: "t1" }] };

  it("sends the stored access token as Bearer and nothing else, and asks the token endpoint for nothing while it is good", async () => {
    const h = authCodeHarness(() => jsonResponse(messages));

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages", {
      headers: { ...bearer(GOOD), "x-api-key": GOOD },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(messages);
    expect(h.tokenRequests()).toHaveLength(0);
    const call = h.vendorCalls()[0];
    expect(call?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(call?.headers.get("authorization")).toBe("Bearer access-1");
    expect(wire(call)).not.toContain(GOOD);
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", oauth: null });
    expect(h.stored).toHaveLength(0);
  });

  it("an expired token is refreshed once under two concurrent calls, stored once under the connection's scope, and recorded on the call that made it", async () => {
    const h = authCodeHarness(() => jsonResponse(messages), {
      now: () => T0 + 7200_000,
      token: async (issued) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response(
          JSON.stringify({ access_token: `access-${issued + 1}`, expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const [first, second] = await Promise.all([
      h.app.request("/c/conn_a/gmail/v1/users/me/messages", { headers: bearer(GOOD) }),
      h.app.request("/c/conn_a/gmail/v1/users/me/messages/m1", { headers: bearer(GOOD) }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.vendorCalls().map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer access-2",
      "Bearer access-2",
    ]);
    expect(h.stored).toEqual([
      {
        scope: { personId: PERSON, connectionId: "conn_a" },
        fields: {
          clientSecret: "client-secret-value",
          accessToken: "access-2",
          refreshToken: "refresh-1",
          expiresAt: new Date(T0 + 7200_000 + 3600_000).toISOString(),
        },
      },
    ]);
    expect(h.events.map((e) => e.oauth).sort()).toEqual([null, "refreshed"]);
    expect(h.failed).toHaveLength(0);
  });

  it("a vendor 401 buys a fresh token and retries the same call once; a second 401 is the vendor's answer", async () => {
    const h = authCodeHarness((request, token) =>
      token === "access-1"
        ? new Response('{"error":"expired"}', { status: 401 })
        : jsonResponse({ ok: true, path: new URL(request.url).pathname }),
    );

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/profile", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "/gmail/v1/users/me/profile" });
    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.vendorCalls().map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
    expect(h.stored.map((s) => s.fields.accessToken)).toEqual(["access-2"]);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      upstreamStatus: 200,
      oauth: "refreshed",
    });

    const again = await h.app.request("/c/conn_a/gmail/v1/users/me/profile", {
      headers: bearer(GOOD),
    });
    expect(again.status).toBe(200);
    expect(h.tokenRequests()).toHaveLength(1);
  });

  it("a refresh the endpoint refuses lets the vendor's 401 through untouched, marks the connection for re-consent, and says refresh_failed", async () => {
    const vendorBody = {
      error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" },
    };
    const h = authCodeHarness(
      () =>
        new Response(JSON.stringify(vendorBody), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer realm="vendor"',
          },
        }),
      {
        token: () =>
          new Response(JSON.stringify({ error: "invalid_grant", client_id: "client-id-value" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      },
    );

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(vendorBody);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="vendor"');
    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.vendorCalls()).toHaveLength(1);
    expect(h.failed).toEqual([
      {
        scope: { personId: PERSON, connectionId: "conn_a" },
        detail: { reason: expect.stringContaining("could not be refreshed"), upstreamStatus: 400 },
      },
    ]);
    expect(String(h.failed[0]?.detail)).not.toContain("invalid_grant");
    expect(h.stored).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      status: 401,
      upstreamStatus: 401,
      oauth: "refresh_failed",
    });
  });

  it("a token past its expiry whose refresh fails is still sent once, so the vendor's answer is the caller's", async () => {
    const h = authCodeHarness(
      (_request, token) =>
        token === "access-1"
          ? new Response('{"error":"expired"}', { status: 401 })
          : jsonResponse({ ok: true }),
      {
        now: () => T0 + 7200_000,
        token: () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      },
    );

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(401);
    expect(h.tokenRequests()).toHaveLength(1);
    expect(h.vendorCalls().map((r) => r.headers.get("authorization"))).toEqual(["Bearer access-1"]);
    expect(h.failed).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ oauth: "refresh_failed", upstreamStatus: 401 });
  });

  it("a connection awaiting the person's consent is refused consent_required before the vendor is asked", async () => {
    const h = authCodeHarness(() => jsonResponse(messages), {
      credential: { clientSecret: "client-secret-value" },
    });

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ error: "conflict", reason: "consent_required" });
    expect(h.forwarded).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ outcome: "consent_required", status: 409, oauth: null });
  });

  it("a dry-run write previews the Authorization header without a decrypt, a token request or a refresh", async () => {
    const h = authCodeHarness(() => jsonResponse(messages), { now: () => T0 + 7200_000 });

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: bearer(DRY),
      body: '{"raw":"..."}',
    });

    expect(res.status).toBe(202);
    const preview = (await res.json()) as { request: { headerNames: string[] } };
    expect(preview.request.headerNames).toContain("authorization");
    expect(h.forwarded).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it("a store seam that throws is the proxy's error, on the event by class name and never by message", async () => {
    const h = authCodeHarness(() => jsonResponse(messages), {
      now: () => T0 + 7200_000,
      storeCredential: async () => {
        throw new Error("disk full while writing client-secret-value");
      },
    });

    const res = await h.app.request("/c/conn_a/gmail/v1/users/me/messages", {
      headers: bearer(GOOD),
    });

    expect(res.status).toBe(500);
    expect(await body(res)).toMatchObject({ reason: "proxy_error" });
    expect(h.events[0]?.failure).toContain("HostDependencyError");
    expect(h.events[0]?.failure).toContain("storeCredential");
    expect(h.events[0]?.failure).not.toContain("disk full");
    expect(h.events[0]?.failure).not.toContain("client-secret-value");
  });
});
