import { describe, expect, it } from "vitest";

import { createProxyApp } from "./app";
import { DRY_RUN_HEADER } from "./dry-run";
import { relayBudgetMessage, retryAfterSeconds } from "./relay-budget";
import { MissingCredentialFieldError } from "./scheme-errors";
import type {
  CapabilityClaims,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  RelayBudgetCall,
  RelayBudgetVerdict,
  RelayPlugin,
  TokenVerdict,
  UpstreamRequest,
} from "./types";

/**
 * The relay budget's rung (GRA-349): what the proxy asks, when, and what a refusal looks like on
 * the wire and on the event. The budget itself — the store, the ceilings, the rolling day — is the
 * host's (`@graft/core`'s `relay-budget`, bound in `apps/server/src/relay-budget.ts`), so here it
 * is a function the test scripts. The upstream is an injected fetch that answers 200 and records
 * what it was sent: whether a call left is the assertion, not what the vendor said.
 */

const PERSON = "person_1";
const AGENT = "agent_1";
const NOW = Date.parse("2026-10-12T13:20:00Z");

const relay: RelayPlugin = {
  kind: "relay",
  scheme: "test_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay(target, fields) {
    if (!fields.upstream) throw new MissingCredentialFieldError("upstream");
    target.url.href = `${fields.upstream}/relay?to=${encodeURIComponent(target.url.href)}`;
  },
  headerNames: () => [],
};

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    person: PERSON,
    agent: AGENT,
    connections: ["conn_r", "conn_k"],
    tool: "google-drive__read-xlsx-sheet-page",
    jti: "jti_1",
    exp: Math.floor(Date.now() / 1000) + 300,
    dryRun: false,
    readOnly: false,
    ...overrides,
  };
}

function harness(
  charge: (call: RelayBudgetCall) => Promise<RelayBudgetVerdict>,
  opts: { obtainFails?: boolean; followRedirects?: boolean } = {},
) {
  const events: ProxyEvent[] = [];
  const sent: UpstreamRequest[] = [];
  const charged: RelayBudgetCall[] = [];
  let obtained = 0;
  const relayed: ProxyConnection = {
    id: "conn_r",
    personId: PERSON,
    authScheme: null,
    primaryHost: "https://www.vendor.example/drive/v3",
    hosts: ["www.vendor.example"],
    schemeConfig: null,
    credentialCiphertext: null,
    relay: {
      plugin: relay,
      obtain: async () => {
        obtained += 1;
        if (opts.obtainFails) throw new Error("the provider is down");
        return { upstream: "https://relay.example" };
      },
    },
  };
  const keyed: ProxyConnection = {
    id: "conn_k",
    personId: PERSON,
    authScheme: "bearer",
    primaryHost: "https://api.vendor.example",
    hosts: ["api.vendor.example"],
    schemeConfig: {},
    credentialCiphertext: new Uint8Array([1]),
  };
  const tokens = new Map<string, TokenVerdict>([
    ["good", { ok: true, claims: claims() }],
    ["dry", { ok: true, claims: claims({ dryRun: true }) }],
  ]);
  const deps: ProxyDeps = {
    verifyToken: async (token) => tokens.get(token) ?? { ok: false, reason: "invalid" },
    jwks: async () => ({ keys: [] }),
    connections: {
      get: async (id) => (id === relayed.id ? relayed : id === keyed.id ? keyed : null),
    },
    decryptCredential: async () => ({ token: "vendor-key" }),
    relayBudget: {
      charge: async (call) => {
        charged.push(call);
        return charge(call);
      },
    },
    upstreamFetch: async (request) => {
      sent.push(request);
      // `/moved` answers a redirect inside the host set, once; everything else answers 200.
      if (decodeURIComponent(request.url).includes("/moved")) {
        return {
          status: 302,
          statusText: "Found",
          headers: new Headers({ location: "https://www.vendor.example/drive/v3/files/new" }),
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
    now: () => NOW,
    options: { followRedirects: opts.followRedirects ?? false },
    log: (event) => events.push(event),
  };
  const call = (path: string, token = "good", init: RequestInit = {}) =>
    createProxyApp(deps).request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  return { call, events, sent, charged, obtained: () => obtained };
}

const allowed = async (): Promise<RelayBudgetVerdict> => ({ allowed: true });
const exhausted = async (): Promise<RelayBudgetVerdict> => ({
  allowed: false,
  ceiling: "agent_hour",
  limit: 250,
  used: 250,
  resetsAt: new Date("2026-10-12T14:00:00Z"),
});

describe("the relay budget's rung", () => {
  it("counts a relayed call with the token's person and agent, then sends it", async () => {
    const h = harness(allowed);
    const response = await h.call("/c/conn_r/files/abc/export");
    expect(response.status).toBe(200);
    expect(h.charged).toEqual([
      {
        personId: PERSON,
        agentId: AGENT,
        connectionId: "conn_r",
        relay: "test_relay",
        dryRun: false,
      },
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.events[0]?.budget).toBeNull();
  });

  it("refuses past a ceiling with a 429 and Retry-After, before anything reaches the upstream", async () => {
    const h = harness(exhausted);
    const response = await h.call("/c/conn_r/files/abc/export");
    expect(response.status).toBe(429);
    // 13:20 to 14:00 is forty minutes.
    expect(response.headers.get("retry-after")).toBe("2400");
    expect(response.headers.get("x-graft-refused")).toBe("relay_budget_exhausted");
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("too_many_requests");
    expect(body.reason).toBe("relay_budget_exhausted");
    expect(body.message).toContain("250 relayed calls this hour");
    expect(h.sent).toHaveLength(0);
    expect(h.events[0]).toMatchObject({
      outcome: "relay_budget_exhausted",
      status: 429,
      relay: "test_relay",
      budget: {
        outcome: "exhausted",
        ceiling: "agent_hour",
        limit: 250,
        used: 250,
        resetsAt: "2026-10-12T14:00:00.000Z",
      },
    });
  });

  /** Greptile on #297: a provider outage must not spend the allowance on calls that never left. */
  it("does not count a call whose relay fields could not be assembled", async () => {
    const h = harness(allowed, { obtainFails: true });
    const response = await h.call("/c/conn_r/files/abc/export");
    expect(response.status).toBe(502);
    expect(h.obtained()).toBe(1);
    expect(h.charged).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  /** Greptile on #297: a followed redirect is another request the upstream bills. */
  it("counts every hop a followed redirect sends through the relay", async () => {
    const h = harness(allowed, { followRedirects: true });
    const response = await h.call("/c/conn_r/files/moved");
    expect(response.status).toBe(200);
    expect(h.sent).toHaveLength(2);
    expect(h.charged).toHaveLength(2);
  });

  it("stops following a redirect when the budget refuses the next hop", async () => {
    let calls = 0;
    const h = harness(
      async () => {
        calls += 1;
        return calls === 1 ? { allowed: true } : exhausted();
      },
      { followRedirects: true },
    );
    const response = await h.call("/c/conn_r/files/moved");
    expect(response.status).toBe(429);
    expect(h.sent).toHaveLength(1);
  });

  it("never asks about a call the proxy signs itself", async () => {
    const h = harness(exhausted);
    const response = await h.call("/c/conn_k/v1/things");
    expect(response.status).toBe(200);
    expect(h.charged).toHaveLength(0);
    expect(h.events[0]?.budget).toBeNull();
  });

  it("lets the call through when the counter throws, and says so on the event", async () => {
    const h = harness(async () => {
      throw new Error("connection terminated: secret-looking detail");
    });
    const response = await h.call("/c/conn_r/files/abc/export");
    expect(response.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    const budget = h.events[0]?.budget;
    expect(budget?.outcome).toBe("unavailable");
    // Class names only: a host's message never reaches the event (`failure.ts`).
    expect(JSON.stringify(budget)).not.toContain("secret-looking");
  });

  it("does not count a dry-run write it intercepts, and counts a dry-run read that leaves", async () => {
    const h = harness(allowed);
    const write = await h.call("/c/conn_r/files", "dry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(write.headers.get(DRY_RUN_HEADER)).toBe("intercepted");
    expect(h.charged).toHaveLength(0);

    const read = await h.call("/c/conn_r/files/abc/export", "dry");
    expect(read.status).toBe(200);
    expect(h.charged).toEqual([expect.objectContaining({ dryRun: true })]);
  });
});

describe("the refusal's sentence", () => {
  it("names the agent's hourly ceiling, when it resets, and the likely loop", () => {
    expect(
      relayBudgetMessage({
        ceiling: "agent_hour",
        limit: 250,
        used: 250,
        resetsAt: new Date("2026-10-12T14:00:00Z"),
      }),
    ).toBe(
      "This agent has made 250 relayed calls this hour, its limit of 250 an hour; relayed calls resume at 2026-10-12 14:00 UTC. An agent that reaches this limit is usually calling the same tool in a loop: stop, and tell the person what you were doing.",
    );
  });

  it("names the person's daily ceiling", () => {
    expect(
      relayBudgetMessage({
        ceiling: "person_day",
        limit: 1000,
        used: 1000,
        resetsAt: new Date("2026-10-13T09:00:00Z"),
      }),
    ).toBe(
      "This person's agents have made 1,000 relayed calls in the last 24 hours, the limit of 1,000 a day; relayed calls resume from 2026-10-13 09:00 UTC. An agent that reaches this limit is usually calling the same tool in a loop: stop, and tell the person what you were doing.",
    );
  });

  it("never answers a Retry-After under one second", () => {
    expect(retryAfterSeconds(new Date(NOW - 5000), NOW)).toBe(1);
    expect(retryAfterSeconds(new Date(NOW + 1500), NOW)).toBe(2);
  });
});
