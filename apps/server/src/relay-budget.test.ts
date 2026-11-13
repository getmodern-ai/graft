import type { RelayBudgetDeps } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { createMcpDeps } from "@graft/mcp";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import type { Capture } from "@graft/observability";
import {
  type CapabilityClaims,
  createProxyApp,
  type ProxyConnection,
  type ProxyEvent,
  type RelayPlugin,
} from "@graft/proxy";
import { describe, expect, it } from "vitest";

import {
  createRelayBudget,
  createRelayBudgetExhaustedCapture,
  createRelayBudgetPeek,
  relayBudgetClause,
  relayBudgetLimitsFrom,
} from "./relay-budget";
import { runAgentTool } from "./tool-run";

/**
 * The relay budget as the server binds it (GRA-349): the environment's two ceilings, the boot
 * line's clause, and the incident (GRA-348) replayed through the real proxy, with the real
 * `@graft/core` service counting over an in-memory stand-in for `relay_call_count`.
 */

const HOUR_MS = 60 * 60 * 1000;
const db = {} as DbOrTx;

describe("the ceilings and the boot line", () => {
  it("reads both ceilings, each optional", () => {
    expect(relayBudgetLimitsFrom({})).toEqual({ agentHourly: null, personDaily: null });
    expect(
      relayBudgetLimitsFrom({
        GRAFT_RELAY_BUDGET_AGENT_HOURLY: 250,
        GRAFT_RELAY_BUDGET_PERSON_DAILY: 1000,
      }),
    ).toEqual({ agentHourly: 250, personDaily: 1000 });
  });

  it("names what is set, and says off when nothing is", () => {
    expect(relayBudgetClause({ agentHourly: null, personDaily: null })).toBe(", relay budget off");
    expect(relayBudgetClause({ agentHourly: 250, personDaily: 1000 })).toBe(
      ", relay budget 250/agent-hour 1000/person-day",
    );
    expect(relayBudgetClause({ agentHourly: null, personDaily: 1000 })).toBe(
      ", relay budget 1000/person-day",
    );
  });

  it("binds no hook at all when no ceiling is set, so the proxy asks nothing", () => {
    expect(createRelayBudget(db, { agentHourly: null, personDaily: null })).toBeUndefined();
  });
});

/** `relay_call_count` as a map, keyed as the table is, on a clock the test turns. */
function memoryCount(start: number) {
  const rows = new Map<
    string,
    { agentId: string; personId: string; hourStart: Date; calls: number }
  >();
  let clock = start;
  const deps: RelayBudgetDeps = {
    listRelayCallBuckets: async (_db, personId, since) =>
      [...rows.values()].filter((row) => row.personId === personId && row.hourStart >= since),
    recordRelayCall: async (_db, scope, hourStart) => {
      const key = `${scope.agentId}|${hourStart.getTime()}`;
      const row = rows.get(key);
      if (row) row.calls += 1;
      else rows.set(key, { ...scope, hourStart, calls: 1 });
    },
    deleteRelayCallCountsBefore: async () => 0,
    now: () => new Date(clock),
  };
  return {
    deps,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const relay: RelayPlugin = {
  kind: "relay",
  scheme: "test_relay",
  rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
  relay(target) {
    target.url.href = `https://relay.example/proxy?to=${encodeURIComponent(target.url.href)}`;
  },
  headerNames: () => [],
};

/**
 * The incident's shape: one agent alternating `read-xlsx-sheet-page` (re-exporting one file) and
 * `read-drive-files`, one relayed call every 7.5 s, here for two hours of the four days. The upstream
 * counts what reached it. Under 250 an agent-hour, 250 reach it in each hour, the rest are refused
 * 429 `relay_budget_exhausted` with the sentence and a `Retry-After` that points at the next hour.
 */
describe("the incident's loop, through the proxy", () => {
  it("lets 250 through in each hour and refuses the rest with a sentence the agent can act on", async () => {
    const start = Date.parse("2026-10-12T00:00:00Z");
    const count = memoryCount(start);
    const claims = (tool: string): CapabilityClaims => ({
      person: "person_1",
      agent: "agent_1",
      connections: ["conn_drive"],
      tool,
      jti: "jti",
      exp: Math.floor(Date.now() / 1000) + 300,
      dryRun: false,
      readOnly: true,
    });
    const connection: ProxyConnection = {
      id: "conn_drive",
      personId: "person_1",
      authScheme: null,
      primaryHost: "https://www.googleapis.example/drive/v3",
      hosts: ["www.googleapis.example"],
      schemeConfig: null,
      credentialCiphertext: null,
      relay: { plugin: relay, obtain: async () => ({}) },
    };
    let reached = 0;
    const events: ProxyEvent[] = [];
    const budget = createRelayBudget(db, { agentHourly: 250, personDaily: 1000 }, count.deps);
    const app = createProxyApp({
      verifyToken: async (token) => ({ ok: true, claims: claims(token) }),
      jwks: async () => ({ keys: [] }),
      connections: { get: async (id) => (id === connection.id ? connection : null) },
      decryptCredential: async () => ({}),
      ...(budget ? { relayBudget: budget } : {}),
      upstreamFetch: async () => {
        reached += 1;
        return {
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          body: new Response("{}").body,
        };
      },
      now: count.now,
      log: (event) => events.push(event),
    });

    const STEP_MS = 7_500;
    const steps = (2 * HOUR_MS) / STEP_MS;
    const reachedByHour = [0, 0];
    let firstRefusal: Response | null = null;
    for (let i = 0; i < steps; i += 1) {
      const [tool, path] =
        i % 2 === 0
          ? [
              "google-drive__read-xlsx-sheet-page",
              "/c/conn_drive/files/1jkBpv2/export?mimeType=csv",
            ]
          : ["google-drive__read-drive-files", "/c/conn_drive/files?q=trashed%3Dfalse"];
      const before = reached;
      const response = await app.request(path, { headers: { authorization: `Bearer ${tool}` } });
      const hour = Math.floor((count.now() - start) / HOUR_MS);
      reachedByHour[hour] = (reachedByHour[hour] ?? 0) + (reached - before);
      if (response.status === 429 && !firstRefusal) firstRefusal = response;
      count.advance(STEP_MS);
    }

    expect(steps).toBe(960);
    expect(reachedByHour).toEqual([250, 250]);
    // The 251st call of the first hour, 31 minutes 15 seconds in.
    expect(firstRefusal).not.toBeNull();
    expect(firstRefusal?.headers.get("retry-after")).toBe(
      String(Math.ceil(HOUR_MS / 1000 - 250 * 7.5)),
    );
    const body = (await firstRefusal?.json()) as { reason: string; message: string };
    expect(body.reason).toBe("relay_budget_exhausted");
    expect(body.message).toMatch(/^This agent has made 250 relayed calls this hour/);
    expect(events.filter((event) => event.outcome === "relay_budget_exhausted")).toHaveLength(460);

    // The analytics event (GRA-350): 460 refusals over two hours are two events, one per window.
    const captured: Capture[] = [];
    const capture = createRelayBudgetExhaustedCapture((input) => captured.push(input), {
      now: count.now,
    });
    for (const event of events) capture(event);
    expect(captured.map((input) => input.properties?.resets_at)).toEqual([
      "2026-10-12T01:00:00.000Z",
      "2026-10-12T02:00:00.000Z",
    ]);
    expect(captured[0]).toEqual({
      distinctId: "person_1",
      event: "relay_budget_exhausted",
      properties: {
        ceiling: "agent_hour",
        limit: 250,
        used: 250,
        resets_at: "2026-10-12T01:00:00.000Z",
        tool: "google-drive__read-xlsx-sheet-page",
        agent_id: "agent_1",
        relay: "test_relay",
        dry_run: false,
      },
    });
  });
});

/** A proxy event with the relay budget's word on it, the rest as a refused relayed call has it. */
function proxyEvent(overrides: Partial<ProxyEvent> = {}): ProxyEvent {
  return {
    outcome: "relay_budget_exhausted",
    status: 429,
    upstreamStatus: null,
    method: "GET",
    path: "/files",
    hasQuery: false,
    connectionId: "conn_drive",
    personId: "person_1",
    agentId: "agent_1",
    tool: "google-drive__read-drive-files",
    host: "www.googleapis.example",
    latencyMs: 1,
    requestBytes: 0,
    responseBytes: null,
    redirectHops: 0,
    dryRun: false,
    dryRunOutcome: null,
    oauth: null,
    relay: "relay",
    credentialEchoed: false,
    failure: null,
    budget: {
      outcome: "exhausted",
      ceiling: "agent_hour",
      limit: 250,
      used: 250,
      resetsAt: "2026-10-12T14:00:00.000Z",
    },
    ...overrides,
  };
}

describe("relay_budget_exhausted, counted (GRA-350)", () => {
  const NOW = Date.parse("2026-10-12T13:20:00Z");

  it("is one event per agent, ceiling and window however many calls are refused in it", () => {
    const captured: Capture[] = [];
    const capture = createRelayBudgetExhaustedCapture((input) => captured.push(input), {
      now: () => NOW,
    });
    for (let i = 0; i < 1_000; i += 1) capture(proxyEvent());
    expect(captured).toHaveLength(1);
    // Another agent of the person's, and the person's own ceiling for the first: one more each.
    capture(proxyEvent({ agentId: "agent_2" }));
    const personDay = {
      outcome: "exhausted" as const,
      ceiling: "person_day" as const,
      limit: 1000,
      used: 1000,
      resetsAt: "2026-10-13T09:00:00.000Z",
    };
    capture(proxyEvent({ budget: personDay }));
    capture(proxyEvent({ budget: personDay }));
    expect(
      captured.map((input) => [input.properties?.agent_id, input.properties?.ceiling]),
    ).toEqual([
      ["agent_1", "agent_hour"],
      ["agent_2", "agent_hour"],
      ["agent_1", "person_day"],
    ]);
  });

  it("is a new event in a new window", () => {
    const captured: Capture[] = [];
    let now = NOW;
    const capture = createRelayBudgetExhaustedCapture((input) => captured.push(input), {
      now: () => now,
    });
    capture(proxyEvent());
    now += HOUR_MS;
    const next = proxyEvent({
      budget: {
        outcome: "exhausted",
        ceiling: "agent_hour",
        limit: 250,
        used: 250,
        resetsAt: "2026-10-12T15:00:00.000Z",
      },
    });
    capture(next);
    capture(next);
    expect(captured.map((input) => input.properties?.resets_at)).toEqual([
      "2026-10-12T14:00:00.000Z",
      "2026-10-12T15:00:00.000Z",
    ]);
  });

  it("counts nothing for a call the budget did not refuse, or one with no agent on it", () => {
    const captured: Capture[] = [];
    const capture = createRelayBudgetExhaustedCapture((input) => captured.push(input));
    capture(proxyEvent({ outcome: "forwarded", status: 200, budget: null }));
    capture(proxyEvent({ budget: { outcome: "unavailable", failure: "Error" } }));
    capture(proxyEvent({ agentId: null }));
    expect(captured).toEqual([]);
  });

  it("holds a bounded number of keys, forgetting the oldest first", () => {
    const captured: Capture[] = [];
    const capture = createRelayBudgetExhaustedCapture((input) => captured.push(input), {
      maxKeys: 2,
      now: () => NOW,
    });
    for (const agentId of ["a", "b", "c", "a"]) capture(proxyEvent({ agentId }));
    // `a` was forgotten when `c` landed, so its next refusal counts again: a duplicate, never a miss.
    expect(captured.map((input) => input.properties?.agent_id)).toEqual(["a", "b", "c", "a"]);
  });
});

describe("the run's door reads the same count (GRA-350)", () => {
  it("binds no peek when no ceiling is set", () => {
    expect(createRelayBudgetPeek(db, { agentHourly: null, personDaily: null })).toBeUndefined();
  });

  it("judges as the proxy's charge does, and counts nothing", async () => {
    const count = memoryCount(Date.parse("2026-10-12T13:00:00Z"));
    const limits = { agentHourly: 1, personDaily: null };
    const peek = createRelayBudgetPeek(db, limits, count.deps);
    const charge = createRelayBudget(db, limits, count.deps);
    const scope = { personId: "person_1", agentId: "agent_1" };
    expect(await peek?.peek(scope)).toEqual({ allowed: true });
    expect(await peek?.peek(scope)).toEqual({ allowed: true });
    await charge?.charge({ ...scope, connectionId: "conn", relay: "relay", dryRun: false });
    expect(await peek?.peek(scope)).toMatchObject({ allowed: false, ceiling: "agent_hour" });
  });

  /**
   * The console's run (`tool-run.ts`) is `runAuthoredTool`, so it meets the same door: a relayed
   * connection past a ceiling is refused with the proxy's sentence before a sandbox is asked for
   * (there is none here, and no key pair, so anything past the door would refuse otherwise).
   */
  it("refuses the console's run of a relayed tool past a ceiling, with the proxy's sentence", async () => {
    const store = createFakeStore();
    store.addConnection({
      id: "conn_drive",
      personId: "person_1",
      vendor: "drive",
      scheme: "relay",
      schemeConfig: {},
      primaryHost: "https://www.googleapis.example/drive/v3",
    });
    store.addAgent({
      scopeMode: "listed",
      id: "agent_1",
      personId: "person_1",
      token: "grft_token_relay_budget_console_000000000000",
      connectionIds: ["conn_drive"],
    });
    store.addTool({
      id: "tool_drive",
      personId: "person_1",
      vendor: "drive",
      name: "read-drive-files",
      description: "List files.",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: "conn_drive",
      path: "tools/drive/read-drive-files/v1",
    });
    store.promote("agent_1", "tool_drive");
    const fake = createFakeDeps(store);
    const resetsAt = new Date("2026-10-12T14:00:00Z");
    const mcp = createMcpDeps({
      ...fake,
      sandbox: null,
      keys: null,
      proxyPublicUrl: "http://proxy.invalid",
      handoff: {
        consoleUrl: "http://console.invalid",
        secret: "x".repeat(32),
        waitMs: 0,
        ttlMs: 1,
      },
      relayBudget: {
        peek: async () => ({
          allowed: false,
          ceiling: "agent_hour",
          limit: 250,
          used: 250,
          resetsAt,
        }),
      },
    });
    try {
      const answer = await runAgentTool(
        { db: fake.db },
        { personId: "person_1" },
        { agentId: "agent_1", vendor: "drive", name: "read-drive-files" },
        {},
        { agent: fake.agent, tool: fake.tool, workingSet: fake.workingSet, mcp },
      );
      expect(answer).toEqual({
        ok: false,
        reason: "relay_budget_exhausted",
        message:
          "This agent has made 250 relayed calls this hour, its limit of 250 an hour; relayed calls resume at 2026-10-12 14:00 UTC. An agent that reaches this limit is usually calling the same tool in a loop: stop, and tell the person what you were doing.",
        answer: expect.objectContaining({ error: "refused", reason: "relay_budget_exhausted" }),
      });
      expect(store.usage).toEqual([
        expect.objectContaining({ outcome: "refused", reason: "relay_budget_exhausted" }),
      ]);
    } finally {
      mcp.inFlight?.close();
      mcp.notifier?.close();
    }
  });
});
