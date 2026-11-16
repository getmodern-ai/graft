import type { RelayBudgetDeps } from "@graft/core";
import type { DbOrTx } from "@graft/db";
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
  relayBudgetClause,
  relayBudgetLimitsFrom,
  relayRepeatClause,
} from "./relay-budget";

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

  it("names the repeat limit beside the budget, and says off when it is unset", () => {
    expect(relayRepeatClause(undefined)).toBe(", relay repeat limit off");
    expect(relayRepeatClause(null)).toBe(", relay repeat limit off");
    expect(relayRepeatClause({ limit: 30, windowSeconds: 900 })).toBe(
      ", relay repeat limit 30/900",
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
  });
});
