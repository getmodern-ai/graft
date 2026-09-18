import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPipedreamProvider, keyringProvider, toProxyConnection } from "@graft/core";
import {
  createMcpDeps,
  createToolListChangedNotifier,
  executeToolName,
  openAgentSession,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { PipedreamError } from "@graft/pipedream";
import { createFakePipedreamClient, type FakePipedreamClient } from "@graft/pipedream/fake";
import { decodePipedreamProxySegment } from "@graft/proxy/pipedream-relay";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * GRA-59 at the seam where the two doors meet (`connection-handoff.test.ts`'s shape): an agent's
 * MCP session proposes Gmail, the console's button asks the server to mint Pipedream's link for the
 * ask, the person's return — the browser arriving from Pipedream's page with the signed state —
 * makes the connection once the fake Pipedream lists the account, and what is asserted is what each
 * side then sees: the tool's `connected`, the connection in the person's list with the provider and
 * no credential, the requesting agent's scope, and the execute tool's call leaving for Pipedream's
 * proxy path with the vendor URL encoded in it rather than for Google. Then the failure paths — the
 * provider's error redirect, a state that is not Graft's, a landing repeated — and the revoke that
 * releases the account at Pipedream, records a release that failed, and retries it from the card.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TOKEN_A = "grft_link_server_test_token_a_000000000000000000000";
const TOKEN_B = "grft_link_server_test_token_b_000000000000000000000";
const SESSION = { user: { id: PERSON } };
const AUTH_URL = "http://graft.test";
const CONSOLE_URL = "http://console.graft.test";
const EXTERNAL_USER = `graft-person-${PERSON}`;

const PROPOSAL = {
  vendor: "gmail",
  displayName: "Gmail",
  primaryHost: "https://gmail.googleapis.com/gmail/v1",
  hosts: ["www.googleapis.com"],
  scheme: "oauth_authorization_code",
  schemeConfig: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
  },
  docsUrl: "https://developers.google.com/gmail/api/reference/rest",
};

const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch("/users/me/messages?maxResults=5");
  if (!res.ok) throw new Error(\`GET messages \${res.status}\`);
  return await res.json();
};
`;
const RUN_LIST = `echo '{}' | node /graft/runner.mjs ${sandboxPath("tools/gmail/list-messages/v1")}`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let pipedream: FakePipedreamClient;
let app: ReturnType<typeof createServer>;
let mcp: ReturnType<typeof createMcpDeps>;

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  pipedream = createFakePipedreamClient({
    projectId: "proj_test",
    apiOrigin: "https://pipedream.fake",
  });
  const providers = [createPipedreamProvider({ client: pipedream }), keyringProvider];
  vendor = await startFakeVendor({
    keys,
    connections: [],
    // The proxy's connection read asks the row's provider how the call resolves (ADR 0019).
    resolve: async (id) => {
      const row = store.connections.get(id);
      return row ? toProxyConnection(row, providers) : null;
    },
    respond: () =>
      Response.json({ messages: [{ id: "18f1", threadId: "18f1" }], resultSizeEstimate: 1 }),
  });
  sandbox = createFakeSandboxBackend();
  const dir = join(sandbox.toolboxRoot(PERSON), "tools/gmail/list-messages/v1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), MODULE);

  store.addAgent({ id: AGENT_A, personId: PERSON, token: TOKEN_A, name: "laptop Hermes" });
  store.addAgent({ id: AGENT_B, personId: PERSON, token: TOKEN_B, name: "server OpenClaw" });

  const fake = createFakeDeps(store);
  const connection = { ...fake.connection, providers };
  const handoff = {
    consoleUrl: CONSOLE_URL,
    secret: "graft-link-server-test-handoff-secret-32-chars",
    waitMs: 0,
    ttlMs: 60_000,
    pollMs: 20,
  };
  mcp = createMcpDeps({
    ...fake,
    connection,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    handoff,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
  });
  app = createServer({
    keys,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: { handler: async () => new Response("auth"), getSession: async () => SESSION },
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
      handoff,
      authUrl: AUTH_URL,
    },
    mcp,
  });
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

beforeEach(() => {
  vendor.requests.length = 0;
});

async function connect(token: string) {
  const notifier = createToolListChangedNotifier();
  const session = await openAgentSession(mcp, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

type ConnectionWire = {
  id: string;
  provider: string;
  vendor: string;
  scheme: string;
  displayName: string;
  hosts: string[];
  primaryHost: string;
  credentialSetAt: string | null;
  providerReleaseFailedAt: string | null;
  revokedAt: string | null;
};

const listConnections = async () =>
  ((await (await app.request("/api/connections")).json()) as { connections: ConnectionWire[] })
    .connections;

const scopeOf = async (agentId: string) =>
  ((await (await app.request(`/api/agents/${agentId}`)).json()) as { connectionIds: string[] })
    .connectionIds;

/** The link's return, as the browser would follow it out of the fake's redirect URIs. */
const landing = (url: string) => {
  const target = new URL(url);
  return app.request(`${target.pathname}${target.search}`);
};

const consoleOutcome = (response: Response) => {
  const location = response.headers.get("location") ?? "";
  expect(response.status).toBe(302);
  expect(location.startsWith(`${CONSOLE_URL}/link/callback?`)).toBe(true);
  return Object.fromEntries(new URL(location).searchParams);
};

describe("a Gmail connection through Pipedream: the ask, the button, the return, the relay", () => {
  let actionId = "";
  let connectionId = "";

  it("the agent's proposal is routed to Pipedream: a link ask with the app named, no redirect URI, and nothing minted yet", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({
        error: "awaiting_connection",
        provider: "pipedream",
        url: expect.stringContaining(`${CONSOLE_URL}/pending/`),
      });
      expect(said.redirectUri).toBeUndefined();
      expect(said.message).toContain("through pipedream");
      actionId = said.pendingActionId as string;
      expect(store.pendingActions.get(actionId)?.payload).toMatchObject({
        provider: "pipedream",
        providerConnect: "link",
        providerTarget: "gmail",
        vendor: "gmail",
        primaryHost: "https://gmail.googleapis.com/gmail/v1",
        hosts: ["gmail.googleapis.com", "www.googleapis.com"],
      });
      expect(pipedream.tokens).toHaveLength(0);
      expect(await listConnections()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("the console's button mints Pipedream's link for the person, with this server's return route as both redirect URIs", async () => {
    const res = await app.request(`/api/pending-actions/${actionId}/link`, { method: "POST" });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { url: string; expiresAt: string; provider: string };
    expect(started.provider).toBe("pipedream");
    const link = new URL(started.url);
    expect(link.searchParams.get("app")).toBe("gmail");
    expect(link.searchParams.get("token")).toMatch(/^ctok_/);
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const minted = pipedream.tokens.at(-1);
    expect(minted?.externalUserId).toBe(EXTERNAL_USER);
    expect(minted?.app).toBe("gmail");
    for (const [uri, outcome] of [
      [minted?.success, "success"],
      [minted?.error, "error"],
    ] as const) {
      const url = new URL(uri ?? "");
      expect(url.origin + url.pathname).toBe(`${AUTH_URL}/api/providers/link/callback`);
      expect(url.searchParams.get("outcome")).toBe(outcome);
      expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
    // The ask is untouched: the return answers it, not the button.
    expect(store.pendingActions.get(actionId)?.answeredAt).toBeNull();
  });

  it("the provider's error redirect leaves the ask open with the reason, and a return before any account was connected does too", async () => {
    const minted = pipedream.tokens.at(-1);
    const errored = consoleOutcome(await landing(minted?.error ?? ""));
    expect(errored).toMatchObject({
      status: "failed",
      pendingActionId: actionId,
      message: expect.stringContaining("did not complete"),
    });
    expect(errored.connectionId).toBeUndefined();

    const early = consoleOutcome(await landing(minted?.success ?? ""));
    expect(early).toMatchObject({
      status: "failed",
      pendingActionId: actionId,
      message: expect.stringContaining("No new gmail account was connected"),
    });
    expect(store.pendingActions.get(actionId)?.answeredAt).toBeNull();
    expect(await listConnections()).toEqual([]);
  });

  it("a state that is not Graft's is refused before anything is read, naming no ask", async () => {
    const forged = consoleOutcome(
      await app.request("/api/providers/link/callback?state=abc.def&outcome=success"),
    );
    expect(forged).toMatchObject({ status: "failed" });
    expect(forged.pendingActionId).toBeUndefined();
    expect(pipedream.accounts).toHaveLength(0);
  });

  it("the return confirms the account Pipedream now holds, makes the connection with the account id and no credential, gives it to the requesting agent, and answers the ask", async () => {
    // The person signed in at Google on Pipedream's page: Pipedream now holds the account.
    const account = pipedream.connect({
      externalUserId: EXTERNAL_USER,
      app: "gmail",
      name: "aleks@example.com",
    });
    const minted = pipedream.tokens.at(-1);
    const outcome = consoleOutcome(await landing(minted?.success ?? ""));
    expect(outcome).toMatchObject({
      status: "connected",
      pendingActionId: actionId,
      connectionId: expect.any(String),
      message: expect.stringContaining("connected through pipedream as aleks@example.com"),
    });
    connectionId = outcome.connectionId as string;

    const [connection] = await listConnections();
    expect(connection).toMatchObject({
      id: connectionId,
      provider: "pipedream",
      vendor: "gmail",
      scheme: "pipedream_connect_proxy",
      displayName: "Gmail",
      primaryHost: "https://gmail.googleapis.com/gmail/v1",
      hosts: ["gmail.googleapis.com", "www.googleapis.com"],
      credentialSetAt: null,
      providerReleaseFailedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(connection)).not.toContain(account.id);
    const row = store.connections.get(connectionId);
    expect(row?.providerRef).toBe(account.id);
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.schemeConfig).toEqual({});

    expect(await scopeOf(AGENT_A)).toEqual([connectionId]);
    expect(await scopeOf(AGENT_B)).toEqual([]);
    expect(store.pendingActions.get(actionId)?.answer).toEqual({ connectionId });

    // The browser landing twice — a refresh — says connected and makes nothing more.
    const again = consoleOutcome(await landing(minted?.success ?? ""));
    expect(again).toMatchObject({ status: "connected", connectionId });
    expect(await listConnections()).toHaveLength(1);
  });

  it("the agent's next call answers connected, and its execute tool's call leaves for Pipedream's proxy with the vendor URL in the path — never for Google", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({
        status: "connected",
        connectionId,
        executeTool: executeToolName(connectionId),
      });
      expect(await a.toolNames()).toContain(executeToolName(connectionId));

      store.grantBuild(AGENT_A, connectionId);
      const result = await a.call(executeToolName(connectionId), { command: RUN_LIST });
      expect(result.isError, JSON.stringify(body(result))).toBeFalsy();
      const run = body(result);
      expect(run).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(String(run.output))).toMatchObject({
        messages: [{ id: "18f1", threadId: "18f1" }],
      });

      const [left] = vendor.requests;
      if (!left) throw new Error("nothing left the proxy");
      const url = new URL(left.url);
      expect(url.origin).toBe("https://pipedream.fake");
      const segments = url.pathname.split("/");
      expect(segments.slice(0, 5)).toEqual(["", "v1", "connect", "proj_test", "proxy"]);
      expect(decodePipedreamProxySegment(segments[5] ?? "")?.href).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
      );
      expect(url.searchParams.get("external_user_id")).toBe(EXTERNAL_USER);
      expect(url.searchParams.get("account_id")).toBe(
        store.connections.get(connectionId)?.providerRef,
      );
      expect(left.headers.get("authorization")).toBe("Bearer fake-connect-access-token");
      expect(left.headers.get("x-pd-environment")).toBe("development");
      expect(left.headers.get("x-graft-token")).toBeNull();
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "forwarded",
        host: "gmail.googleapis.com",
        relay: "pipedream_connect_proxy",
      });
    } finally {
      await a.close();
    }
  }, 60_000);

  it("revoke asks Pipedream to delete the account and forgets its id; a release that fails is on the row, and Retry release clears it", async () => {
    // Pipedream down: the revoke stands, the failure is recorded, the id is kept for the retry.
    pipedream.failNext(new PipedreamError("Pipedream is unreachable (fake)", null));
    const revoked = await app.request(`/api/connections/${connectionId}/revoke`, {
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    const result = (await revoked.json()) as {
      connection: ConnectionWire;
      providerRelease: { provider: string; released: boolean; failure?: string };
    };
    expect(result.providerRelease).toEqual({
      provider: "pipedream",
      released: false,
      failure: "PipedreamError",
    });
    expect(result.connection.revokedAt).toEqual(expect.any(String));
    expect(result.connection.providerReleaseFailedAt).toEqual(expect.any(String));
    expect(store.connections.get(connectionId)?.providerRef).toMatch(/^apn_/);
    expect(pipedream.accounts).toHaveLength(1);

    // The connection stays in the agent's scope awaiting reconnection (ADR 0007), but its execute
    // tool leaves the list (GRA-69), and a client that still names it from a snapshot is refused
    // as connection_revoked before the build approval or the proxy is reached: nothing relays,
    // whatever Pipedream still holds, and no build approval is needed to see the refusal. The
    // proxy answers the same word for a token minted before the revoke (GRA-68); that half is
    // `app.test.ts`, where the binding carries the row's stamp through to the proxy directly.
    const eventsBefore = vendor.events.length;
    const a = await connect(TOKEN_A);
    try {
      expect(await a.toolNames()).not.toContain(executeToolName(connectionId));
      const refused = body(await a.call(executeToolName(connectionId), { command: RUN_LIST }));
      expect(refused).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
        connectionId,
      });
      expect(vendor.requests).toHaveLength(0);
      expect(vendor.events).toHaveLength(eventsBefore);
    } finally {
      await a.close();
    }

    // Retry from the card: the same release, the mark cleared, the account gone at Pipedream.
    const retried = await app.request(`/api/connections/${connectionId}/release`, {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      providerRelease: { provider: "pipedream", released: true },
      connection: { providerReleaseFailedAt: null, revokedAt: expect.any(String) },
    });
    expect(store.connections.get(connectionId)?.providerRef).toBeNull();
    expect(pipedream.deleted).toHaveLength(1);
    expect(pipedream.accounts).toHaveLength(0);

    // Nothing outstanding now: a second retry is refused, not re-run.
    const nothing = await app.request(`/api/connections/${connectionId}/release`, {
      method: "POST",
    });
    expect(nothing.status).toBe(409);
  });

  it("a fresh link after the revoke reconnects the same row in place — the agent's scope still names it", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({ error: "awaiting_connection", provider: "pipedream" });
      const newAsk = said.pendingActionId as string;
      expect(newAsk).not.toBe(actionId);
      const started = (await (
        await app.request(`/api/pending-actions/${newAsk}/link`, { method: "POST" })
      ).json()) as { url: string };
      expect(started.url).toContain("app=gmail");
      pipedream.connect({ externalUserId: EXTERNAL_USER, app: "gmail", name: "aleks@example.com" });
      const outcome = consoleOutcome(await landing(pipedream.tokens.at(-1)?.success ?? ""));
      expect(outcome).toMatchObject({ status: "connected", connectionId });
      const connections = await listConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({ id: connectionId, revokedAt: null });
      expect(body(await a.call("request_connection", PROPOSAL))).toMatchObject({
        status: "connected",
        connectionId,
      });
    } finally {
      await a.close();
    }
  });

  /** GRA-75: the card's build choice rides the signed state and is recorded with the connection the return makes. */
  it("a link started with approveBuild records the asking agent's build approval with the connection it makes; one started bare records none", async () => {
    store.addAgent({ id: "agent_d", personId: PERSON, token: `${TOKEN_B}d`, name: "fourth" });
    store.addAgent({ id: "agent_e", personId: PERSON, token: `${TOKEN_B}e`, name: "fifth" });
    const ticked = await connect(`${TOKEN_B}d`);
    const bare = await connect(`${TOKEN_B}e`);
    // Since GRA-76 a live Gmail row of the person's outside the asking agent's scope is a
    // connection_exists refusal, not a new ask (pinned in the two-landings test below), so each
    // proposal here is made with the person's Gmail rows set aside; they are put back afterwards.
    const setAside: FakeStore["connections"] = new Map();
    const setGmailAside = () => {
      for (const row of [...store.connections.values()].filter((r) => r.vendor === "gmail")) {
        setAside.set(row.id, row);
        store.connections.delete(row.id);
      }
    };
    try {
      setGmailAside();
      const askD = body(await ticked.call("request_connection", PROPOSAL))
        .pendingActionId as string;
      const started = await app.request(`/api/pending-actions/${askD}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approveBuild: true }),
      });
      expect(started.status).toBe(200);
      const mintedD = pipedream.tokens.at(-1);
      pipedream.connect({ externalUserId: EXTERNAL_USER, app: "gmail", name: "d@example.com" });
      const outcomeD = consoleOutcome(await landing(mintedD?.success ?? ""));
      expect(outcomeD).toMatchObject({ status: "connected", pendingActionId: askD });
      const connectionD = outcomeD.connectionId as string;
      expect([...store.buildApprovals.values()].filter((row) => row.agentId === "agent_d")).toEqual(
        [expect.objectContaining({ agentId: "agent_d", connectionId: connectionD })],
      );

      // The bare POST an older console sends: the choice is off, and nothing is recorded. D's new
      // row would cover E's proposal too, so it is set aside with the rest.
      setGmailAside();
      const askE = body(await bare.call("request_connection", PROPOSAL)).pendingActionId as string;
      expect(
        (await app.request(`/api/pending-actions/${askE}/link`, { method: "POST" })).status,
      ).toBe(200);
      const mintedE = pipedream.tokens.at(-1);
      pipedream.connect({ externalUserId: EXTERNAL_USER, app: "gmail", name: "e@example.com" });
      const outcomeE = consoleOutcome(await landing(mintedE?.success ?? ""));
      expect(outcomeE).toMatchObject({ status: "connected", pendingActionId: askE });
      expect([...store.buildApprovals.values()].some((row) => row.agentId === "agent_e")).toBe(
        false,
      );
    } finally {
      await ticked.close();
      await bare.close();
      for (const row of setAside.values()) store.connections.set(row.id, row);
    }
  });

  it("two landings of one link at once make one connection — the database refuses the second claim and it reads the ask the first answered", async () => {
    // A fresh agent, so the ask is new. The person's existing Gmail connection is not in its scope,
    // which since GRA-76 is a refusal naming the row and the scope step — a relay provider's row
    // counts as the connection the person already has — so the row is set aside for the landing.
    store.addAgent({ id: "agent_c", personId: PERSON, token: `${TOKEN_B}c`, name: "third" });
    const a = await connect(`${TOKEN_B}c`);
    const setAside = [...store.connections.values()].filter((row) => row.vendor === "gmail");
    try {
      const refused = body(await a.call("request_connection", PROPOSAL));
      expect(refused).toMatchObject({
        error: "refused",
        reason: "connection_exists",
        connectionId: setAside[0]?.id,
        provider: "pipedream",
        inScope: false,
        message: expect.stringContaining("under Scope"),
      });
      for (const row of setAside) store.connections.delete(row.id);

      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({ error: "awaiting_connection", provider: "pipedream" });
      const askId = said.pendingActionId as string;
      await app.request(`/api/pending-actions/${askId}/link`, { method: "POST" });
      const minted = pipedream.tokens.at(-1);
      pipedream.connect({ externalUserId: EXTERNAL_USER, app: "gmail", name: "aleks@example.com" });
      const before = (await listConnections()).length;

      const [first, second] = await Promise.all([
        landing(minted?.success ?? ""),
        landing(minted?.success ?? ""),
      ]);
      const outcomes = [consoleOutcome(first), consoleOutcome(second)];
      expect(outcomes.map((o) => o.status)).toEqual(["connected", "connected"]);
      expect(new Set(outcomes.map((o) => o.connectionId)).size).toBe(1);
      expect((await listConnections()).length).toBe(before + 1);
      const refs = [...store.connections.values()].map((r) => r.providerRef).filter(Boolean);
      expect(new Set(refs).size).toBe(refs.length);
    } finally {
      await a.close();
      for (const row of setAside) store.connections.set(row.id, row);
    }
  });

  it("an ask of another kind, a keyring ask and an unknown ask refuse the button with the answer route's codes", async () => {
    const a = await connect(TOKEN_B);
    try {
      // The keyring's ask: a vendor Pipedream does not cover takes the form, and the button says so.
      const said = body(
        await a.call("request_connection", {
          ...PROPOSAL,
          vendor: "acme",
          primaryHost: "https://api.acme.example",
          hosts: [],
          scheme: "api_key_header",
          schemeConfig: { headerName: "x-acme-key" },
        }),
      );
      expect(said).toMatchObject({ error: "awaiting_connection" });
      expect(said.provider).toBeUndefined();
      const form = await app.request(`/api/pending-actions/${said.pendingActionId}/link`, {
        method: "POST",
      });
      expect(form.status).toBe(400);
      expect(await form.json()).toMatchObject({
        message: expect.stringContaining("keyring provider connects a vendor with a credential"),
      });
      const missing = await app.request("/api/pending-actions/pa_nope/link", { method: "POST" });
      expect(missing.status).toBe(404);
      // An ask already answered is 409, as for the submits.
      const answered = await app.request(`/api/pending-actions/${actionId}/link`, {
        method: "POST",
      });
      expect(answered.status).toBe(409);
    } finally {
      await a.close();
    }
  });
});

describe("a server with no public URL", () => {
  it("cannot start a link and says so, and mounts no return route", async () => {
    const fake = createFakeDeps(createFakeStore());
    const bare = createServer({
      keys: null,
      vault: { decrypt: async () => ({}) },
      connections: { get: async () => null },
      followRedirects: false,
      api: {
        auth: { handler: async () => new Response("auth"), getSession: async () => SESSION },
        deps: { ...fake, modelKey: fakeModelKeyDeps() },
        corsOrigins: [],
        handoff: { consoleUrl: CONSOLE_URL, secret: "x".repeat(32) },
      },
    });
    const started = await bare.request("/api/pending-actions/pa_1/link", { method: "POST" });
    expect(started.status).toBe(400);
    expect(await started.json()).toMatchObject({
      message: expect.stringContaining("no public URL"),
    });
    expect((await bare.request("/api/providers/link/callback?state=a.b")).status).toBe(404);
  });
});
