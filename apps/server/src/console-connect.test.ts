import { type ConnectionProvider, createGatewayProvider, keyringProvider } from "@graft/core";
import {
  createFakeLinkProvider,
  type FakeLinkProvider,
} from "@graft/core/connection/testing/fake-link-provider";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import type { Capture } from "@graft/observability";
import { initLogger } from "evlog";
import { describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * The console connect with no agent asking (GRA-304; ADR 0006 as amended 2026-10-14) over the API,
 * on the in-memory store behind the real services: a keyless integration made at once, a keyed one
 * answered as the form and made by `POST /connections`, a link provider's link minted with no
 * pending action and finished by the return route against `@graft/core`'s fake link provider, the
 * access choice recorded only for the agents in scope at that moment (ADR 0008 as amended
 * 2026-10-14), and two people kept apart. What is asserted is the wire and the store.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const OTHER = "person_2";
const AUTH_URL = "http://graft.test";
const CONSOLE_URL = "http://console.graft.test";

const OPEN_METEO = {
  vendor: "open-meteo",
  displayName: "Open-Meteo",
  primaryHost: "https://api.open-meteo.com/v1",
  hosts: ["geocoding-api.open-meteo.com"],
  scheme: "none",
};

const LINEAR = {
  vendor: "linear",
  displayName: "Linear",
  primaryHost: "https://api.linear.app",
  scheme: "bearer",
  docsUrl: "https://developers.linear.app/docs",
};

const GMAIL = {
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com/gmail/v1",
  scheme: "oauth_authorization_code",
  schemeConfig: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  },
};

function harness(
  options: {
    providers?: (broker: FakeLinkProvider) => ConnectionProvider[];
    /** A revoke landing between the find and the approvals: the locked read sees it revoked. */
    revokeBeforeApprovals?: boolean;
  } = {},
) {
  // A clock the test moves, for a link that took too long.
  const clock = { at: Date.now() };
  const store = createFakeStore({ now: () => new Date(clock.at) });
  const fake = createFakeDeps(store);
  const broker = createFakeLinkProvider({
    name: "some-broker",
    covers: (vendor) => vendor === "gmail",
  });
  const providers = options.providers?.(broker) ?? [broker, keyringProvider];
  // The keys the find-or-make locks on, in order: the store has no transactions to hold one across.
  const locks: string[] = [];
  const connection = {
    ...fake.connection,
    providers,
    lockConnectionKey: async (_db: unknown, personId: string, key: string) => {
      locks.push(`${personId} ${key}`);
    },
    findConnectionForNoKeyUpdate: async (
      db: Parameters<typeof fake.connection.findConnectionForNoKeyUpdate>[0],
      personId: string,
      id: string,
    ) => {
      const row = await fake.connection.findConnectionForNoKeyUpdate(db, personId, id);
      return row && options.revokeBeforeApprovals ? { ...row, revokedAt: new Date() } : row;
    },
  };
  const captured: Capture[] = [];
  const notified: string[] = [];
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth"),
        // The person is the request's: a test speaks as another by naming them.
        getSession: async (headers) => ({ user: { id: headers.get("x-test-person") ?? PERSON } }),
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
      },
      corsOrigins: [],
      authUrl: AUTH_URL,
      handoff: { consoleUrl: CONSOLE_URL, secret: "graft-console-connect-test-secret-32-chars" },
      notifier: { changed: (agentId: string) => void notified.push(agentId) },
      analytics: {
        name: "recorder",
        shutdown: async () => {},
        capture: (event) => {
          captured.push(event);
        },
      },
    },
  });
  // Three agents of the person's and one of another's: on every connection, narrowed to a list,
  // revoked; and the other person's, on every connection of theirs.
  store.addAgent({
    id: "agent_all",
    personId: PERSON,
    token: "grft_a".padEnd(40, "0"),
    scopeMode: "all",
  });
  store.addAgent({
    id: "agent_listed",
    personId: PERSON,
    token: "grft_b".padEnd(40, "0"),
    scopeMode: "listed",
  });
  const revoked = store.addAgent({
    id: "agent_revoked",
    personId: PERSON,
    token: "grft_c".padEnd(40, "0"),
    scopeMode: "all",
  });
  store.agents.set(revoked.id, { ...revoked, revokedAt: new Date() });
  store.addAgent({
    id: "agent_other",
    personId: OTHER,
    token: "grft_d".padEnd(40, "0"),
    scopeMode: "all",
  });
  return { app, store, broker, captured, notified, locks, clock };
}

// biome-ignore lint/suspicious/noExplicitAny: a test reads the JSON answer by field.
const read = async (res: Response): Promise<any> => {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const post = (body: unknown, person = PERSON) => ({
  method: "POST",
  headers: { origin: AUTH_URL, "content-type": "application/json", "x-test-person": person },
  body: JSON.stringify(body),
});

const rowsOf = (h: ReturnType<typeof harness>, personId: string) =>
  [...h.store.connections.values()].filter((row) => row.personId === personId);

const approvalsOf = (h: ReturnType<typeof harness>) => ({
  build: [...h.store.buildApprovals.keys()].sort(),
  vendor: [...h.store.vendorApprovals.values()]
    .map((row) => `${row.agentId} ${row.vendor} ${row.includesDestructive}`)
    .sort(),
});

/** The link's return, as the browser would follow it out of the fake's redirect URIs. */
const landing = (h: ReturnType<typeof harness>, url: string) => {
  const target = new URL(url);
  return h.app.request(`${target.pathname}${target.search}`);
};

const consoleOutcome = (response: Response) => {
  expect(response.status).toBe(302);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith(`${CONSOLE_URL}/link/callback?`)).toBe(true);
  return Object.fromEntries(new URL(location).searchParams);
};

describe("a keyless integration connected from the console", () => {
  it("makes one row at once, in every `all` agent's scope and no listed agent's, and records nothing under ask", async () => {
    const h = harness();
    const res = await h.app.request("/api/connect", post({ proposal: OPEN_METEO }));
    expect(res.status).toBe(201);
    const said = await read(res);
    expect(said).toMatchObject({
      kind: "connected",
      created: true,
      access: "ask",
      approvedAgentIds: [],
      connection: { vendor: "open-meteo", provider: "keyring", scheme: "none" },
    });
    expect(said.connection.hosts).toEqual(["api.open-meteo.com", "geocoding-api.open-meteo.com"]);
    expect(rowsOf(h, PERSON)).toHaveLength(1);
    expect(h.store.pendingActions.size).toBe(0);
    // No scope row is written: the row is in `agent_all`'s scope by being the person's.
    expect(h.store.agentConnections.get("agent_listed")?.size ?? 0).toBe(0);
    expect(approvalsOf(h)).toEqual({ build: [], vendor: [] });
    expect(h.notified).toContain("agent_all");
    expect(h.notified).not.toContain("agent_listed");
    expect(h.captured.map((e) => e.event)).toEqual(["connection_started"]);
    expect(h.captured[0]?.properties).toMatchObject({
      kind: "connected",
      access: "ask",
      created: true,
    });
  });

  it("a second connect answers the row rather than doubling it", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: OPEN_METEO }));
    const again = await h.app.request("/api/connect", post({ proposal: OPEN_METEO }));
    expect(again.status).toBe(200);
    expect(await read(again)).toMatchObject({ kind: "connected", created: false });
    expect(rowsOf(h, PERSON)).toHaveLength(1);
  });

  it("a directory entry by slug is read again from the directory and connected the same way", async () => {
    const h = harness();
    const said = await read(await h.app.request("/api/connect", post({ slug: "open-meteo" })));
    expect(said).toMatchObject({ kind: "connected", created: true });
    expect(said.connection.vendor).toBe("open-meteo");
    const missing = await h.app.request("/api/connect", post({ slug: "nothing-here" }));
    expect(missing.status).toBe(404);
  });

  it("full access writes the build approval and the non-destructive integration approval for in-scope active agents alone", async () => {
    const h = harness();
    const said = await read(
      await h.app.request("/api/connect", post({ proposal: OPEN_METEO, access: "full" })),
    );
    expect(said.approvedAgentIds).toEqual(["agent_all"]);
    const id = said.connection.id;
    expect(approvalsOf(h)).toEqual({
      build: [`agent_all ${id}`],
      vendor: ["agent_all open-meteo false"],
    });
  });

  it("a listed agent that already holds the row is in scope, and full access records for it too", async () => {
    const h = harness();
    const first = await read(await h.app.request("/api/connect", post({ proposal: OPEN_METEO })));
    h.store.agentConnections.set("agent_listed", new Set([first.connection.id]));
    const said = await read(
      await h.app.request("/api/connect", post({ proposal: OPEN_METEO, access: "full" })),
    );
    expect(said.created).toBe(false);
    expect([...said.approvedAgentIds].sort()).toEqual(["agent_all", "agent_listed"]);
  });

  it("refuses a proposal the connection rules refuse, before anything is written", async () => {
    const h = harness();
    const res = await h.app.request(
      "/api/connect",
      post({ proposal: { ...OPEN_METEO, primaryHost: "https://127.0.0.1" } }),
    );
    expect(res.status).toBe(400);
    expect(rowsOf(h, PERSON)).toHaveLength(0);
    // Both a slug and a proposal is not a body.
    const both = await h.app.request("/api/connect", post({ slug: "x", proposal: OPEN_METEO }));
    expect(both.status).toBe(400);
  });
});

describe("a keyed integration connected from the console", () => {
  it("answers the keyring's form, writes nothing, and the form's submit makes one row with the access chosen", async () => {
    const h = harness();
    const said = await read(
      await h.app.request("/api/connect", post({ proposal: LINEAR, access: "full" })),
    );
    expect(said).toMatchObject({
      kind: "form",
      provider: "keyring",
      access: "full",
      fallback: null,
      proposal: {
        vendor: "linear",
        scheme: "bearer",
        primaryHost: "https://api.linear.app",
        hosts: ["api.linear.app"],
        docsUrl: "https://developers.linear.app/docs",
      },
    });
    expect(said.schemes).toContain("bearer");
    expect(rowsOf(h, PERSON)).toHaveLength(0);

    const { docsUrl: _docs, ...registration } = said.proposal;
    const made = await h.app.request(
      "/api/connections",
      post({ ...registration, credential: { token: "lin_api_secret" }, access: "full" }),
    );
    expect(made.status).toBe(201);
    const { connection } = await read(made);
    expect(rowsOf(h, PERSON)).toHaveLength(1);
    expect(approvalsOf(h)).toEqual({
      build: [`agent_all ${connection.id}`],
      vendor: ["agent_all linear false"],
    });
  });

  it("the form's submit without access records nothing", async () => {
    const h = harness();
    await h.app.request(
      "/api/connections",
      post({ ...LINEAR, credential: { token: "lin_api_secret" } }),
    );
    expect(rowsOf(h, PERSON)).toHaveLength(1);
    expect(approvalsOf(h)).toEqual({ build: [], vendor: [] });
  });
});

describe("a link provider's integration connected from the console", () => {
  it("mints the link keyed by a signed record, with no pending action, and the return makes the connection", async () => {
    const h = harness();
    const res = await h.app.request("/api/connect", post({ proposal: GMAIL, access: "full" }));
    expect(res.status).toBe(200);
    const said = await read(res);
    expect(said).toMatchObject({ kind: "link", provider: "some-broker", access: "full" });
    expect(said.connectId).toEqual(expect.any(String));
    expect(h.store.pendingActions.size).toBe(0);
    expect(rowsOf(h, PERSON)).toHaveLength(0);
    const minted = h.broker.minted.at(-1);
    expect(minted?.personId).toBe(PERSON);
    const success = new URL(minted?.success ?? "");
    expect(success.origin + success.pathname).toBe(`${AUTH_URL}/api/providers/link/callback`);
    expect(h.captured.map((e) => e.event)).toEqual(["provider_link_started", "connection_started"]);

    // A return before the person finished: nothing connected, the record still good.
    const early = consoleOutcome(await landing(h, minted?.success ?? ""));
    expect(early).toMatchObject({ status: "failed", connectId: said.connectId });
    expect(early.pendingActionId).toBeUndefined();
    expect(rowsOf(h, PERSON)).toHaveLength(0);

    h.broker.connectAccount({
      personId: PERSON,
      target: "gmail",
      id: "acct_1",
      label: "me@example.com",
    });
    const done = consoleOutcome(await landing(h, minted?.success ?? ""));
    expect(done).toMatchObject({ status: "connected", connectId: said.connectId });
    expect(done.message).toContain("Some broker");
    const rows = rowsOf(h, PERSON);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "some-broker",
      providerRef: "acct_1",
      vendor: "gmail",
    });
    expect(done.connectionId).toBe(rows[0]?.id);
    expect(approvalsOf(h)).toEqual({
      build: [`agent_all ${rows[0]?.id}`],
      vendor: ["agent_all gmail false"],
    });
    expect(h.store.agentConnections.get("agent_listed")?.size ?? 0).toBe(0);
    expect(h.notified).toContain("agent_all");

    // The browser lands again (a refresh): connected, and still one row.
    const again = consoleOutcome(await landing(h, minted?.success ?? ""));
    expect(again).toMatchObject({ status: "connected", connectionId: rows[0]?.id });
    expect(rowsOf(h, PERSON)).toHaveLength(1);
  });

  it("the provider's error redirect connects nothing and says so", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: GMAIL }));
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    const errored = consoleOutcome(await landing(h, h.broker.minted.at(-1)?.error ?? ""));
    expect(errored).toMatchObject({ status: "failed" });
    expect(errored.message).toContain("did not complete");
    expect(rowsOf(h, PERSON)).toHaveLength(0);
  });

  it("a provider that cannot start its link steps aside to the keyring's form", async () => {
    const h = harness();
    h.broker.failNext();
    const said = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    expect(said).toMatchObject({
      kind: "form",
      provider: "keyring",
      fallback: { provider: "some-broker" },
      proposal: { vendor: "gmail" },
    });
    expect(said.fallback.message).toContain("Some broker could not start its sign-in");
    expect(h.captured.map((e) => e.event)).toEqual([
      "provider_link_fell_back",
      "connection_started",
    ]);
  });

  it("a tampered record is refused and connects nothing", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: GMAIL }));
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    const url = new URL(h.broker.minted.at(-1)?.success ?? "");
    const state = url.searchParams.get("state") ?? "";
    const [encoded, mark] = state.split(".");
    const forged = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
    forged.personId = OTHER;
    url.searchParams.set(
      "state",
      `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mark}`,
    );
    const refused = consoleOutcome(await landing(h, url.toString()));
    expect(refused.status).toBe("failed");
    expect(rowsOf(h, PERSON)).toHaveLength(0);
    expect(rowsOf(h, OTHER)).toHaveLength(0);
  });
});

describe("two people kept apart", () => {
  it("one person's connect never reuses, approves or scopes for another's", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: OPEN_METEO, access: "full" }));
    const theirs = await read(
      await h.app.request("/api/connect", post({ proposal: OPEN_METEO, access: "full" }, OTHER)),
    );
    // A row of their own, not the first person's answered back.
    expect(theirs).toMatchObject({ kind: "connected", created: true });
    expect(theirs.approvedAgentIds).toEqual(["agent_other"]);
    expect(rowsOf(h, PERSON)).toHaveLength(1);
    expect(rowsOf(h, OTHER)).toHaveLength(1);
    expect(approvalsOf(h).vendor).toEqual([
      "agent_all open-meteo false",
      "agent_other open-meteo false",
    ]);
  });

  it("a link's return makes the connection for the person the record names, whoever's account it found", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: GMAIL }, OTHER));
    // An account the first person connected is not the other's to claim.
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_mine" });
    const outcome = consoleOutcome(await landing(h, h.broker.minted.at(-1)?.success ?? ""));
    expect(outcome.status).toBe("failed");
    expect(rowsOf(h, PERSON)).toHaveLength(0);
    expect(rowsOf(h, OTHER)).toHaveLength(0);
  });
});

describe("what Greptile's review of #238 asked for", () => {
  it("a refresh after the link connected never claims a second account the provider holds", async () => {
    const h = harness();
    const said = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    const success = h.broker.minted.at(-1)?.success ?? "";
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_2" });
    const first = consoleOutcome(await landing(h, success));
    expect(first).toMatchObject({ status: "connected", connectionId: said.connectId });
    const again = consoleOutcome(await landing(h, success));
    expect(again).toMatchObject({ status: "connected", connectionId: said.connectId });
    const rows = rowsOf(h, PERSON);
    expect(rows.map((row) => row.providerRef)).toEqual(["acct_1"]);
    // The landing took the record's lock before it wrote.
    expect(h.locks).toContain(`${PERSON} link:${said.connectId}`);
  });

  it("a second link started meanwhile still claims its own account", async () => {
    const h = harness();
    const one = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    const oneSuccess = h.broker.minted.at(-1)?.success ?? "";
    const two = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    const twoSuccess = h.broker.minted.at(-1)?.success ?? "";
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    expect(consoleOutcome(await landing(h, oneSuccess)).connectionId).toBe(one.connectId);
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_2" });
    expect(consoleOutcome(await landing(h, twoSuccess)).connectionId).toBe(two.connectId);
    expect(
      rowsOf(h, PERSON)
        .map((row) => row.providerRef)
        .sort(),
    ).toEqual(["acct_1", "acct_2"]);
  });

  it("a link that took too long fails with the record's connectId and connects nothing", async () => {
    const h = harness();
    const said = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    h.clock.at += 16 * 60_000;
    const late = consoleOutcome(await landing(h, h.broker.minted.at(-1)?.success ?? ""));
    expect(late).toMatchObject({ status: "failed", connectId: said.connectId });
    expect(late.message).toContain("took too long");
    expect(rowsOf(h, PERSON)).toHaveLength(0);
  });

  it("a keyless connect finds or makes its row under the person's lock on the provider and vendor", async () => {
    const h = harness();
    await h.app.request("/api/connect", post({ proposal: OPEN_METEO }));
    expect(h.locks).toEqual([`${PERSON} keyring:open-meteo`]);
  });

  describe("a no-step provider's rows are matched by vendor and host coverage", () => {
    const gatewayHarness = () =>
      harness({
        providers: (broker) => [
          createGatewayProvider({
            hosts: ["api.example.com"],
            upstreamUrl: "https://gateway.example.com",
            headerName: "x-identity",
            headerValue: "secret",
          }),
          broker,
          keyringProvider,
        ],
      });
    const V1 = {
      vendor: "example",
      displayName: "Example",
      primaryHost: "https://api.example.com/v1",
      scheme: "bearer",
    };
    const V2 = { ...V1, primaryHost: "https://api.example.com/v2" };

    it("a proposal at another primary host of the same hosts reuses the live row", async () => {
      const h = gatewayHarness();
      const first = await read(await h.app.request("/api/connect", post({ proposal: V1 })));
      expect(first).toMatchObject({ kind: "connected", created: true });
      expect(first.connection.provider).toBe("gateway");
      const second = await read(await h.app.request("/api/connect", post({ proposal: V2 })));
      expect(second).toMatchObject({ kind: "connected", created: false });
      expect(second.connection.id).toBe(first.connection.id);
      expect(rowsOf(h, PERSON)).toHaveLength(1);
      expect(h.locks).toEqual([`${PERSON} gateway:example`, `${PERSON} gateway:example`]);
    });

    it("a revoked row at another primary host is refused with the Reconnect, not doubled", async () => {
      const h = gatewayHarness();
      const first = await read(await h.app.request("/api/connect", post({ proposal: V1 })));
      const row = h.store.connections.get(first.connection.id);
      if (!row) throw new Error("no row");
      h.store.connections.set(row.id, { ...row, revokedAt: new Date() });
      const res = await h.app.request("/api/connect", post({ proposal: V2 }));
      expect(res.status).toBe(409);
      expect((await read(res)).details).toMatchObject({
        reason: "connection_revoked",
        connectionId: row.id,
      });
      expect(rowsOf(h, PERSON)).toHaveLength(1);
    });
  });

  it("full access refuses a row a revoke reached first, rather than writing its approvals back", async () => {
    const h = harness({ revokeBeforeApprovals: true });
    const res = await h.app.request("/api/connect", post({ proposal: OPEN_METEO, access: "full" }));
    expect(res.status).toBe(409);
    expect((await read(res)).details).toMatchObject({ reason: "connection_revoked" });
    expect(approvalsOf(h)).toEqual({ build: [], vendor: [] });
  });

  it("a spent link landed on after its connection was revoked reconnects nothing and restores no access", async () => {
    const h = harness();
    const said = await read(
      await h.app.request("/api/connect", post({ proposal: GMAIL, access: "full" })),
    );
    const success = h.broker.minted.at(-1)?.success ?? "";
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    expect(consoleOutcome(await landing(h, success)).status).toBe("connected");
    const revoked = await h.app.request(`/api/connections/${said.connectId}/revoke`, {
      method: "POST",
      headers: { origin: AUTH_URL },
    });
    expect(revoked.status).toBe(200);
    expect(approvalsOf(h)).toEqual({ build: [], vendor: [] });
    // The provider now holds another account for the person, and the old success URL is landed on.
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_2" });
    const again = consoleOutcome(await landing(h, success));
    expect(again).toMatchObject({ status: "failed", connectId: said.connectId });
    expect(again.message).toContain("revoked since");
    const row = h.store.connections.get(said.connectId);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.providerRef).not.toBe("acct_2");
    expect(approvalsOf(h)).toEqual({ build: [], vendor: [] });
  });

  it("a new link is never taken for spent by an older row revoked during its window", async () => {
    const h = harness();
    const old = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    await landing(h, h.broker.minted.at(-1)?.success ?? "");
    const fresh = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    const freshSuccess = h.broker.minted.at(-1)?.success ?? "";
    // The older row is revoked (and released) while the new link is open.
    h.clock.at += 1_000;
    await h.app.request(`/api/connections/${old.connectId}/revoke`, {
      method: "POST",
      headers: { origin: AUTH_URL },
    });
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_2" });
    const landed = consoleOutcome(await landing(h, freshSuccess));
    expect(landed).toMatchObject({ status: "connected", connectionId: fresh.connectId });
    // A new row of its own: the released one is not reconnected in place under the old id.
    expect(h.store.connections.get(fresh.connectId)?.providerRef).toBe("acct_2");
    expect(h.store.connections.get(old.connectId)?.revokedAt).not.toBeNull();
  });

  it("a link refused because another link claimed its account asks the provider again and claims the next", async () => {
    // A provider whose next answer is stale: it hands out the account another link just claimed,
    // as two links returning together would both be answered.
    const stale = { once: false };
    const h = harness({
      providers: (broker) => {
        if (broker.connect.kind !== "link") throw new Error("not a link provider");
        const link = broker.connect;
        const racing: ConnectionProvider = {
          ...broker,
          connect: {
            ...link,
            complete: async (input) => {
              if (stale.once) {
                stale.once = false;
                return { ok: true, ref: "acct_1", label: null };
              }
              return link.complete(input);
            },
          },
        };
        return [racing, keyringProvider];
      },
    });
    await h.app.request("/api/connect", post({ proposal: GMAIL }));
    const oneSuccess = h.broker.minted.at(-1)?.success ?? "";
    const two = await read(await h.app.request("/api/connect", post({ proposal: GMAIL })));
    const twoSuccess = h.broker.minted.at(-1)?.success ?? "";
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_1" });
    h.broker.connectAccount({ personId: PERSON, target: "gmail", id: "acct_2" });
    expect(consoleOutcome(await landing(h, oneSuccess)).status).toBe("connected");
    stale.once = true;
    const landed = consoleOutcome(await landing(h, twoSuccess));
    expect(landed).toMatchObject({ status: "connected", connectionId: two.connectId });
    expect(h.store.connections.get(two.connectId)?.providerRef).toBe("acct_2");
  });
});
