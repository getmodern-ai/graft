import { createGatewayProvider, keyringProvider } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_ASK_KIND,
  type ConnectionRoutingDeps,
  routeConnectionProposal,
  SCOPE_ASK_KIND,
} from "./connection-request";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";

/**
 * The routing half of `request_connection` alone (GRA-203; ADR 0024), over the in-memory store:
 * what a console route that opens the agent's own ask sees. No harness, no sandbox, no wait — the
 * deps carry no wait at all, only the TTL an ask is inserted with. The wait and the wire are
 * `connection-request.test.ts`'s.
 */

const PERSON = "person_1";
const AGENT = "agent_a";
const OTHER_AGENT = "agent_b";

const KEYLESS = {
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.example/v1",
  scheme: "none",
  docsUrl: "https://open-meteo.example/docs",
};

let store: FakeStore;
let deps: ConnectionRoutingDeps;
let db: DbOrTx;
let told: string[];
const scope = { personId: PERSON, agentId: AGENT };
const ctx = () => ({ db });
const notifier = { changed: (agentId: string) => void told.push(agentId) };

beforeEach(() => {
  store = createFakeStore();
  store.addAgent({ id: AGENT, personId: PERSON, token: "grft_routing_a", scopeMode: "listed" });
  store.addAgent({
    id: OTHER_AGENT,
    personId: PERSON,
    token: "grft_routing_b",
    scopeMode: "listed",
  });
  const fake = createFakeDeps(store);
  db = fake.db;
  deps = { ...fake, handoff: { ttlMs: 60_000 } };
  told = [];
});

describe("routeConnectionProposal", () => {
  it("opens a connection ask for a keyless proposal and answers its id and payload, without taking it", async () => {
    const routed = await routeConnectionProposal(ctx(), scope, KEYLESS, deps, notifier);
    if (routed.kind !== "connection") throw new Error(`expected an ask, got ${routed.kind}`);
    const row = store.pendingActions.get(routed.pendingActionId);
    expect(row).toMatchObject({ kind: CONNECTION_ASK_KIND, agentId: AGENT, answeredAt: null });
    expect(row?.consumedAt ?? null).toBeNull();
    expect(routed.action.id).toBe(routed.pendingActionId);
    expect(routed.widens).toBeNull();
    expect(routed.payload).toMatchObject({
      provider: "keyring",
      providerConnect: "form",
      vendor: "open-meteo",
      scheme: "none",
      primaryHost: "https://api.open-meteo.example/v1",
      hosts: ["api.open-meteo.example"],
    });
    expect(routed).toMatchObject({ hosts: ["api.open-meteo.example"], hostsSetAside: [] });
    expect(told).toEqual([]);
  });

  it("answers the same ask for a repeat of the proposal, and inserts no second", async () => {
    const first = await routeConnectionProposal(ctx(), scope, KEYLESS, deps);
    const second = await routeConnectionProposal(ctx(), scope, KEYLESS, deps);
    if (first.kind !== "connection") throw new Error(`expected an ask, got ${first.kind}`);
    expect(second).toMatchObject({ kind: "connection", pendingActionId: first.pendingActionId });
    expect([...store.pendingActions.values()].filter((row) => row.agentId === AGENT)).toHaveLength(
      1,
    );
  });

  it("answers the connection a provider with no person step made, in this agent's scope, and announces it", async () => {
    const gateway = createGatewayProvider({
      hosts: ["api.unleashed.example"],
      upstreamUrl: "https://gateway.corp.example/graft",
      headerName: "X-Deployment-Token",
      headerValue: "deployment-identity-secret-value",
    });
    deps = { ...deps, connection: { ...deps.connection, providers: [gateway, keyringProvider] } };
    const routed = await routeConnectionProposal(
      ctx(),
      scope,
      {
        vendor: "unleashed",
        primaryHost: "https://api.unleashed.example",
        scheme: "api_key_header",
        schemeConfig: { headerName: "api-auth-id" },
      },
      deps,
      notifier,
    );
    if (routed.kind !== "connected") throw new Error(`expected connected, got ${routed.kind}`);
    expect(routed.how).toBe("provider");
    expect(store.connections.get(routed.connection.id)).toMatchObject({ provider: "gateway" });
    expect(store.agentConnections.get(AGENT)?.has(routed.connection.id)).toBe(true);
    expect(store.pendingActions.size).toBe(0);
    expect(told).toEqual([AGENT]);
  });

  it("answers connected for a usable row already in this agent's scope, and opens no ask", async () => {
    const row = store.addConnection({
      id: "conn_meteo",
      personId: PERSON,
      vendor: "open-meteo",
      displayName: "Open-Meteo",
      scheme: "none",
      schemeConfig: {},
      primaryHost: "https://api.open-meteo.example/v1",
    });
    store.agentConnections.get(AGENT)?.add(row.id);
    const routed = await routeConnectionProposal(ctx(), scope, KEYLESS, deps);
    expect(routed).toMatchObject({
      kind: "connected",
      how: "already",
      connection: { id: row.id },
    });
    expect(store.pendingActions.size).toBe(0);
  });

  it("opens a scope ask for a usable row another agent holds, and a refusal for a proposal's shape", async () => {
    const row = store.addConnection({
      id: "conn_meteo_other",
      personId: PERSON,
      vendor: "open-meteo",
      scheme: "none",
      schemeConfig: {},
      primaryHost: "https://api.open-meteo.example/v1",
    });
    store.agentConnections.get(OTHER_AGENT)?.add(row.id);
    const routed = await routeConnectionProposal(ctx(), scope, KEYLESS, deps);
    if (routed.kind !== "scope") throw new Error(`expected a scope ask, got ${routed.kind}`);
    expect(store.pendingActions.get(routed.pendingActionId)).toMatchObject({
      kind: SCOPE_ASK_KIND,
      connectionId: row.id,
    });
    expect(routed.payload).toMatchObject({ connectionId: row.id, vendor: "open-meteo" });
    expect(routed.connection.id).toBe(row.id);

    const refused = await routeConnectionProposal(
      ctx(),
      scope,
      { ...KEYLESS, primaryHost: "https://169.254.169.254" },
      deps,
    );
    expect(refused).toMatchObject({ kind: "refused", reason: "host_not_public", hosts: [] });
  });
});
