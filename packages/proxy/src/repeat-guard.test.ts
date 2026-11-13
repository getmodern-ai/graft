import { describe, expect, it } from "vitest";

import { createProxyApp } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import {
  createRepeatGuard,
  type RepeatRequest,
  repeatedRequestMessage,
  repeatKey,
} from "./repeat-guard";
import type {
  CapabilityClaims,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  RelayBudgetCall,
  RelayBudgetVerdict,
  RelayPlugin,
  UpstreamRequest,
} from "./types";

/**
 * Repeat detection (GRA-351): the window and the key as pure functions, then the rung through the
 * real proxy app. The relay budget is a function the test scripts and records, since whether a
 * refused repeat was charged is half the assertion; the upstream answers 200 and records what
 * reached it.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const START = Date.parse("2026-10-12T13:00:00Z");
const HOSTED = { limit: 30, windowSeconds: 900 };

describe("the key", () => {
  const base: RepeatRequest = {
    agentId: AGENT,
    tool: "google-drive__read-xlsx-sheet-page",
    method: "GET",
    url: "https://www.googleapis.example/drive/v3/files/1jkB/export?mimeType=text%2Fcsv",
    body: null,
  };

  it("is the same digest for the same request, and holds nothing of the URL", () => {
    const key = repeatKey(base);
    expect(repeatKey({ ...base })).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("1jkB");
  });

  it("differs on the agent, the tool, the method, the query and the body", () => {
    const key = repeatKey(base);
    const variants: RepeatRequest[] = [
      { ...base, agentId: "agent_2" },
      { ...base, tool: "google-drive__read-drive-files" },
      { ...base, method: "POST" },
      { ...base, url: base.url.replace("csv", "tsv") },
      { ...base, url: base.url.replace("?mimeType=text%2Fcsv", "") },
      { ...base, body: new TextEncoder().encode('{"page":2}') },
    ];
    const keys = new Set(variants.map(repeatKey));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(key)).toBe(false);
  });

  it("reads no body and an empty body as one request, and the method in any case", () => {
    expect(repeatKey({ ...base, body: new Uint8Array() })).toBe(repeatKey(base));
    expect(repeatKey({ ...base, method: "get" })).toBe(repeatKey(base));
  });

  it("cannot be spelled across a field boundary", () => {
    expect(repeatKey({ ...base, agentId: "a", tool: "b|c" })).not.toBe(
      repeatKey({ ...base, agentId: "a|b", tool: "c" }),
    );
  });
});

describe("the window", () => {
  it("admits the limit, refuses the next, and says when room comes back", () => {
    const guard = createRepeatGuard({ limit: 3, windowSeconds: 60 });
    expect(guard.admit("k", START)).toEqual({ allowed: true });
    expect(guard.admit("k", START + 10_000)).toEqual({ allowed: true });
    expect(guard.admit("k", START + 20_000)).toEqual({ allowed: true });
    // The first entry leaves the window at START + 60 s, forty seconds from now.
    expect(guard.admit("k", START + 20_000)).toEqual({
      allowed: false,
      count: 3,
      retryAfterSeconds: 40,
    });
    expect(guard.admit("other", START + 20_000)).toEqual({ allowed: true });
  });

  it("does not record a refusal, so a loop that keeps asking gets in once the oldest ages out", () => {
    const guard = createRepeatGuard({ limit: 2, windowSeconds: 60 });
    guard.admit("k", START);
    guard.admit("k", START + 1_000);
    for (let t = START + 2_000; t < START + 60_000; t += 1_000) {
      expect(guard.admit("k", t).allowed).toBe(false);
    }
    // Exactly as `Retry-After` promised at the first refusal: 58 s after START + 2 s.
    expect(guard.admit("k", START + 60_000)).toEqual({ allowed: true });
    expect(guard.admit("k", START + 60_500)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("never answers a Retry-After under one second", () => {
    const guard = createRepeatGuard({ limit: 1, windowSeconds: 1 });
    guard.admit("k", START);
    expect(guard.admit("k", START + 999)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
  });

  it("takes back a released admission", () => {
    const guard = createRepeatGuard({ limit: 1, windowSeconds: 60 });
    guard.admit("k", START);
    guard.release("k", START);
    expect(guard.size()).toBe(0);
    expect(guard.admit("k", START + 1)).toEqual({ allowed: true });
    // Releasing what was never admitted changes nothing.
    guard.release("k", START + 999);
    guard.release("never", START);
    expect(guard.admit("k", START + 2).allowed).toBe(false);
  });

  it("prunes keys whose window has passed as calls arrive", () => {
    const guard = createRepeatGuard({ limit: 5, windowSeconds: 60 });
    for (let i = 0; i < 100; i += 1) guard.admit(`k${i}`, START + i);
    expect(guard.size()).toBe(100);
    guard.admit("late", START + 60_050);
    // Every key admitted at or before START + 50 ms has left the window; 49 are still in it.
    expect(guard.size()).toBe(50);
    guard.admit("later", START + 200_000);
    expect(guard.size()).toBe(1);
  });

  it("caps the keys it holds, evicting the least recently admitted", () => {
    const guard = createRepeatGuard({ limit: 1, windowSeconds: 900 }, 3);
    guard.admit("a", START);
    guard.admit("b", START + 1);
    guard.admit("c", START + 2);
    // `a` is refused, which does not move it up: it is still the oldest admission.
    expect(guard.admit("a", START + 3).allowed).toBe(false);
    guard.admit("d", START + 4);
    expect(guard.size()).toBe(3);
    // `a` was evicted and so forgotten; `b` was not.
    expect(guard.admit("b", START + 5).allowed).toBe(false);
    expect(guard.admit("a", START + 6)).toEqual({ allowed: true });
    expect(guard.size()).toBe(3);
  });
});

describe("the refusal's sentence", () => {
  it("names the count, the window, when it lifts and the likely loop", () => {
    expect(
      repeatedRequestMessage({ count: 30, limit: 30, windowSeconds: 900, retryAfterSeconds: 15 }),
    ).toBe(
      "This agent has made this same relayed request 30 times in the last 15 minutes, the limit of 30; it may be sent again in 15 seconds. An agent that sends one request this often is usually looping: stop, and tell the person what you were doing.",
    );
    expect(
      repeatedRequestMessage({ count: 5, limit: 5, windowSeconds: 90, retryAfterSeconds: 61 }),
    ).toContain(
      "5 times in the last 90 seconds, the limit of 5; it may be sent again in about 2 minutes",
    );
  });
});

const relay: RelayPlugin = {
  kind: "relay",
  scheme: "test_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay(target) {
    target.url.href = `https://relay.example/proxy?to=${encodeURIComponent(target.url.href)}`;
  },
  headerNames: () => [],
};

function claims(tool: string, overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_drive", "conn_keyed"],
    tool,
    jti: "jti",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    readOnly: false,
    ...overrides,
  };
}

/**
 * A token is `<tool>` for an ordinary run or `dry:<tool>` for a dry run, so the loop below can
 * alternate tools without minting anything; a `#<run>` suffix makes another run's token.
 */
function harness(options: Partial<ProxyOptions>) {
  let clock = START;
  const events: ProxyEvent[] = [];
  const sent: UpstreamRequest[] = [];
  const charged: RelayBudgetCall[] = [];
  let verdict: RelayBudgetVerdict | ((n: number) => RelayBudgetVerdict) = { allowed: true };
  let obtained = 0;
  const relayed: ProxyConnection = {
    id: "conn_drive",
    personId: PERSON,
    authScheme: null,
    primaryHost: "https://www.googleapis.example/drive/v3",
    hosts: ["www.googleapis.example"],
    schemeConfig: null,
    credentialCiphertext: null,
    relay: {
      plugin: relay,
      obtain: async () => {
        obtained += 1;
        return {};
      },
    },
  };
  const keyed: ProxyConnection = {
    id: "conn_keyed",
    personId: PERSON,
    authScheme: "bearer",
    primaryHost: "https://api.vendor.example",
    hosts: ["api.vendor.example"],
    schemeConfig: {},
    credentialCiphertext: new Uint8Array([1]),
  };
  const deps: ProxyDeps = {
    verifyToken: async (raw) => {
      const token = raw.split("#")[0] ?? raw;
      return token.startsWith("dry:")
        ? { ok: true, claims: claims(token.slice(4), { dryRun: true }) }
        : { ok: true, claims: claims(token) };
    },
    jwks: async () => ({ keys: [] }),
    connections: {
      get: async (id) => (id === relayed.id ? relayed : id === keyed.id ? keyed : null),
    },
    decryptCredential: async () => ({ token: "vendor-key" }),
    relayBudget: {
      charge: async (call) => {
        charged.push(call);
        return typeof verdict === "function" ? verdict(charged.length) : verdict;
      },
    },
    upstreamFetch: async (request) => {
      sent.push(request);
      // `/moved` answers a redirect inside the host set; everything else answers 200.
      if (decodeURIComponent(request.url).includes("/moved")) {
        return {
          status: 302,
          statusText: "Found",
          headers: new Headers({ location: "https://www.googleapis.example/drive/v3/files/new" }),
          body: null,
        };
      }
      return {
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        body: new Response("{}").body,
      };
    },
    now: () => clock,
    log: (event) => events.push(event),
    options,
  };
  // One app for the whole test: the window lives in the app instance.
  const app = createProxyApp(deps);
  const call = (path: string, token: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  return {
    call,
    events,
    sent,
    charged,
    obtained: () => obtained,
    advance: (ms: number) => {
      clock += ms;
    },
    elapsed: () => clock - START,
    /** The budget's answer from now on, or a function of the running count of charges. */
    budget: (next: RelayBudgetVerdict | ((n: number) => RelayBudgetVerdict)) => {
      verdict = next;
    },
  };
}

const EXPORT = "/c/conn_drive/files/1jkBpv2/export?mimeType=text%2Fcsv";
const LIST = "/c/conn_drive/files?q=trashed%3Dfalse";
const XLSX = "google-drive__read-xlsx-sheet-page";
const FILES = "google-drive__read-drive-files";

describe("the rung, on the incident's cadence", () => {
  it("refuses the repeated export at its 31st call, 7.5 minutes in, and never charges it", async () => {
    const h = harness({ repeatLimit: HOSTED });
    let exports = 0;
    let refusal: { response: Response; at: number; exportNumber: number } | null = null;
    let chargedBefore = 0;
    // One call every 7.5 s, alternating the two tools, until the first refusal or 15 minutes.
    for (let i = 0; i < 120 && !refusal; i += 1) {
      const [tool, path] = i % 2 === 0 ? [XLSX, EXPORT] : [FILES, LIST];
      if (tool === XLSX) exports += 1;
      chargedBefore = h.charged.length;
      const response = await h.call(path, tool);
      if (response.status === 429) refusal = { response, at: h.elapsed(), exportNumber: exports };
      else expect(response.status).toBe(200);
      h.advance(7_500);
    }

    expect(refusal).not.toBeNull();
    expect(refusal?.exportNumber).toBe(31);
    // The 31st export is call 61, sent 60 × 7.5 s = 450 s after the first.
    expect(refusal?.at).toBe(450_000);
    // The budget was not asked about the refused call: the charges stopped at the call before it.
    expect(h.charged).toHaveLength(chargedBefore);
    expect(h.charged).toHaveLength(60);
    expect(h.sent).toHaveLength(60);
    // The refused call never reached `forward`: the relay's fields were never obtained for it.
    expect(h.obtained()).toBe(60);

    const response = refusal?.response as Response;
    // The first export leaves the window at 900 s; the refusal came at 450 s.
    expect(response.headers.get("retry-after")).toBe("450");
    expect(response.headers.get("x-graft-refused")).toBe("repeated_request");
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("too_many_requests");
    expect(body.reason).toBe("repeated_request");
    expect(body.message).toBe(
      "This agent has made this same relayed request 30 times in the last 15 minutes, the limit of 30; it may be sent again in about 8 minutes. An agent that sends one request this often is usually looping: stop, and tell the person what you were doing.",
    );

    const event = h.events.at(-1);
    expect(event).toMatchObject({
      outcome: "repeated_request",
      status: 429,
      relay: "test_relay",
      tool: XLSX,
      repeat: { count: 30, limit: 30, windowSeconds: 900 },
      budget: null,
    });
    // The event's path is the vendor path it always carried; never the query or the digest.
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("mimeType");
    expect(serialised).not.toMatch(/[0-9a-f]{64}/);
    // The listing alternating with it is its own request: thirty sent, so its 31st is refused too.
    const listing = await h.call(LIST, FILES);
    expect(listing.status).toBe(429);
  });

  it("lets every call of an honest fan-out through: 180 distinct reads in 30 seconds", async () => {
    const h = harness({ repeatLimit: HOSTED });
    for (let i = 0; i < 180; i += 1) {
      const response = await h.call(`/c/conn_drive/files/file_${i}?fields=id%2Cname`, FILES);
      expect(response.status).toBe(200);
      h.advance(30_000 / 180);
    }
    expect(h.sent).toHaveLength(180);
    expect(h.events.every((event) => event.repeat === null)).toBe(true);
  });
});

describe("what the rung counts", () => {
  it("counts a different query string as a different request", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    expect((await h.call("/c/conn_drive/files?pageToken=a", FILES)).status).toBe(200);
    expect((await h.call("/c/conn_drive/files?pageToken=b", FILES)).status).toBe(200);
    expect((await h.call("/c/conn_drive/files?pageToken=a", FILES)).status).toBe(429);
  });

  it("reads the URL after the token sweep, so a token a run put in the query is not part of it", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    const withToken = (token: string) =>
      h.call(`/c/conn_drive/files?key=${encodeURIComponent(token)}&page=1`, token);
    expect((await withToken(`${FILES}#run1`)).status).toBe(200);
    expect(h.sent[0]?.url).not.toContain("run1");
    // Another run's token, the same request otherwise: the same request.
    expect((await withToken(`${FILES}#run2`)).status).toBe(429);
  });

  it("counts a different body as a different request", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    const post = (body: string) =>
      h.call("/c/conn_drive/files/search", FILES, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await post('{"page":1}')).status).toBe(200);
    expect((await post('{"page":2}')).status).toBe(200);
    expect((await post('{"page":1}')).status).toBe(429);
  });

  it("never counts a call the proxy signs itself", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    for (let i = 0; i < 5; i += 1) {
      expect((await h.call("/c/conn_keyed/v1/things", FILES)).status).toBe(200);
    }
    expect(h.events.every((event) => event.repeat === null)).toBe(true);
  });

  it("does not count a dry-run write it intercepts", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    const write = (token: string) =>
      h.call("/c/conn_drive/files", token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"report"}',
      });
    for (let i = 0; i < 3; i += 1) {
      const intercepted = await write(`dry:${FILES}`);
      expect(intercepted.headers.get(DRY_RUN_HEADER)).toBe("intercepted");
    }
    expect(h.sent).toHaveLength(0);
    // The same write, sent for real, is the first of its kind in the window.
    expect((await write(FILES)).status).toBe(200);
    expect((await write(FILES)).status).toBe(429);
  });

  it("counts one caller request once, however many redirect hops the budget charges", async () => {
    const h = harness({ repeatLimit: { limit: 2, windowSeconds: 900 }, followRedirects: true });
    expect((await h.call("/c/conn_drive/files/moved", FILES)).status).toBe(200);
    expect((await h.call("/c/conn_drive/files/moved", FILES)).status).toBe(200);
    // Two requests, two hops each: four charges and four sends, and the repeat count is two.
    expect(h.charged).toHaveLength(4);
    expect(h.sent).toHaveLength(4);
    const refused = await h.call("/c/conn_drive/files/moved", FILES);
    expect(refused.status).toBe(429);
    expect(h.events.at(-1)?.repeat).toEqual({ count: 2, limit: 2, windowSeconds: 900 });
    expect(h.charged).toHaveLength(4);
  });

  it("keeps the count of a request whose redirect hop the budget refused, since its first hop left", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 }, followRedirects: true });
    h.budget((n) =>
      n === 2
        ? {
            allowed: false,
            ceiling: "agent_hour",
            limit: 250,
            used: 250,
            resetsAt: new Date(START + 3_600_000),
          }
        : { allowed: true },
    );
    expect((await h.call("/c/conn_drive/files/moved", FILES)).status).toBe(429);
    expect(h.sent).toHaveLength(1);
    const again = await h.call("/c/conn_drive/files/moved", FILES);
    expect((await again.json()) as Record<string, string>).toMatchObject({
      reason: "repeated_request",
    });
  });

  it("takes back a call the budget refused, so only calls that leave are counted", async () => {
    const h = harness({ repeatLimit: { limit: 1, windowSeconds: 900 } });
    h.budget({
      allowed: false,
      ceiling: "agent_hour",
      limit: 250,
      used: 250,
      resetsAt: new Date(START + 3_600_000),
    });
    const refused = await h.call(EXPORT, XLSX);
    expect(refused.status).toBe(429);
    expect((await refused.json()) as Record<string, string>).toMatchObject({
      reason: "relay_budget_exhausted",
    });
    h.budget({ allowed: true });
    expect((await h.call(EXPORT, XLSX)).status).toBe(200);
    expect((await h.call(EXPORT, XLSX)).status).toBe(429);
  });

  it("counts nothing where no limit is set, the default", async () => {
    const h = harness({});
    for (let i = 0; i < 100; i += 1) {
      expect((await h.call(EXPORT, XLSX)).status).toBe(200);
    }
    expect(h.events.every((event) => event.repeat === null)).toBe(true);
  });
});
