import { type ConnectionProvider, keyringProvider, type SetupDeps } from "@graft/core";
import { createFakeLinkProvider } from "@graft/core/connection/testing/fake-link-provider";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import type { Capture } from "@graft/observability";
import { initLogger } from "evlog";
import { describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * Setup's vendor and connect steps over the API (GRA-206; ADR 0024), on the in-memory store behind
 * the real services and the real routing (`routeConnectionProposal`, GRA-203): the list each
 * deployment answers, the agent's own connection ask a starter opens, the existing pending-action
 * routes answering it, and the record learning the connection on its next read. What is asserted
 * is the wire and the store: the state, the ask, the connection and the agent's scope.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const CONSOLE_ORIGIN = "http://localhost";

function inMemorySetup(now: () => Date): SetupDeps {
  let record: SetupRow | null = null;
  const save = (patch: SetupPatch): SetupRow => {
    const at = now();
    record = {
      personId: PERSON,
      step: "harness",
      harness: null,
      agentId: null,
      pendingActionId: null,
      connectionId: null,
      acquireJobId: null,
      toolId: null,
      startedAt: null,
      completedAt: null,
      skippedAt: null,
      owner: "person",
      createdAt: at,
      updatedAt: at,
      ...record,
      ...patch,
    } as SetupRow;
    return record;
  };
  return {
    findSetup: async () => record,
    lockSetup: async () => record ?? save({}),
    saveSetup: async (_db, _person, patch) => save(patch),
    countSetupWork: async () => ({ connections: 0, tools: 0 }),
    now,
  };
}

function harness(options: { providers?: readonly ConnectionProvider[] } = {}) {
  const store = createFakeStore();
  const fake = createFakeDeps(store);
  const connection = { ...fake.connection, providers: options.providers ?? [keyringProvider] };
  const handoff = {
    consoleUrl: "http://console.graft.test",
    secret: "graft-setup-connect-test-handoff-secret-32",
  };
  const captured: Capture[] = [];
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth"),
        getSession: async () => ({ user: { id: PERSON } }),
      },
      deps: {
        db: fake.db,
        agent: fake.agent,
        connection,
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
        setup: inMemorySetup(() => store.now()),
      },
      corsOrigins: [],
      authUrl: CONSOLE_ORIGIN,
      handoff,
      connectionRouting: {
        connection,
        agent: fake.agent,
        pendingAction: fake.pendingAction,
        listPendingActionsByKind: fake.listPendingActionsByKind,
        lockPendingActionKey: fake.lockPendingActionKey,
        handoff: { ttlMs: 60_000 },
      },
      analytics: {
        name: "recorder",
        shutdown: async () => {},
        capture: (event) => {
          captured.push(event);
        },
      },
    },
  });
  return { app, store, captured };
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON answer by field.
const read = async (res: Response): Promise<any> => {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const post = (body?: unknown) => ({
  method: "POST",
  headers: {
    origin: CONSOLE_ORIGIN,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A fresh person's Setup started for a harness, answering the agent it minted. */
async function started(h: ReturnType<typeof harness>): Promise<string> {
  const state = await read(await h.app.request("/api/setup/start", post({ harness: "hermes" })));
  expect(state.step).toBe("vendor");
  return state.agent.id;
}

const stepEvents = (captured: Capture[]) =>
  captured
    .filter((event) => event.event === "setup_step_completed")
    .map((event) => event.properties?.step);

describe("GET /api/setup/vendors", () => {
  it("on the keyring alone omits Gmail, Google Calendar and Slack and leads with Open-Meteo", async () => {
    const h = harness();
    const res = await h.app.request("/api/setup/vendors");
    expect(res.status).toBe(200);
    const { vendors } = await read(res);
    expect(vendors.map((option: { starter: { id: string } }) => option.starter.id)).toEqual([
      "open-meteo",
      "notion",
      "github",
      "linear",
    ]);
    expect(vendors[0]).toMatchObject({
      provider: "keyring",
      connect: "keyless",
      starter: { outcome: expect.any(String), runInput: { defaultValue: "Melbourne" } },
    });
  });

  it("leads with Gmail as a link once a link provider covers it", async () => {
    const broker = createFakeLinkProvider({
      name: "broker",
      covers: (vendor) => vendor === "gmail",
    });
    const h = harness({ providers: [broker, keyringProvider] });
    const { vendors } = await read(await h.app.request("/api/setup/vendors"));
    expect(vendors.map((option: { starter: { id: string } }) => option.starter.id)).toEqual([
      "gmail",
      "open-meteo",
      "notion",
      "github",
      "linear",
    ]);
    expect(vendors[0]).toMatchObject({ provider: "broker", connect: "link" });
  });
});

describe("POST /api/setup/connect", () => {
  it("opens Open-Meteo's keyless ask as the agent, re-uses it, and learns the confirmed connection", async () => {
    const h = harness();
    const agentId = await started(h);

    const res = await h.app.request("/api/setup/connect", post({ starterId: "open-meteo" }));
    expect(res.status).toBe(200);
    const asked = await read(res);
    expect(asked).toMatchObject({ step: "connect", setup: { connectionId: null } });
    const askId: string = asked.setup.pendingActionId;
    expect(askId).toEqual(expect.any(String));

    // The agent's own ask, open in the inbox like any other, with the build choice to make.
    const inbox = await read(await h.app.request("/api/pending-actions"));
    expect(inbox.pendingActions).toHaveLength(1);
    expect(inbox.pendingActions[0]).toMatchObject({
      id: askId,
      agentId,
      kind: "connection",
      payload: {
        vendor: "open-meteo",
        scheme: "none",
        provider: "keyring",
        hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
      },
    });

    // A repeat choice re-uses the open ask.
    const again = await read(
      await h.app.request("/api/setup/connect", post({ starterId: "open-meteo" })),
    );
    expect(again.setup.pendingActionId).toBe(askId);
    expect((await read(await h.app.request("/api/pending-actions"))).pendingActions).toHaveLength(
      1,
    );

    // Still open: a read leaves the record where it is.
    expect((await read(await h.app.request("/api/setup"))).step).toBe("connect");

    // The keyless confirmation, through the existing route the card posts to.
    const { payload } = inbox.pendingActions[0];
    const confirmed = await h.app.request(
      `/api/pending-actions/${askId}/connection`,
      post({
        vendor: payload.vendor,
        displayName: payload.displayName,
        primaryHost: payload.primaryHost,
        hosts: payload.hosts,
        scheme: payload.scheme,
        schemeConfig: payload.schemeConfig,
        credential: {},
        approveBuild: true,
      }),
    );
    expect(confirmed.status).toBe(201);
    const connectionId: string = (await read(confirmed)).connection.id;

    const learned = await read(await h.app.request("/api/setup"));
    expect(learned).toMatchObject({
      step: "goal",
      setup: { step: "goal", connectionId, pendingActionId: null },
    });
    // In the agent's scope (every connection, the default), and the ask's answer left for the
    // agent's own next request_connection to take.
    const agent = await read(await h.app.request(`/api/agents/${agentId}`));
    expect(agent.connectionIds).toContain(connectionId);
    expect(h.store.pendingActions.get(askId)?.consumedAt).toBeNull();

    // A second read counts nothing more.
    await h.app.request("/api/setup");
    expect(stepEvents(h.captured)).toEqual(["vendor", "vendor", "connect"]);
    expect(h.captured.find((event) => event.event === "setup_step_completed")?.properties).toEqual({
      via: "console",
      step: "vendor",
      harness: "hermes",
    });
  });

  it("opens GitHub's secret form with the host and scheme, and a token connects it", async () => {
    const h = harness();
    await started(h);
    const asked = await read(
      await h.app.request("/api/setup/connect", post({ starterId: "github" })),
    );
    const askId: string = asked.setup.pendingActionId;
    const ask = h.store.pendingActions.get(askId);
    expect(ask?.payload).toMatchObject({
      vendor: "github",
      primaryHost: "https://api.github.com",
      scheme: "bearer",
      providerConnect: "form",
    });
    const res = await h.app.request(
      `/api/pending-actions/${askId}/connection`,
      post({
        vendor: "github",
        displayName: "GitHub",
        primaryHost: "https://api.github.com",
        hosts: ["api.github.com"],
        scheme: "bearer",
        credential: { token: "ghp_setup_test_token" },
      }),
    );
    expect(res.status).toBe(201);
    const connectionId: string = (await read(res)).connection.id;
    expect(await read(await h.app.request("/api/setup"))).toMatchObject({
      step: "goal",
      setup: { connectionId },
    });
  });

  it("goes back to the vendor step when the ask is declined", async () => {
    const h = harness();
    await started(h);
    const asked = await read(
      await h.app.request("/api/setup/connect", post({ starterId: "notion" })),
    );
    const askId: string = asked.setup.pendingActionId;
    expect(
      (await h.app.request(`/api/pending-actions/${askId}/answer`, post({ allow: false }))).status,
    ).toBe(200);
    expect(await read(await h.app.request("/api/setup"))).toMatchObject({
      step: "vendor",
      setup: { pendingActionId: null, connectionId: null },
    });
  });

  it("takes the connection Another vendor's ordinary form made, into the agent's scope", async () => {
    const h = harness();
    const agentId = await started(h);
    // The agent narrowed to a list, so the scope grant is observable.
    await h.app.request(`/api/agents/${agentId}/scope`, {
      ...post({ mode: "listed", connectionIds: [] }),
      method: "PUT",
    });
    const made = await h.app.request(
      "/api/connections",
      post({
        vendor: "acme",
        displayName: "Acme",
        primaryHost: "https://api.acme.example",
        scheme: "none",
      }),
    );
    expect(made.status).toBe(201);
    const connectionId: string = (await read(made)).connection.id;
    const state = await read(await h.app.request("/api/setup/connect", post({ connectionId })));
    expect(state).toMatchObject({ step: "goal", setup: { connectionId } });
    expect((await read(await h.app.request(`/api/agents/${agentId}`))).connectionIds).toEqual([
      connectionId,
    ]);
    // Both steps complete in this one request: the vendor step's row in the mutation table, and the
    // connect step counted by the route, which fires first since the table's middleware runs last.
    expect(stepEvents(h.captured).sort()).toEqual(["connect", "vendor"]);
  });

  it("refuses before Setup has started, an unknown starter, and a body with both", async () => {
    const h = harness();
    const early = await h.app.request("/api/setup/connect", post({ starterId: "open-meteo" }));
    expect(early.status).toBe(409);
    expect(await read(early)).toMatchObject({ details: { reason: "setup_not_started" } });
    await started(h);
    expect((await h.app.request("/api/setup/connect", post({ starterId: "jira" }))).status).toBe(
      400,
    );
    expect(
      (
        await h.app.request(
          "/api/setup/connect",
          post({ starterId: "open-meteo", connectionId: "conn_1" }),
        )
      ).status,
    ).toBe(400);
    expect(h.store.pendingActions.size).toBe(0);
  });
});
