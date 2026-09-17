import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createProxyApp } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import { CREDENTIAL_REDACTED } from "./echo";
import {
  decodePipedreamProxySegment,
  PIPEDREAM_API_ORIGIN,
  PIPEDREAM_RELAY_HEADER_PREFIX,
  PIPEDREAM_RELAY_RULES,
  pipedreamConnectProxyRelay,
  pipedreamProxyUrl,
} from "./pipedream-relay";
import { RELAYS, relayHeaders, relayRefuses } from "./relay";
import { MissingCredentialFieldError } from "./scheme-errors";
import type {
  CapabilityClaims,
  CredentialFields,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  TokenVerdict,
  UpstreamRequest,
} from "./types";

/**
 * Pipedream's relay (GRA-59), twice over. First the plugin alone: the URL it writes and the two
 * headers it sets, against the contract Pipedream documents for its Connect proxy. Then the ladder
 * relaying a Gmail-shaped connection through a **fake Pipedream proxy** — a `node:http` server on a
 * loopback port that decodes the vendor URL out of `/v1/connect/:project/proxy/:segment` and answers
 * with what it saw — so what is pinned is the whole path a tool's call takes: both query parameters,
 * the two headers, every caller header prefixed (an already-prefixed one included), the framing pair
 * passed through, the refused set dropped, a write stopped by a dry run before Pipedream is asked,
 * the vendor host judged for egress and redirects, and a refusal of Graft's own credentials answered
 * as the proxy's `relay_unavailable` rather than as a vendor's answer. `relay.test.ts` pins the
 * engine with a plugin of its own; this file pins the one entry in `RELAYS`.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const GOOD = "good-token";
const DRY = "dry-run-token";
const ACCESS_TOKEN = "pd-connect-access-token-value";
const PROJECT = "proj_test123";
const EXTERNAL_USER = "graft-person-person_1";
const ACCOUNT = "apn_gmail_1";

const FIELDS: CredentialFields = {
  accessToken: ACCESS_TOKEN,
  projectId: PROJECT,
  environment: "development",
  externalUserId: EXTERNAL_USER,
  accountId: ACCOUNT,
};

describe("the Pipedream relay plugin", () => {
  it("is the catalogued pipedream_connect_proxy entry, with Pipedream's header rules", () => {
    expect(RELAYS.pipedream_connect_proxy).toBe(pipedreamConnectProxyRelay);
    expect(pipedreamConnectProxyRelay.scheme).toBe("pipedream_connect_proxy");
    expect(pipedreamConnectProxyRelay.rules).toBe(PIPEDREAM_RELAY_RULES);
    expect(PIPEDREAM_RELAY_RULES.prefix).toBe(PIPEDREAM_RELAY_HEADER_PREFIX);
    expect(PIPEDREAM_RELAY_RULES.passThrough).toEqual(["content-type", "accept"]);
    // Pipedream's documented restricted list plus `user-agent` (Cando's CAN-566), by name and family.
    for (const name of ["User-Agent", "Cookie", "Host", "Origin", "Referer", "Content-Length"]) {
      expect(relayRefuses(name, PIPEDREAM_RELAY_RULES), name).toBe(true);
    }
    expect(relayRefuses("Sec-Fetch-Mode", PIPEDREAM_RELAY_RULES)).toBe(true);
    expect(relayRefuses("Proxy-Authorization", PIPEDREAM_RELAY_RULES)).toBe(true);
    expect(relayRefuses("x-goog-api-client", PIPEDREAM_RELAY_RULES)).toBe(false);
    expect(pipedreamConnectProxyRelay.headerNames()).toEqual(["authorization", "x-pd-environment"]);
  });

  it("rewrites the vendor URL into Pipedream's proxy path — URL-safe base64, the two ids in the query — and authenticates Graft", () => {
    const target = {
      url: new URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=has%3Aattachment",
      ),
      headers: new Headers({ accept: "application/json" }),
    };
    pipedreamConnectProxyRelay.relay(target, FIELDS, PIPEDREAM_RELAY_RULES);

    expect(target.url.origin).toBe(PIPEDREAM_API_ORIGIN);
    const segments = target.url.pathname.split("/");
    expect(segments.slice(0, 5)).toEqual(["", "v1", "connect", PROJECT, "proxy"]);
    const decoded = decodePipedreamProxySegment(segments[5] ?? "");
    expect(decoded?.href).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=has%3Aattachment",
    );
    expect(segments[5]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Object.fromEntries(target.url.searchParams)).toEqual({
      external_user_id: EXTERNAL_USER,
      account_id: ACCOUNT,
    });
    expect(target.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(target.headers.get("x-pd-environment")).toBe("development");
    expect(target.headers.get("accept")).toBe("application/json");
  });

  it("relays to another Connect API origin when the fields name one — a fake, a laptop — and to the real one otherwise", () => {
    const withOrigin = { url: new URL("https://gmail.googleapis.com/x"), headers: new Headers() };
    pipedreamConnectProxyRelay.relay(
      withOrigin,
      { ...FIELDS, apiOrigin: "http://127.0.0.1:4567/" },
      PIPEDREAM_RELAY_RULES,
    );
    expect(withOrigin.url.href.startsWith("http://127.0.0.1:4567/v1/connect/")).toBe(true);

    const url = pipedreamProxyUrl(new URL("https://gmail.googleapis.com/x"), {
      apiOrigin: PIPEDREAM_API_ORIGIN,
      projectId: "proj_a/b",
      externalUserId: "u",
      accountId: "a",
    });
    // The project id is path-encoded, never spliced.
    expect(url.pathname.startsWith("/v1/connect/proj_a%2Fb/proxy/")).toBe(true);
  });

  it("refuses a field it cannot run without as the connection's fault, naming the field and never a value", () => {
    for (const missing of [
      "accessToken",
      "projectId",
      "environment",
      "externalUserId",
      "accountId",
    ] as const) {
      const { [missing]: _dropped, ...rest } = FIELDS;
      const target = { url: new URL("https://gmail.googleapis.com/x"), headers: new Headers() };
      expect(() => pipedreamConnectProxyRelay.relay(target, rest, PIPEDREAM_RELAY_RULES)).toThrow(
        MissingCredentialFieldError,
      );
      try {
        pipedreamConnectProxyRelay.relay(target, rest, PIPEDREAM_RELAY_RULES);
      } catch (error) {
        expect((error as Error).message).toContain(missing);
        expect((error as Error).message).not.toContain(ACCESS_TOKEN);
      }
    }
  });

  it("the header rules, applied by the engine: every caller header prefixed, the prefixed one doubled, the framing pair as itself, the refused set gone", () => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json",
      "x-goog-api-client": "gl-node/24",
      "x-pd-proxy-authorization": "Bearer smuggled",
      "user-agent": "node",
      cookie: "a=b",
      "sec-fetch-mode": "cors",
      "accept-encoding": "gzip",
      referer: "https://sandbox.example",
    });
    relayHeaders(headers, PIPEDREAM_RELAY_RULES);
    expect([...headers.entries()].sort()).toEqual([
      ["accept", "application/json"],
      ["content-type", "application/json"],
      ["x-pd-proxy-x-goog-api-client", "gl-node/24"],
      ["x-pd-proxy-x-pd-proxy-authorization", "Bearer smuggled"],
    ]);
  });
});

/** What the fake Pipedream proxy saw of one relayed request, reported back in its JSON answer. */
type Seen = {
  method: string;
  project: string | null;
  vendorUrl: string | null;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
};

/**
 * The fake Pipedream Connect proxy: `/v1/connect/:project/proxy/:segment`. It answers with what it
 * saw, so a test asserts the vendor URL it decoded and the headers it received off the response
 * body. A `messages.list` answers a Gmail-shaped body; `/redirect-inside` and `/redirect-outside`
 * answer a 302 whose `Location` is inside and outside the connection's host set, as a vendor's
 * redirect passed through by Pipedream would; `/echo` quotes the bearer it was sent, as Pipedream
 * quoting a refused token would; and a request whose bearer is not Graft's answers Pipedream's own
 * 401, which is what a token the Connect API no longer honours would meet.
 */
function startFakePipedreamProxy(): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://pipedream.test");
      const match = /^\/v1\/connect\/([^/]+)\/proxy\/([^/]+)$/.exec(url.pathname);
      const vendorUrl = match?.[2] ? decodePipedreamProxySegment(match[2]) : null;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      const record: Seen = {
        method: req.method ?? "",
        project: match?.[1] ?? null,
        vendorUrl: vendorUrl?.href ?? null,
        query: Object.fromEntries(url.searchParams),
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(record);
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "not a proxy path" }));
      }
      if (headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }
      const vendorPath = vendorUrl?.pathname ?? "";
      if (vendorPath.endsWith("/redirect-inside")) {
        res.writeHead(302, { location: "https://www.googleapis.com/upload/v1/moved" });
        return res.end();
      }
      if (vendorPath.endsWith("/redirect-outside")) {
        res.writeHead(302, { location: "https://evil.example/collect" });
        return res.end();
      }
      if (vendorPath.endsWith("/echo")) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `bad token ${headers.authorization}` }));
      }
      // An upstream speaking in the proxy's own response namespace (GRA-79, Greptile on #59).
      if (vendorPath.endsWith("/spoof")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-graft-refusal": "upstream_unreachable",
          "x-graft-dry-run": "intercepted",
          "x-pd-request-id": "pd_spoof",
        });
        return res.end(JSON.stringify({ relayed: true }));
      }
      if (vendorPath.endsWith("/messages")) {
        res.writeHead(200, { "content-type": "application/json", "x-pd-request-id": "pd_1" });
        return res.end(
          JSON.stringify({
            messages: [{ id: "18f1", threadId: "18f1" }],
            resultSizeEstimate: 1,
            saw: record,
          }),
        );
      }
      res.writeHead(200, { "content-type": "application/json", "x-pd-request-id": "pd_1" });
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

let pipedream: Awaited<ReturnType<typeof startFakePipedreamProxy>>;

beforeAll(async () => {
  pipedream = await startFakePipedreamProxy();
});

afterAll(async () => {
  await new Promise<void>((resolve) => pipedream.server.close(() => resolve()));
});

beforeEach(() => {
  pipedream.seen.length = 0;
});

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_gmail"],
    tool: "gmail__read-message",
    jti: "jti_1",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    ...overrides,
  };
}

/** A Gmail connection as the Pipedream provider resolves it: the relay, and no signing columns. */
function gmailConnection(
  overrides: Partial<ProxyConnection> = {},
  obtain?: () => Promise<CredentialFields>,
): ProxyConnection {
  return {
    id: "conn_gmail",
    personId: PERSON,
    authScheme: null,
    primaryHost: "https://gmail.googleapis.com/gmail/v1",
    hosts: ["gmail.googleapis.com", "www.googleapis.com"],
    schemeConfig: null,
    credentialCiphertext: null,
    relay: {
      plugin: pipedreamConnectProxyRelay,
      obtain: obtain ?? (async () => ({ ...FIELDS, apiOrigin: pipedream.url })),
    },
    ...overrides,
  };
}

function harness(connection: ProxyConnection, options: Partial<ProxyOptions> = {}) {
  const events: ProxyEvent[] = [];
  const sent: UpstreamRequest[] = [];
  let obtained = 0;
  const wrapped: ProxyConnection = {
    ...connection,
    relay: connection.relay
      ? {
          ...connection.relay,
          obtain: () => {
            obtained += 1;
            return connection.relay?.obtain() ?? Promise.reject(new Error("no relay"));
          },
        }
      : connection.relay,
  };
  const ok = (c: CapabilityClaims): TokenVerdict => ({ ok: true, claims: c });
  const tokens = new Map<string, TokenVerdict>([
    [GOOD, ok(claims())],
    [DRY, ok(claims({ dryRun: true }))],
  ]);
  const deps: ProxyDeps = {
    verifyToken: async (token) => tokens.get(token) ?? { ok: false, reason: "invalid" },
    jwks: async () => ({ keys: [] }),
    connections: { get: async (id) => (id === wrapped.id ? wrapped : null) },
    decryptCredential: async () => {
      throw new Error("a relayed connection decrypts nothing");
    },
    // The default fetch pins DNS to public addresses and would refuse the loopback the fake listens
    // on — the rule under test in `upstream.test.ts`, not here.
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

async function answered(response: Response): Promise<{ saw: Seen } & Record<string, unknown>> {
  return response.json() as Promise<{ saw: Seen } & Record<string, unknown>>;
}

async function reason(response: Response): Promise<string> {
  return ((await response.json()) as { reason: string }).reason;
}

describe("the ladder relays a Gmail connection through Pipedream's proxy", () => {
  it("a messages.list leaves for Pipedream with the vendor URL in the path, both ids in the query, the two headers, and comes back as Pipedream answered", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request("/c/conn_gmail/users/me/messages?maxResults=5", {
      headers: { ...bearer(GOOD), accept: "application/json", "x-goog-api-client": "gl-node" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-pd-request-id")).toBe("pd_1");
    const body = await answered(res);
    expect(body.messages).toEqual([{ id: "18f1", threadId: "18f1" }]);
    expect(body.saw.vendorUrl).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
    );
    // Read server-side: every relay field is a value the echo rule redacts on the way back
    // (`echo.ts`), the project id and the two ids among them, so the copies in the body are marked.
    expect(pipedream.seen[0]?.project).toBe(PROJECT);
    expect(pipedream.seen[0]?.query).toEqual({
      external_user_id: EXTERNAL_USER,
      account_id: ACCOUNT,
    });
    expect(body.saw.query).toEqual({
      external_user_id: CREDENTIAL_REDACTED,
      account_id: CREDENTIAL_REDACTED,
    });
    expect(pipedream.seen[0]?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(pipedream.seen[0]?.headers["x-pd-environment"]).toBe("development");
    expect(body.saw.headers.accept).toBe("application/json");
    expect(body.saw.headers["x-pd-proxy-x-goog-api-client"]).toBe("gl-node");
    // The request left for Pipedream, not for Google.
    expect(h.sent.map((r) => new URL(r.url).host)).toEqual([new URL(pipedream.url).host]);
    expect(h.obtained()).toBe(1);
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      host: "gmail.googleapis.com",
      path: "/users/me/messages",
      relay: "pipedream_connect_proxy",
      upstreamStatus: 200,
    });
    expect(JSON.stringify(h.events)).not.toContain(ACCESS_TOKEN);
  });

  it("prefixes every caller header — an already-prefixed one twice — passes the framing pair through, drops the refused set, and puts the capability token nowhere", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request("/c/conn_gmail/users/me/messages/send", {
      method: "POST",
      headers: {
        ...bearer(GOOD),
        "content-type": "application/json",
        accept: "application/json",
        "x-goog-api-client": "gl-node",
        "x-pd-proxy-authorization": "Bearer smuggled",
        "user-agent": "node-fetch",
        "sec-fetch-mode": "cors",
        cookie: "session=abc",
        referer: "https://sandbox.example/",
        "x-api-key": GOOD,
      },
      body: '{"raw":"..."}',
    });

    expect(res.status).toBe(200);
    const { saw } = await answered(res);
    expect(saw.method).toBe("POST");
    expect(saw.body).toBe('{"raw":"..."}');
    expect(saw.headers["content-type"]).toBe("application/json");
    expect(saw.headers.accept).toBe("application/json");
    expect(saw.headers["x-pd-proxy-x-goog-api-client"]).toBe("gl-node");
    expect(saw.headers["x-pd-proxy-x-pd-proxy-authorization"]).toBe("Bearer smuggled");
    expect(saw.headers["x-pd-proxy-authorization"]).toBeUndefined();
    expect(saw.headers.cookie).toBeUndefined();
    expect(saw.headers["x-pd-proxy-cookie"]).toBeUndefined();
    expect(saw.headers["x-pd-proxy-referer"]).toBeUndefined();
    // The hop's own fetch stamps transport headers of its own; the caller's copies were dropped.
    expect(saw.headers["x-pd-proxy-user-agent"]).toBeUndefined();
    expect(saw.headers["x-pd-proxy-sec-fetch-mode"]).toBeUndefined();
    expect(saw.headers["x-pd-proxy-x-api-key"]).toBeUndefined();
    expect(JSON.stringify(saw.headers)).not.toContain(GOOD);
  });

  it("a dry run stops a write before Pipedream is asked and before the relay's fields are assembled, previewing the vendor path", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request("/c/conn_gmail/users/me/messages/send", {
      method: "POST",
      headers: { ...bearer(DRY), "content-type": "application/json" },
      body: '{"raw":"..."}',
    });

    expect(res.status).toBe(202);
    expect(res.headers.get(DRY_RUN_HEADER)).toBe("intercepted");
    const preview = (await res.json()) as {
      request: { host: string; path: string; headerNames: string[] };
    };
    expect(preview.request.host).toBe("gmail.googleapis.com");
    expect(preview.request.path).toBe("/gmail/v1/users/me/messages/send");
    expect(preview.request.headerNames).toEqual(
      expect.arrayContaining(["authorization", "x-pd-environment", "content-type"]),
    );
    expect(pipedream.seen).toHaveLength(0);
    expect(h.obtained()).toBe(0);
    expect(h.events[0]).toMatchObject({
      outcome: "dry_run_intercepted",
      relay: "pipedream_connect_proxy",
    });
  });

  it("judges egress on the vendor host: a host outside the set and a private primary both refuse before Pipedream is asked", async () => {
    const outside = harness(gmailConnection());
    const res = await outside.app.request("/c/conn_gmail/h/evil.example/collect", {
      headers: bearer(GOOD),
    });
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe("host_not_in_set");

    const priv = harness(gmailConnection({ primaryHost: "https://10.0.0.5/gmail/v1" }));
    const res2 = await priv.app.request("/c/conn_gmail/users/me/messages", {
      headers: bearer(GOOD),
    });
    expect(res2.status).toBe(403);
    expect(await reason(res2)).toBe("host_not_public");

    expect(pipedream.seen).toHaveLength(0);
    expect(outside.obtained()).toBe(0);
    expect(priv.obtained()).toBe(0);
  });

  it("the explicit host form relays against the named host of the set, so one connection reaches both Google hosts", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request(
      "/c/conn_gmail/h/www.googleapis.com/upload/gmail/v1/users/me/drafts",
      {
        headers: bearer(GOOD),
      },
    );
    const { saw } = await answered(res);
    expect(saw.vendorUrl).toBe("https://www.googleapis.com/upload/gmail/v1/users/me/drafts");
    expect(h.events[0]?.host).toBe("www.googleapis.com");
  });

  it("returns a redirect unfollowed, and under the break glass follows one inside the vendor's host set as a second relayed hop", async () => {
    const plain = harness(gmailConnection());
    const back = await plain.app.request("/c/conn_gmail/redirect-outside", {
      headers: bearer(GOOD),
    });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("https://evil.example/collect");
    expect(plain.events[0]).toMatchObject({ outcome: "redirect_returned", redirectHops: 0 });

    pipedream.seen.length = 0;
    const glass = harness(gmailConnection(), { followRedirects: true });
    const inside = await glass.app.request("/c/conn_gmail/redirect-inside", {
      headers: bearer(GOOD),
    });
    expect(inside.status).toBe(200);
    expect(pipedream.seen.map((s) => s.vendorUrl)).toEqual([
      "https://gmail.googleapis.com/gmail/v1/redirect-inside",
      "https://www.googleapis.com/upload/v1/moved",
    ]);
    expect(pipedream.seen.every((s) => s.headers.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(
      true,
    );
    expect(glass.events[0]).toMatchObject({ outcome: "forwarded", redirectHops: 1 });

    pipedream.seen.length = 0;
    const outside = await glass.app.request("/c/conn_gmail/redirect-outside", {
      headers: bearer(GOOD),
    });
    expect(outside.status).toBe(302);
    expect(pipedream.seen).toHaveLength(1);
  });

  it("a Connect API that refuses Graft's credentials — the fields cannot be assembled — is the proxy's 502 relay_unavailable, never a vendor's answer", async () => {
    class PipedreamError extends Error {
      constructor() {
        super("Pipedream rejected the client credentials (401): client_id pd_client_secret_detail");
        this.name = "PipedreamError";
      }
    }
    const h = harness(
      gmailConnection({}, async () => {
        throw new PipedreamError();
      }),
    );
    const res = await h.app.request("/c/conn_gmail/users/me/messages", { headers: bearer(GOOD) });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "bad_gateway", reason: "relay_unavailable" });
    expect(pipedream.seen).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      outcome: "relay_unavailable",
      relay: "pipedream_connect_proxy",
    });
    expect(h.events[0]?.failure).toContain("relay.obtain");
    expect(h.events[0]?.failure).not.toContain("pd_client_secret_detail");
  });

  it("a Pipedream refusal of the relayed request — its 401 for a stale access token — passes through as the upstream's answer, with Graft's token redacted", async () => {
    const h = harness(
      gmailConnection({}, async () => ({
        ...FIELDS,
        accessToken: "stale-token",
        apiOrigin: pipedream.url,
      })),
    );
    const res = await h.app.request("/c/conn_gmail/users/me/messages", { headers: bearer(GOOD) });

    // Pipedream documents no marker that separates its own 4xx from the vendor's passed through
    // it, so the proxy answers what it received and the event names the relay and the status.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(h.events[0]).toMatchObject({
      outcome: "forwarded",
      upstreamStatus: 401,
      relay: "pipedream_connect_proxy",
    });
  });

  it("drops every x-graft-* header Pipedream answers with, as the vendor leg does", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request("/c/conn_gmail/spoof", { headers: bearer(GOOD) });
    expect(res.status).toBe(200);
    expect([...res.headers.keys()].filter((name) => name.startsWith("x-graft-"))).toEqual([]);
    expect(res.headers.get("x-pd-request-id")).toBe("pd_spoof");
    expect(await res.json()).toEqual({ relayed: true });
    expect(h.events[0]).toMatchObject({ outcome: "forwarded", relay: "pipedream_connect_proxy" });
  });

  it("redacts Graft's Connect token when Pipedream echoes it, as a vendor's echoed key is", async () => {
    const h = harness(gmailConnection());
    const res = await h.app.request("/c/conn_gmail/echo", { headers: bearer(GOOD) });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain(CREDENTIAL_REDACTED);
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(h.events[0]).toMatchObject({ credentialEchoed: true });
  });

  it("refuses a relay whose fields lack the account id as the connection's fault, 409 credential_incomplete", async () => {
    const { accountId: _dropped, ...rest } = FIELDS;
    const h = harness(gmailConnection({}, async () => ({ ...rest, apiOrigin: pipedream.url })));
    const res = await h.app.request("/c/conn_gmail/users/me/messages", { headers: bearer(GOOD) });
    expect(res.status).toBe(409);
    expect(await reason(res)).toBe("credential_incomplete");
    expect(pipedream.seen).toHaveLength(0);
  });
});
