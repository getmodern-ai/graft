import {
  type DirectoryEntry,
  type IntegrationDirectory,
  keyringProvider,
  SUGGESTED_INTEGRATIONS_LIMIT,
} from "@graft/core";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import { initLogger } from "evlog";
import { describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";
import { fakeSuggestedDeps } from "./testing/fake-suggested";

/**
 * The directory outside Setup and "your agents asked for these" (GRA-305; ADR 0001 as amended
 * 2026-10-14), over the API on the in-memory store, under both backings: the open form's starter
 * directory (no `directory` option) and a hosted one as the private package would hand it.
 */

initLogger({ silent: true });

const PERSON = "person_1";

const ACME: DirectoryEntry = {
  slug: "acme-crm",
  name: "Acme CRM",
  description: "Customers and deals.",
  logoUrl: "https://logos.example/acme.png",
  categories: ["CRM"],
  hosts: ["api.acme-crm.com"],
  docsUrl: null,
  connect: "link",
  scheme: "bearer",
};
const HOSTED: IntegrationDirectory = {
  name: "hosted-directory",
  home: async () => ({
    total: 3000,
    categories: [{ name: "CRM", count: 1 }],
    popular: [ACME],
    wall: [],
  }),
  search: async ({ query }) => {
    const entries = [ACME].filter((e) => e.name.toLowerCase().includes(query ?? ""));
    return { entries, nextCursor: null, total: entries.length };
  },
  get: async (slug) => (slug === ACME.slug ? ACME : null),
};

function harness(options: { directory?: IntegrationDirectory } = {}) {
  const store = createFakeStore();
  const fake = createFakeDeps(store);
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
        connection: { ...fake.connection, providers: [keyringProvider] },
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
        suggested: fakeSuggestedDeps(store),
      },
      corsOrigins: [],
      authUrl: "http://localhost",
      handoff: {
        consoleUrl: "http://console.graft.test",
        secret: "graft-integrations-test-handoff-secret-32",
      },
      ...(options.directory ? { directory: options.directory } : {}),
    },
  });
  return { app, store, fake };
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON answer by field.
const json = async (res: Response): Promise<any> => {
  expect(res.status).toBe(200);
  return res.json();
};

type H = ReturnType<typeof harness>;

async function agentOf(h: H, id: string, personId = PERSON, name = `Agent ${id}`) {
  await h.fake.agent.insertAgent(h.fake.db, { id, personId, name });
}

const HOUR = 3_600_000;

/** A `connection` ask as `request_connection` records one, made `hoursAgo` before the store's now. */
async function askFor(
  h: H,
  args: {
    id: string;
    agentId: string;
    vendor: string;
    hoursAgo: number;
    displayName?: string;
    answer?: Record<string, unknown>;
    expired?: boolean;
  },
) {
  const now = h.store.now().getTime();
  await h.fake.pendingAction.insertPendingAction(h.fake.db, {
    id: args.id,
    agentId: args.agentId,
    kind: "connection",
    payload: {
      provider: "keyring",
      vendor: args.vendor,
      displayName: args.displayName ?? args.vendor,
      scheme: "bearer",
      schemeConfig: {},
      primaryHost: `https://api.${args.vendor}.com`,
      hosts: [`api.${args.vendor}.com`],
      docsUrl: `https://docs.${args.vendor}.com`,
      note: "The agent proposed this connection.",
    },
    createdAt: new Date(now - args.hoursAgo * HOUR),
    expiresAt: new Date(args.expired ? now - HOUR / 2 : now + 24 * HOUR),
    ...(args.answer ? { answer: args.answer, answeredAt: new Date(now - HOUR / 4) } : {}),
  });
}

describe("GET /api/integrations/directory and /search", () => {
  it("answers what Setup's routes answer, under the open form's starter directory", async () => {
    const h = harness();
    const home = await json(await h.app.request("/api/integrations/directory"));
    expect(home).toEqual(await json(await h.app.request("/api/setup/directory")));
    // The keyring alone connects Open-Meteo alone: no categories, no marks, the starters' total.
    expect(home).toMatchObject({ source: "starters", total: 1, categories: [], wall: [] });
    expect(home.popular).toEqual([
      expect.objectContaining({ slug: "open-meteo", logoUrl: null, starterId: "open-meteo" }),
    ]);
    const found = await json(await h.app.request("/api/integrations/directory/search?q=meteo"));
    expect(found).toEqual(await json(await h.app.request("/api/setup/directory/search?q=meteo")));
    expect(found).toMatchObject({ total: 1, entries: [{ slug: "open-meteo" }] });
  });

  it("answers the hosted backing's directory when there is one", async () => {
    const h = harness({ directory: HOSTED });
    const home = await json(await h.app.request("/api/integrations/directory"));
    expect(home).toMatchObject({
      source: "hosted-directory",
      total: 3000,
      categories: [{ name: "CRM", count: 1 }],
      popular: [{ slug: "acme-crm", logoUrl: ACME.logoUrl, starterId: null }],
    });
    const found = await json(await h.app.request("/api/integrations/directory/search?q=acme"));
    expect(found).toMatchObject({ total: 1, entries: [{ slug: "acme-crm", starterId: null }] });
  });

  it("refuses without a session", async () => {
    const h = harness();
    const app = createServer({
      keys: null,
      vault: { decrypt: async () => ({}) },
      connections: { get: async () => null },
      followRedirects: false,
      api: {
        auth: { handler: async () => new Response("auth"), getSession: async () => null },
        deps: {
          db: h.fake.db,
          agent: h.fake.agent,
          connection: h.fake.connection,
          workingSet: h.fake.workingSet,
          tool: h.fake.tool,
          ledger: h.fake.ledger,
          approval: h.fake.approval,
          pendingAction: h.fake.pendingAction,
          modelKey: fakeModelKeyDeps(),
        },
        corsOrigins: [],
        authUrl: "http://localhost",
        handoff: { consoleUrl: "http://console.graft.test", secret: "x".repeat(32) },
      },
    });
    for (const path of ["directory", "directory/search", "suggested"]) {
      expect((await app.request(`/api/integrations/${path}`)).status).toBe(401);
    }
  });
});

describe("GET /api/integrations/suggested", () => {
  it("lists the integrations the person's agents asked for and the person has not connected", async () => {
    const h = harness({ directory: HOSTED });
    await agentOf(h, "agent_a", PERSON, "Hermes");
    await agentOf(h, "agent_b", PERSON, "Claude");
    await askFor(h, { id: "pa_old", agentId: "agent_a", vendor: "acme-crm", hoursAgo: 5 });
    // The newest ask of a vendor wins, whichever agent made it.
    await askFor(h, {
      id: "pa_new",
      agentId: "agent_b",
      vendor: "acme-crm",
      hoursAgo: 1,
      displayName: "Acme CRM",
    });
    await askFor(h, {
      id: "pa_declined",
      agentId: "agent_a",
      vendor: "beta",
      hoursAgo: 2,
      answer: { decline: true },
    });
    await askFor(h, {
      id: "pa_expired",
      agentId: "agent_a",
      vendor: "gamma",
      hoursAgo: 30,
      expired: true,
    });

    const { suggestions } = await json(await h.app.request("/api/integrations/suggested"));
    expect(suggestions).toEqual([
      {
        vendor: "acme-crm",
        displayName: "Acme CRM",
        docsUrl: "https://docs.acme-crm.com",
        logoUrl: ACME.logoUrl,
        agent: { id: "agent_b", name: "Claude" },
        ask: {
          pendingActionId: "pa_new",
          state: "open",
          askedAt: expect.any(String),
          ageSeconds: 3600,
        },
      },
      expect.objectContaining({
        vendor: "beta",
        logoUrl: null,
        ask: expect.objectContaining({ pendingActionId: "pa_declined", state: "declined" }),
      }),
      expect.objectContaining({
        vendor: "gamma",
        ask: expect.objectContaining({ pendingActionId: "pa_expired", state: "expired" }),
      }),
    ]);
    // No prompt content: the payload's provenance note and hosts stay where they are.
    expect(JSON.stringify(suggestions)).not.toContain("proposed this connection");
  });

  it("leaves out what is connected, what an ask connected, and anything of another person's", async () => {
    const h = harness();
    await agentOf(h, "agent_a");
    await agentOf(h, "agent_other", "person_2");
    await askFor(h, { id: "pa_connected", agentId: "agent_a", vendor: "acme-crm", hoursAgo: 1 });
    await h.fake.connection.insertConnection(h.fake.db, {
      id: "conn_1",
      personId: PERSON,
      vendor: "acme-crm",
      displayName: "Acme CRM",
      scheme: "bearer",
      primaryHost: "https://api.acme-crm.com",
      hosts: ["api.acme-crm.com"],
    } as never);
    await askFor(h, {
      id: "pa_answered",
      agentId: "agent_a",
      vendor: "beta",
      hoursAgo: 1,
      answer: { connectionId: "conn_gone" },
    });
    await askFor(h, { id: "pa_theirs", agentId: "agent_other", vendor: "gamma", hoursAgo: 1 });

    const { suggestions } = await json(await h.app.request("/api/integrations/suggested"));
    expect(suggestions).toEqual([]);
  });

  it("is bounded, and under the starter directory carries no marks", async () => {
    const h = harness();
    await agentOf(h, "agent_a");
    for (let i = 0; i < SUGGESTED_INTEGRATIONS_LIMIT + 3; i += 1) {
      await askFor(h, { id: `pa_${i}`, agentId: "agent_a", vendor: `vendor-${i}`, hoursAgo: i });
    }
    const { suggestions } = await json(await h.app.request("/api/integrations/suggested"));
    expect(suggestions).toHaveLength(SUGGESTED_INTEGRATIONS_LIMIT);
    expect(suggestions[0].vendor).toBe("vendor-0");
    expect(suggestions.every((s: { logoUrl: unknown }) => s.logoUrl === null)).toBe(true);
  });
});
