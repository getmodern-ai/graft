import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createProxyApp } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import { CREDENTIAL_REDACTED, REDACTED_HEADER } from "./echo";
import { gatewayRelay } from "./gateway-relay";
import {
  PASSTHROUGH_RELAY_RULES,
  relayHeaders,
  relayPassesThrough,
  relayRefuses,
  relayRulesOf,
} from "./relay";
import { MissingCredentialFieldError } from "./scheme-errors";
import type {
  CapabilityClaims,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  RelayHeaderRules,
  RelayPlugin,
  TokenVerdict,
  UpstreamRequest,
} from "./types";
import { RELAY_SCHEME, RELAY_SCHEMES } from "./types";

/**
 * The relay engine (ADR 0019): the header rules as a pure function, and the ladder relaying through
 * a **fake upstream proxy** — a real HTTP server on a loopback port that decodes the vendor URL out
 * of the path it was sent and reports what it saw. The plugin here is the test's own, shaped like
 * the gateway's and a hosted provider's: it carries the vendor URL base64url in the path, the
 * account id in the query, and authenticates to the upstream with a bearer token from its fields.
 * What these pin is that everything *around* the relay is unchanged — the token admits the call,
 * the vendor host is what the ladder judges, a dry run stops a write before the relay's fields are
 * assembled, a redirect is judged against the vendor's host set — and that the relay itself puts
 * the vendor request where the upstream wants it, under its header rules, with the capability
 * token nowhere on the wire.
 *
 * The upstream is reached through an injected fetch rather than the default one: the default pins
 * DNS to public addresses (`upstream.ts`) and would refuse the loopback this server listens on,
 * which is the rule under test elsewhere and not here.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const GOOD = "good-token";
const DRY = "dry-run-token";
const OTHER_PERSON = "other-person-token";
const UPSTREAM_TOKEN = "upstream-bearer-token-value";

const RULES: RelayHeaderRules = {
  prefix: "x-up-",
  passThrough: ["content-type", "accept"],
  refuse: ["user-agent", "cookie", "host"],
  refusePrefixes: ["sec-"],
};

/** The test's relay plugin: what a provider's plugin looks like from the engine's side. */
const testRelay: RelayPlugin = {
  kind: "relay",
  scheme: "test_relay",
  rules: RULES,
  relay(target, fields, _rules) {
    const upstreamUrl = fields.upstreamUrl;
    const token = fields.token;
    const accountId = fields.accountId;
    if (!upstreamUrl) throw new MissingCredentialFieldError("upstreamUrl");
    if (!token) throw new MissingCredentialFieldError("token");
    if (!accountId) throw new MissingCredentialFieldError("accountId");
    const relay = new URL(
      `${upstreamUrl}/relay/${Buffer.from(target.url.href, "utf8").toString("base64url")}`,
    );
    relay.searchParams.set("account", accountId);
    target.headers.set("authorization", `Bearer ${token}`);
    target.headers.set("x-up-env", "test");
    target.url.href = relay.href;
  },
  headerNames: () => ["authorization", "x-up-env"],
};

describe("the relay's header rules", () => {
  it("prefixes every caller header, passes the framing pair through, drops what the upstream refuses", () => {
    const headers = new Headers({
      "x-custom": "1",
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "node",
      cookie: "a=b",
      "sec-fetch-mode": "cors",
      "x-request-id": "req_1",
    });
    relayHeaders(headers, RULES);
    expect([...headers.entries()].sort()).toEqual([
      ["accept", "application/json"],
      ["content-type", "application/json"],
      ["x-up-x-custom", "1"],
      ["x-up-x-request-id", "req_1"],
    ]);
  });

  /**
   * The upstream strips exactly one prefix on the way to the vendor, so a caller header that already
   * carries it is prefixed again rather than let through as itself — otherwise `x-up-authorization`
   * would arrive at the vendor as the very `authorization` the outgoing policy stripped.
   */
  it("prefixes a header that already carries the prefix, so nothing stripped can be smuggled back", () => {
    const headers = new Headers({ "x-up-authorization": "Bearer smuggled" });
    relayHeaders(headers, RULES);
    expect(headers.get("x-up-authorization")).toBeNull();
    expect(headers.get("x-up-x-up-authorization")).toBe("Bearer smuggled");
  });

  it("forwards everything under its own name with a null prefix, still dropping the refused", () => {
    const headers = new Headers({ "x-custom": "1", "user-agent": "node", accept: "text/plain" });
    relayHeaders(headers, { ...RULES, prefix: null });
    expect([...headers.entries()].sort()).toEqual([
      ["accept", "text/plain"],
      ["x-custom", "1"],
    ]);
  });

  it("the pass-through rules touch nothing", () => {
    const headers = new Headers({ "x-custom": "1", "user-agent": "node", "sec-fetch-mode": "x" });
    relayHeaders(headers, PASSTHROUGH_RELAY_RULES);
    expect([...headers.entries()].sort()).toEqual([
      ["sec-fetch-mode", "x"],
      ["user-agent", "node"],
      ["x-custom", "1"],
    ]);
  });

  it("compares names case-insensitively, as Headers reports them", () => {
    expect(relayPassesThrough("Content-Type", RULES)).toBe(true);
    expect(relayRefuses("User-Agent", RULES)).toBe(true);
    expect(relayRefuses("Sec-Fetch-Dest", RULES)).toBe(true);
    expect(relayRefuses("x-custom", RULES)).toBe(false);
    expect(relayPassesThrough("x-custom", RULES)).toBe(false);
  });

  it("a connection's overrides sit on top of the plugin's rules", () => {
    expect(relayRulesOf(testRelay, undefined)).toEqual(RULES);
    expect(relayRulesOf(testRelay, { prefix: null })).toEqual({ ...RULES, prefix: null });
    expect(relayRulesOf(testRelay, { refuse: [] }).passThrough).toEqual(RULES.passThrough);
  });

  /**
   * The two relay schemes a row may carry (GRA-103): the gateway's, which is its plugin's name too,
   * and the generic one every other relay provider's rows record — no catalogue maps it to a
   * plugin, since the provider hands the proxy the plugin on the resolution.
   */
  it("names the gateway's relay and the generic one, and no vendor's", () => {
    expect([...RELAY_SCHEMES]).toEqual(["gateway", RELAY_SCHEME]);
    expect(gatewayRelay.scheme).toBe("gateway");
    expect(gatewayRelay.kind).toBe("relay");
    expect(RELAY_SCHEME).toBe("relay");
  });
});

/** What the fake upstream saw of one relayed request, as it reports it back in its JSON answer. */
type Seen = {
  method: string;
  path: string;
  query: Record<string, string>;
  vendorUrl: string | null;
  headers: Record<string, string>;
  body: string;
};

/**
 * The fake upstream proxy: `/relay/<base64url vendor URL>?account=…`. It answers with what it saw,
 * so a test asserts the vendor URL it decoded and the headers it received off the response body.
 * Two vendor paths make it misbehave on purpose: `/moved-inside` and `/moved-outside` answer a 302
 * whose `Location` is inside and outside the connection's host set, and `/echo` quotes the bearer
 * it was sent, as a vendor quoting a refused key would.
 */
function startUpstream(): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://upstream.test");
      const segment = url.pathname.startsWith("/relay/")
        ? url.pathname.slice("/relay/".length)
        : "";
      const vendorUrl = segment ? Buffer.from(segment, "base64url").toString("utf8") : null;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      const record: Seen = {
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        vendorUrl,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(record);
      const vendorPath = vendorUrl ? new URL(vendorUrl).pathname : "";
      if (vendorPath.endsWith("/moved-inside")) {
        res.writeHead(302, { location: "https://files.vendor.example/v1/new-place" });
        return res.end();
      }
      if (vendorPath.endsWith("/moved-outside")) {
        res.writeHead(302, { location: "https://evil.example/collect" });
        return res.end();
      }
      if (vendorPath.endsWith("/echo")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `bad token ${headers.authorization}` }));
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream-request-id": "up_1" });
      res.end(JSON.stringify({ relayed: true, saw: record }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, seen });
    });
  });
}

let upstream: Awaited<ReturnType<typeof startUpstream>>;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
});

beforeEach(() => {
  upstream.seen.length = 0;
});

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_r"],
    tool: "execute",
    jti: "jti_1",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    ...overrides,
  };
}

function relayConnection(
  overrides: Partial<ProxyConnection> = {},
  obtain?: () => Promise<Record<string, string>>,
): ProxyConnection {
  return {
    id: "conn_r",
    personId: PERSON,
    authScheme: null,
    primaryHost: "https://api.vendor.example/v1",
    hosts: ["api.vendor.example", "files.vendor.example"],
    schemeConfig: null,
    credentialCiphertext: null,
    relay: {
      plugin: testRelay,
      obtain:
        obtain ??
        (async () => ({ upstreamUrl: upstream.url, token: UPSTREAM_TOKEN, accountId: "acct_1" })),
    },
    ...overrides,
  };
}

/** The proxy over the fake upstream, reached with a plain fetch that follows nothing. */
function harness(connection: ProxyConnection, options: Partial<ProxyOptions> = {}) {
  const events: ProxyEvent[] = [];
  const sent: UpstreamRequest[] = [];
  let obtained = 0;
  const wrapped: ProxyConnection = connection.relay
    ? {
        ...connection,
        relay: {
          ...connection.relay,
          obtain: () => {
            obtained += 1;
            return connection.relay?.obtain() ?? Promise.reject(new Error("no relay"));
          },
        },
      }
    : connection;
  const ok = (c: CapabilityClaims): TokenVerdict => ({ ok: true, claims: c });
  const tokens = new Map<string, TokenVerdict>([
    [GOOD, ok(claims())],
    [DRY, ok(claims({ dryRun: true }))],
    [OTHER_PERSON, ok(claims({ person: "person_2" }))],
  ]);
  const deps: ProxyDeps = {
    verifyToken: async (token) => tokens.get(token) ?? { ok: false, reason: "invalid" },
    jwks: async () => ({ keys: [] }),
    connections: { get: async (id) => (id === wrapped.id ? wrapped : null) },
    decryptCredential: async () => {
      throw new Error("a relayed connection decrypts nothing");
    },
    upstreamFetch: async (request, { signal }) => {
      sent.push(request);
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
        redirect: "manual",
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
      };
    },
    log: (event) => events.push(event),
    options,
  };
  return { app: createProxyApp(deps), events, sent, obtained: () => obtained };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function relayed(response: Response): Promise<{ relayed: boolean; saw: Seen }> {
  return response.json() as Promise<{ relayed: boolean; saw: Seen }>;
}

/** A refusal's `reason` word (`failure.ts`). */
async function reason(response: Response): Promise<string> {
  return ((await response.json()) as { reason: string }).reason;
}

describe("the ladder relays a connection whose provider holds the credential elsewhere", () => {
  it("rewrites the resolved vendor request into the upstream's URL, authenticated to the upstream, and answers the upstream's response verbatim", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/orders?limit=5", {
      headers: { ...bearer(GOOD), "x-request-id": "req_1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream-request-id")).toBe("up_1");
    const { saw } = await relayed(res);
    expect(saw.vendorUrl).toBe("https://api.vendor.example/v1/orders?limit=5");
    expect(saw.query).toEqual({ account: "acct_1" });
    expect(saw.headers["x-up-env"]).toBe("test");
    expect(saw.headers["x-up-x-request-id"]).toBe("req_1");
    // What the upstream received, read server-side: its own bearer. The copy in the body the
    // upstream answered with comes back redacted, as an echoed credential does (the last test).
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(saw.headers.authorization).toBe(`Bearer ${CREDENTIAL_REDACTED}`);
    // The request that left went to the upstream, not the vendor.
    expect(h.sent.map((r) => new URL(r.url).host)).toEqual([new URL(upstream.url).host]);
    expect(h.obtained()).toBe(1);
  });

  it("the event names the vendor host and path, and the relay that carried the call", async () => {
    const h = harness(relayConnection());
    await h.app.request("/c/conn_r/orders?limit=5", { headers: bearer(GOOD) });

    expect(h.events).toEqual([
      expect.objectContaining({
        outcome: "forwarded",
        status: 200,
        upstreamStatus: 200,
        method: "GET",
        host: "api.vendor.example",
        path: "/orders",
        hasQuery: true,
        connectionId: "conn_r",
        personId: PERSON,
        agentId: AGENT,
        relay: "test_relay",
        oauth: null,
        redirectHops: 0,
      }),
    ]);
    expect(JSON.stringify(h.events)).not.toContain(UPSTREAM_TOKEN);
  });

  it("applies the header rules: prefixed, passed through, refused — and the capability token is nowhere on the wire", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/orders", {
      method: "POST",
      headers: {
        ...bearer(GOOD),
        "content-type": "application/json",
        accept: "application/json",
        "x-custom": "1",
        "user-agent": "node-fetch",
        "sec-fetch-mode": "cors",
        cookie: "session=abc",
        "x-up-authorization": "Bearer smuggled",
        "x-api-key": GOOD,
      },
      body: '{"a":1}',
    });

    expect(res.status).toBe(200);
    const { saw } = await relayed(res);
    expect(saw.method).toBe("POST");
    expect(saw.body).toBe('{"a":1}');
    expect(saw.headers["content-type"]).toBe("application/json");
    expect(saw.headers.accept).toBe("application/json");
    expect(saw.headers["x-up-x-custom"]).toBe("1");
    expect(saw.headers["x-up-x-up-authorization"]).toBe("Bearer smuggled");
    expect(saw.headers["x-up-authorization"]).toBeUndefined();
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(saw.headers.cookie).toBeUndefined();
    expect(saw.headers["x-up-cookie"]).toBeUndefined();
    // The hop's own fetch stamps a `user-agent` and `sec-fetch-mode` of its own on the way to the
    // upstream — transport, not the caller's; what the rules decide is that the caller's copies were
    // dropped rather than prefixed in.
    expect(saw.headers["x-up-sec-fetch-mode"]).toBeUndefined();
    expect(saw.headers["x-up-user-agent"]).toBeUndefined();
    expect(JSON.stringify(saw.headers)).not.toContain(GOOD);
  });

  it("a connection's rule overrides win over the plugin's — a null prefix forwards the caller's headers as they are", async () => {
    const connection = relayConnection();
    const h = harness({
      ...connection,
      relay: {
        ...(connection.relay as NonNullable<ProxyConnection["relay"]>),
        rules: { prefix: null },
      },
    });
    const res = await h.app.request("/c/conn_r/orders", {
      headers: { ...bearer(GOOD), "x-custom": "1", "user-agent": "node-fetch" },
    });

    const { saw } = await relayed(res);
    expect(saw.headers["x-custom"]).toBe("1");
    expect(saw.headers["x-up-x-custom"]).toBeUndefined();
  });

  it("admits the call exactly as before: no token, a foreign person, a connection outside the token all refuse before the upstream is asked", async () => {
    const h = harness(relayConnection());
    const missing = await h.app.request("/c/conn_r/orders");
    expect(missing.status).toBe(401);
    const foreign = await h.app.request("/c/conn_r/orders", { headers: bearer(OTHER_PERSON) });
    expect(foreign.status).toBe(403);
    expect(await reason(foreign)).toBe("person_mismatch");
    const narrow = harness(relayConnection());
    const outside = await narrow.app.request("/c/conn_r/orders", {
      headers: bearer("not-a-token"),
    });
    expect(outside.status).toBe(401);

    expect(upstream.seen).toHaveLength(0);
    expect(h.obtained()).toBe(0);
    expect(h.events.map((e) => e.outcome)).toEqual(["token_missing", "person_mismatch"]);
    expect(h.events.every((e) => e.relay === null)).toBe(true);
  });

  it("a dry run stops a write at the proxy before the relay's fields are assembled, previewing the upstream's headers on the vendor's path", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/orders", {
      method: "POST",
      headers: { ...bearer(DRY), "content-type": "application/json" },
      body: '{"create":true}',
    });

    expect(res.status).toBe(202);
    expect(res.headers.get(DRY_RUN_HEADER)).toBe("intercepted");
    const preview = (await res.json()) as {
      request: { host: string; path: string; headerNames: string[]; body: string };
    };
    expect(preview.request.host).toBe("api.vendor.example");
    expect(preview.request.path).toBe("/v1/orders");
    expect(preview.request.headerNames).toContain("authorization");
    expect(preview.request.headerNames).toContain("x-up-env");
    expect(preview.request.body).toBe('{"create":true}');
    expect(upstream.seen).toHaveLength(0);
    expect(h.obtained()).toBe(0);
    expect(h.events[0]).toMatchObject({
      outcome: "dry_run_intercepted",
      dryRun: true,
      dryRunOutcome: "intercepted",
      relay: "test_relay",
    });
  });

  it("a dry run's read is relayed like any read and comes back marked forwarded", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/orders", { headers: bearer(DRY) });

    expect(res.status).toBe(200);
    expect(res.headers.get(DRY_RUN_HEADER)).toBe("forwarded");
    expect(upstream.seen).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ dryRunOutcome: "forwarded", relay: "test_relay" });
  });

  it("judges egress on the vendor host, before the upstream is asked: a private primary host and a host outside the set both refuse", async () => {
    const h = harness(relayConnection({ primaryHost: "https://localhost:8443" }));
    const priv = await h.app.request("/c/conn_r/orders", { headers: bearer(GOOD) });
    expect(priv.status).toBe(403);
    expect(await reason(priv)).toBe("host_not_public");

    const set = harness(relayConnection());
    const outside = await set.app.request("/c/conn_r/h/evil.example/orders", {
      headers: bearer(GOOD),
    });
    expect(outside.status).toBe(403);
    expect(await reason(outside)).toBe("host_not_in_set");

    expect(upstream.seen).toHaveLength(0);
    expect(h.obtained()).toBe(0);
    expect(set.obtained()).toBe(0);
  });

  it("the explicit host form relays against the named host of the set", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/h/files.vendor.example/download/1", {
      headers: bearer(GOOD),
    });

    const { saw } = await relayed(res);
    expect(saw.vendorUrl).toBe("https://files.vendor.example/download/1");
    expect(h.events[0]?.host).toBe("files.vendor.example");
  });

  it("returns a redirect to the caller unfollowed, as for every connection", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/moved-outside", { headers: bearer(GOOD) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://evil.example/collect");
    expect(upstream.seen).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ outcome: "redirect_returned", redirectHops: 0 });
  });

  it("under the break glass, follows a redirect inside the vendor's host set as a second relayed hop and returns one outside it", async () => {
    const h = harness(relayConnection(), { followRedirects: true });
    const inside = await h.app.request("/c/conn_r/moved-inside", { headers: bearer(GOOD) });

    expect(inside.status).toBe(200);
    expect(upstream.seen.map((s) => s.vendorUrl)).toEqual([
      "https://api.vendor.example/v1/moved-inside",
      "https://files.vendor.example/v1/new-place",
    ]);
    // Both hops went to the upstream, and both carried its authentication.
    expect(upstream.seen.every((s) => s.headers.authorization === `Bearer ${UPSTREAM_TOKEN}`)).toBe(
      true,
    );
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", redirectHops: 1 });

    upstream.seen.length = 0;
    const outside = await h.app.request("/c/conn_r/moved-outside", { headers: bearer(GOOD) });
    expect(outside.status).toBe(302);
    expect(upstream.seen).toHaveLength(1);
  });

  it("answers 502 relay_unavailable when the relay's fields cannot be assembled, with the failure reduced to class names", async () => {
    const h = harness(
      relayConnection({}, async () => {
        throw new Error("broker token minting failed: secret-detail");
      }),
    );
    const res = await h.app.request("/c/conn_r/orders", {
      method: "POST",
      headers: bearer(GOOD),
      body: "{}",
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "bad_gateway", reason: "relay_unavailable" });
    expect(upstream.seen).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      outcome: "relay_unavailable",
      status: 502,
      requestBytes: 2,
      relay: "test_relay",
    });
    expect(h.events[0]?.failure).toContain("relay.obtain");
    expect(h.events[0]?.failure).not.toContain("secret-detail");
  });

  it("refuses a relay whose fields are incomplete as the connection's fault, 409 credential_incomplete", async () => {
    const h = harness(relayConnection({}, async () => ({ upstreamUrl: upstream.url })));
    const res = await h.app.request("/c/conn_r/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect(await reason(res)).toBe("credential_incomplete");
    expect(upstream.seen).toHaveLength(0);
  });

  it("redacts the relay's own token when the upstream echoes it, as it would a vendor echoing a key", async () => {
    const h = harness(relayConnection());
    const res = await h.app.request("/c/conn_r/echo", { headers: bearer(GOOD) });

    expect(res.status).toBe(401);
    expect(res.headers.get(REDACTED_HEADER)).toBe("credential");
    const text = await res.text();
    expect(text).toContain(CREDENTIAL_REDACTED);
    expect(text).not.toContain(UPSTREAM_TOKEN);
    expect(h.events[0]).toMatchObject({ credentialEchoed: true, upstreamStatus: 401 });
  });

  it("a relay with no primary host is not ready, like any connection", async () => {
    const h = harness(relayConnection({ primaryHost: null }));
    const res = await h.app.request("/c/conn_r/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect(await reason(res)).toBe("connection_not_ready");
    expect(h.obtained()).toBe(0);
  });

  it("a revoked relay row is refused as revoked, and the relay's fields are never assembled (GRA-68)", async () => {
    const h = harness(relayConnection({ revokedAt: new Date("2026-09-18T09:00:00Z") }));
    const res = await h.app.request("/c/conn_r/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(409);
    expect(await reason(res)).toBe("connection_revoked");
    expect(h.obtained()).toBe(0);
    expect(h.sent).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ outcome: "connection_revoked", relay: null });
  });

  it("a connection with no relay takes the inject path exactly as before", async () => {
    const h = harness({
      id: "conn_r",
      personId: PERSON,
      authScheme: "bearer",
      primaryHost: "https://api.vendor.example/v1",
      hosts: ["api.vendor.example"],
      schemeConfig: {},
      credentialCiphertext: new Uint8Array([1]),
    });
    const res = await h.app.request("/c/conn_r/orders", { headers: bearer(GOOD) });

    // The harness's decrypt throws — the point is which rung was reached: the decrypt, not a relay.
    expect(res.status).toBe(500);
    expect(await reason(res)).toBe("credential_unreadable");
    expect(h.events[0]?.relay).toBeNull();
  });
});
