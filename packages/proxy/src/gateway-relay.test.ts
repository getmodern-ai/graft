import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createProxyApp } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import { CREDENTIAL_REDACTED, REDACTED_HEADER } from "./echo";
import {
  GATEWAY_PREFIX_PASS_THROUGH,
  GATEWAY_RELAY_FIELDS,
  GATEWAY_RELAY_RULES,
  GATEWAY_RELAY_SCHEME,
  gatewayRelay,
  gatewayRelayUrl,
} from "./gateway-relay";
import { PASSTHROUGH_RELAY_RULES, RELAYS } from "./relay";
import { MissingCredentialFieldError } from "./scheme-errors";
import type {
  CapabilityClaims,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyRelay,
  TokenVerdict,
  UpstreamRequest,
} from "./types";
import { RELAY_SCHEMES } from "./types";
import { createUpstreamFetch } from "./upstream";

/**
 * The gateway relay (ADR 0019, GRA-58) through the ladder, against a **fake API gateway**: a real
 * HTTP server on a loopback port that routes the way a company's gateway does — the first path
 * segment is the vendor host, the rest the vendor path — and reports what it saw, refuses a
 * deployment identity it does not know with 401, and answers 502 when told the vendor is down.
 * What these pin: the vendor URL preserved in the path, the identity header attached, the caller's
 * headers travelling under their own names (or under a prefix when the deployment says so), a dry
 * run stopping a write before the gateway is asked, the gateway's own 401 and 502 passing through
 * as the upstream's answer with the event naming `relay: gateway`, a gateway that cannot be reached
 * mapped to the proxy's `upstream_unreachable`, and — through the real `createUpstreamFetch` — the
 * address guard lifted for the configured gateway host and for nothing else.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const GOOD = "good-token";
const DRY = "dry-run-token";
const IDENTITY = "deployment-identity-secret-value";
const HEADER = "X-Deployment-Token";

/** What the fake gateway saw of one relayed request. */
type Seen = {
  method: string;
  vendorHost: string;
  vendorPath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
};

/**
 * `/<vendor host>/<vendor path>`, under an optional base path the test mounts the gateway at.
 * `/vendor-down` on any host answers 502, as a gateway does when the vendor behind a route does
 * not answer; `/echo` quotes the identity it was sent, as a refusal page might.
 */
function startGateway(basePath = ""): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://gateway.test");
      const rest = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : "";
      const [, vendorHost = "", ...path] = rest.split("/");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      const record: Seen = {
        method: req.method ?? "",
        vendorHost,
        vendorPath: `/${path.join("/")}`,
        query: Object.fromEntries(url.searchParams),
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(record);
      if (headers[HEADER.toLowerCase()] !== IDENTITY) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unknown deployment" }));
      }
      if (record.vendorPath.endsWith("/vendor-down")) {
        res.writeHead(502, { "content-type": "text/plain" });
        return res.end("the vendor did not answer the gateway");
      }
      if (record.vendorPath.endsWith("/echo")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ youSent: headers[HEADER.toLowerCase()] }));
      }
      // An upstream speaking in the proxy's own response namespace (GRA-79, Greptile on #59).
      if (record.vendorPath.endsWith("/spoof")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-graft-refusal": "upstream_unreachable",
          "x-graft-dry-run": "intercepted",
          "x-gateway-request-id": "gw_spoof",
        });
        return res.end(JSON.stringify({ relayed: true }));
      }
      res.writeHead(200, { "content-type": "application/json", "x-gateway-request-id": "gw_1" });
      res.end(JSON.stringify({ relayed: true, saw: record }));
    });
  });
  return new Promise((resolve) => {
    // Every interface, so `localhost` reaches it whether the resolver answers `::1` or `127.0.0.1`.
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}${basePath}`, seen });
    });
  });
}

let gateway: Awaited<ReturnType<typeof startGateway>>;

beforeAll(async () => {
  gateway = await startGateway("/graft");
});

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
});

beforeEach(() => {
  gateway.seen.length = 0;
});

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_g"],
    tool: "execute",
    jti: "jti_1",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    ...overrides,
  };
}

/** The relay the gateway provider hands the proxy (`@graft/core`'s `gateway-provider.ts`), shaped here by hand. */
function gatewayRelayFor(
  upstreamUrl: string,
  overrides: Partial<ProxyRelay> = {},
  headerValue = IDENTITY,
): ProxyRelay {
  return {
    plugin: gatewayRelay,
    obtain: async () => ({
      [GATEWAY_RELAY_FIELDS.upstreamUrl]: upstreamUrl,
      [GATEWAY_RELAY_FIELDS.headerName]: HEADER,
      [GATEWAY_RELAY_FIELDS.headerValue]: headerValue,
    }),
    headerNames: [HEADER.toLowerCase()],
    ...overrides,
  };
}

function connection(relay: ProxyRelay, overrides: Partial<ProxyConnection> = {}): ProxyConnection {
  return {
    id: "conn_g",
    personId: PERSON,
    authScheme: null,
    primaryHost: "https://api.vendor.example/v1",
    hosts: ["api.vendor.example", "files.vendor.example"],
    schemeConfig: null,
    credentialCiphertext: null,
    relay,
    ...overrides,
  };
}

/** The proxy over the fake gateway. The default fetch is a plain one; a test may hand the real guarded one. */
function harness(row: ProxyConnection, upstreamFetch?: ProxyDeps["upstreamFetch"]) {
  const events: ProxyEvent[] = [];
  const sent: UpstreamRequest[] = [];
  const ok = (c: CapabilityClaims): TokenVerdict => ({ ok: true, claims: c });
  const tokens = new Map<string, TokenVerdict>([
    [GOOD, ok(claims())],
    [DRY, ok(claims({ dryRun: true }))],
  ]);
  const deps: ProxyDeps = {
    verifyToken: async (token) => tokens.get(token) ?? { ok: false, reason: "invalid" },
    jwks: async () => ({ keys: [] }),
    connections: { get: async (id) => (id === row.id ? row : null) },
    decryptCredential: async () => {
      throw new Error("a gateway connection decrypts nothing");
    },
    upstreamFetch:
      upstreamFetch ??
      (async (request, { signal }) => {
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
      }),
    log: (event) => events.push(event),
  };
  return { app: createProxyApp(deps), events, sent };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function relayed(response: Response): Promise<{ relayed: boolean; saw: Seen }> {
  return response.json() as Promise<{ relayed: boolean; saw: Seen }>;
}

describe("the gateway relay's URL form", () => {
  it("carries the vendor host as the first segment, the path and query after it, under the gateway's base path", () => {
    expect(
      gatewayRelayUrl(
        new URL("https://gateway.corp.example/graft/"),
        new URL("https://api.vendor.example/v1/orders?limit=5&q=a%20b"),
      ).href,
    ).toBe("https://gateway.corp.example/graft/api.vendor.example/v1/orders?limit=5&q=a%20b");
    expect(
      gatewayRelayUrl(
        new URL("https://gateway.corp.example"),
        new URL("https://api.vendor.example/"),
      ).href,
    ).toBe("https://gateway.corp.example/api.vendor.example/");
  });

  it("keeps a vendor port in the host segment and leaves the vendor's encoding as it was", () => {
    expect(
      gatewayRelayUrl(
        new URL("http://127.0.0.1:9000"),
        new URL("https://api.vendor.example:8443/a%2Fb/c"),
      ).href,
    ).toBe("http://127.0.0.1:9000/api.vendor.example:8443/a%2Fb/c");
  });
});

describe("the gateway relay plugin", () => {
  it("is catalogued under its scheme, forwards caller headers under their own names, and names no header of its own", () => {
    expect(RELAYS[GATEWAY_RELAY_SCHEME]).toBe(gatewayRelay);
    expect(RELAY_SCHEMES).toContain(GATEWAY_RELAY_SCHEME);
    expect(gatewayRelay.scheme).toBe("gateway");
    expect(gatewayRelay.rules).toEqual(PASSTHROUGH_RELAY_RULES);
    expect(GATEWAY_RELAY_RULES).toEqual(PASSTHROUGH_RELAY_RULES);
    expect(gatewayRelay.headerNames()).toEqual([]);
    expect(GATEWAY_PREFIX_PASS_THROUGH).toContain("content-type");
  });

  it("rewrites the target to the gateway's URL and sets the identity header, overwriting a caller's of the same name", () => {
    const target = {
      url: new URL("https://api.vendor.example/v1/orders?limit=5"),
      headers: new Headers({ [HEADER]: "smuggled", "x-custom": "1" }),
    };
    gatewayRelay.relay(
      target,
      {
        upstreamUrl: "https://gateway.corp.example/graft",
        headerName: HEADER,
        headerValue: IDENTITY,
      },
      gatewayRelay.rules,
    );
    expect(target.url.href).toBe(
      "https://gateway.corp.example/graft/api.vendor.example/v1/orders?limit=5",
    );
    expect(target.headers.get(HEADER)).toBe(IDENTITY);
    expect(target.headers.get("x-custom")).toBe("1");
  });

  it("refuses to leave without any of its three fields, or with an upstream that is not a URL, as a missing field", () => {
    const target = () => ({
      url: new URL("https://api.vendor.example/v1"),
      headers: new Headers(),
    });
    const complete = {
      upstreamUrl: "https://g.example",
      headerName: HEADER,
      headerValue: IDENTITY,
    };
    for (const field of Object.values(GATEWAY_RELAY_FIELDS)) {
      const { [field]: _dropped, ...fields } = complete;
      expect(() => gatewayRelay.relay(target(), fields, gatewayRelay.rules)).toThrow(
        MissingCredentialFieldError,
      );
    }
    expect(() =>
      gatewayRelay.relay(target(), { ...complete, upstreamUrl: "not a url" }, gatewayRelay.rules),
    ).toThrow(MissingCredentialFieldError);
  });
});

describe("the ladder relays a gateway connection through the fake gateway", () => {
  it("preserves the vendor host, path and query in the gateway's path, attaches the identity header, and answers the gateway's response verbatim", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const res = await h.app.request("/c/conn_g/orders?limit=5", {
      headers: { ...bearer(GOOD), "x-request-id": "req_1", accept: "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-request-id")).toBe("gw_1");
    const { saw } = await relayed(res);
    expect(saw.vendorHost).toBe("api.vendor.example");
    expect(saw.vendorPath).toBe("/v1/orders");
    expect(saw.query).toEqual({ limit: "5" });
    // The caller's headers under their own names; the identity header the gateway wanted.
    expect(saw.headers["x-request-id"]).toBe("req_1");
    expect(saw.headers.accept).toBe("application/json");
    expect(gateway.seen[0]?.headers[HEADER.toLowerCase()]).toBe(IDENTITY);
    // The capability token reached the gateway in no position.
    expect(saw.headers.authorization).toBeUndefined();
    expect(JSON.stringify(saw.headers)).not.toContain(GOOD);
    // The request that left went to the gateway, under its base path, not to the vendor.
    expect(h.sent.map((r) => r.url)).toEqual([
      `${gateway.url}/api.vendor.example/v1/orders?limit=5`,
    ]);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      status: 200,
      upstreamStatus: 200,
      host: "api.vendor.example",
      path: "/orders",
      relay: "gateway",
      connectionId: "conn_g",
    });
    expect(JSON.stringify(h.events)).not.toContain(IDENTITY);
  });

  it("relays the explicit host form against the named host of the set, and a POST body whole", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const res = await h.app.request("/c/conn_g/h/files.vendor.example/upload", {
      method: "POST",
      headers: { ...bearer(GOOD), "content-type": "application/json" },
      body: '{"a":1}',
    });

    const { saw } = await relayed(res);
    expect(saw.method).toBe("POST");
    expect(saw.vendorHost).toBe("files.vendor.example");
    expect(saw.vendorPath).toBe("/upload");
    expect(saw.body).toBe('{"a":1}');
    expect(saw.headers["content-type"]).toBe("application/json");
    expect(h.events[0]?.host).toBe("files.vendor.example");
  });

  it("under a deployment's prefix rule, prefixes the caller's headers and passes the framing through", async () => {
    const h = harness(
      connection(
        gatewayRelayFor(gateway.url, {
          rules: { prefix: "x-graft-", passThrough: GATEWAY_PREFIX_PASS_THROUGH },
        }),
      ),
    );
    const res = await h.app.request("/c/conn_g/orders", {
      method: "POST",
      headers: {
        ...bearer(GOOD),
        "content-type": "application/json",
        accept: "application/json",
        "x-custom": "1",
        [HEADER]: "smuggled",
      },
      body: "{}",
    });

    const { saw } = await relayed(res);
    expect(saw.headers["x-graft-x-custom"]).toBe("1");
    expect(saw.headers["x-custom"]).toBeUndefined();
    expect(saw.headers["content-type"]).toBe("application/json");
    expect(saw.headers.accept).toBe("application/json");
    // The caller's copy of the identity header is prefixed away; the gateway saw the deployment's.
    expect(saw.headers[`x-graft-${HEADER.toLowerCase()}`]).toBe("smuggled");
    expect(gateway.seen[0]?.headers[HEADER.toLowerCase()]).toBe(IDENTITY);
  });

  it("a dry run stops a write at the proxy before the gateway is asked, previewing the identity header by name on the vendor's path", async () => {
    let obtained = 0;
    const relay = gatewayRelayFor(gateway.url);
    const h = harness(
      connection({
        ...relay,
        obtain: () => {
          obtained += 1;
          return relay.obtain();
        },
      }),
    );
    const res = await h.app.request("/c/conn_g/orders", {
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
    expect(preview.request.headerNames).toContain(HEADER.toLowerCase());
    expect(preview.request.headerNames).toContain("content-type");
    expect(preview.request.body).toBe('{"create":true}');
    expect(gateway.seen).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(obtained).toBe(0);
    expect(h.events[0]).toMatchObject({
      outcome: "dry_run_intercepted",
      dryRun: true,
      dryRunOutcome: "intercepted",
      relay: "gateway",
      upstreamStatus: null,
    });

    // A dry run's read is relayed like any read and comes back marked forwarded.
    const read = await h.app.request("/c/conn_g/orders", { headers: bearer(DRY) });
    expect(read.status).toBe(200);
    expect(read.headers.get(DRY_RUN_HEADER)).toBe("forwarded");
    expect(gateway.seen).toHaveLength(1);
  });

  it("a gateway 401 — the deployment identity refused — passes through as the upstream's answer, with the event naming the gateway", async () => {
    const h = harness(
      connection(gatewayRelayFor(gateway.url, {}, "not-the-identity-the-gateway-knows")),
    );
    const res = await h.app.request("/c/conn_g/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unknown deployment" });
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      status: 401,
      upstreamStatus: 401,
      relay: "gateway",
      host: "api.vendor.example",
    });
  });

  it("a gateway 502 — the vendor behind it down — passes through as the upstream's answer", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const res = await h.app.request("/c/conn_g/vendor-down", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    expect(await res.text()).toBe("the vendor did not answer the gateway");
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", status: 502, upstreamStatus: 502 });
  });

  it("a gateway that cannot be reached is the proxy's own 502 upstream_unreachable, in the failure shape", async () => {
    const closed = await startGateway();
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    const h = harness(connection(gatewayRelayFor(closed.url)));
    const res = await h.app.request("/c/conn_g/orders", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    // Marked as the proxy's (GRA-79), naming the *vendor* host the caller asked for — the gateway's
    // own name is the operator's and stays off the wire to the sandbox.
    expect(res.headers.get("x-graft-refusal")).toBe("upstream_unreachable");
    expect(await res.json()).toEqual({
      error: "bad_gateway",
      reason: "upstream_unreachable",
      message: expect.any(String),
      code: "ECONNREFUSED",
      host: "api.vendor.example",
    });
    expect(h.events[0]).toMatchObject({ outcome: "upstream_unreachable", relay: "gateway" });
    expect(h.events[0]?.failure).toMatch(/ECONNREFUSED|fetch failed/);
  });

  it("drops every x-graft-* header the gateway answers with, as the vendor leg does", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const res = await h.app.request("/c/conn_g/spoof", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect([...res.headers.keys()].filter((name) => name.startsWith("x-graft-"))).toEqual([]);
    expect(res.headers.get("x-gateway-request-id")).toBe("gw_spoof");
    expect(await res.json()).toEqual({ relayed: true });
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", relay: "gateway" });
  });

  it("redacts the identity value when the gateway echoes it, as it would a vendor echoing a key", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const res = await h.app.request("/c/conn_g/echo", { headers: bearer(GOOD) });

    expect(res.status).toBe(200);
    expect(res.headers.get(REDACTED_HEADER)).toBe("credential");
    expect(await res.json()).toEqual({ youSent: CREDENTIAL_REDACTED });
    expect(h.events[0]).toMatchObject({ credentialEchoed: true });
  });

  it("judges egress on the vendor host, and refuses a vendor outside the connection's set before the gateway is asked", async () => {
    const h = harness(connection(gatewayRelayFor(gateway.url)));
    const outside = await h.app.request("/c/conn_g/h/evil.example/orders", {
      headers: bearer(GOOD),
    });
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ reason: "host_not_in_set" });
    expect(gateway.seen).toHaveLength(0);
  });

  /**
   * By *name*: the guard sits in the resolver the socket opens through, and an IP literal is never
   * resolved — `127.0.0.1` reaches the socket without asking it, and the ladder's literal check is
   * about the vendor host, never the relay URL, which is the operator's (`upstream.ts`). So the
   * gateway here is addressed as `localhost`, which the resolver answers privately.
   */
  it("through the real upstream fetch, the relay's own fetch lifts the address guard for the gateway's hostname; the proxy's shared fetch lifts it for nothing", async () => {
    const byName = gateway.url.replace("127.0.0.1", "localhost");
    // The provider brought the relay leg its own way out; the proxy's shared fetch is fully guarded.
    const exempt = harness(
      connection(
        gatewayRelayFor(byName, {
          upstreamFetch: createUpstreamFetch({ unguardedHosts: ["localhost"] }),
        }),
      ),
      createUpstreamFetch(),
    );
    const res = await exempt.app.request("/c/conn_g/orders", { headers: bearer(GOOD) });
    expect(res.status).toBe(200);
    expect(gateway.seen).toHaveLength(1);

    // A relay with no fetch of its own goes out the shared, guarded one, and the name is refused
    // once it resolves to the loopback.
    const guarded = harness(connection(gatewayRelayFor(byName)), createUpstreamFetch());
    const refused = await guarded.app.request("/c/conn_g/orders", { headers: bearer(GOOD) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "host_not_public" });
    expect(gateway.seen).toHaveLength(1);

    // And an exemption for another name lifts nothing for this one.
    const other = harness(
      connection(
        gatewayRelayFor(byName, {
          upstreamFetch: createUpstreamFetch({ unguardedHosts: ["gateway.corp.internal"] }),
        }),
      ),
      createUpstreamFetch(),
    );
    expect((await other.app.request("/c/conn_g/orders", { headers: bearer(GOOD) })).status).toBe(
      403,
    );
  });
});
