import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { keyringProvider, toProxyConnection } from "@graft/core";
import {
  createFakeLinkProvider,
  decodeFakeRelaySegment,
  type FakeLinkProvider,
  FakeLinkProviderError,
} from "@graft/core/connection/testing/fake-link-provider";
import {
  createMcpDeps,
  createToolListChangedNotifier,
  executeToolName,
  openAgentSession,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * GRA-59 at the seam where the two doors meet (`connection-handoff.test.ts`'s shape), over
 * `@graft/core`'s fake link provider since the hosted form's broker left for the private package
 * (GRA-103): an agent's MCP session proposes Gmail, the console's button asks the server to mint
 * the provider's link for the ask, the person's return — the browser arriving from the provider's
 * page with the signed state — makes the connection once the provider lists the account, and what
 * is asserted is what each side then sees: the tool's `connected`, the connection in the person's
 * list with the provider and no credential, the requesting agent's scope, and the execute tool's
 * call leaving for the provider's upstream with the vendor URL encoded in its path rather than for
 * Google. Then the failure paths — the provider's error redirect, a state that is not Graft's, a
 * landing repeated — and the revoke that releases the account at the provider, records a release
 * that failed, and retries it from the card.
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

/**
 * The console's two shapes of request under `/api`, both naming an origin this deployment serves
 * the console on, which here is the server's own, as it is wherever the console is served
 * same-origin (`console.ts`). Without one the origin check refuses the call (GRA-148,
 * `origin-guard.ts`), and `POST /pending-actions/:id/link` reads a JSON body besides, so a bare
 * `POST` is not what the console sends it.
 */
const linkPost = (body: Record<string, unknown> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: AUTH_URL },
  body: JSON.stringify(body),
});

/** A mutation with no body, a revoke or a release, from the same origin. */
const from = (method: "POST" | "PUT" | "DELETE") => ({ method, headers: { origin: AUTH_URL } });
const UPSTREAM_TOKEN = "fake-broker-upstream-token";
const GMAIL_HOSTS = new Set(["gmail.googleapis.com", "www.googleapis.com"]);

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
let broker: FakeLinkProvider;
let app: ReturnType<typeof createServer>;
let mcp: ReturnType<typeof createMcpDeps>;
/** What the API's analytics seam was told, per test (GRA-147). */
let analyticsSpy:
  | ((event: { event: string; properties?: Record<string, unknown> }) => void)
  | null = null;
/** The process's notifier as the API's routes see it: what the link's return announces to. */
const apiNotifier = { changed: vi.fn() };

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  // The broker's coverage rule, as the hosted provider applies it from its catalogue: every
  // proposed host in the vendor's own set, since the relay injects the account's token into
  // whatever vendor URL it is handed.
  broker = createFakeLinkProvider({
    name: "broker",
    covers: (vendor, hosts) => vendor === "gmail" && hosts.every((host) => GMAIL_HOSTS.has(host)),
    upstreamUrl: "https://broker.fake/proxy",
    upstreamToken: UPSTREAM_TOKEN,
  });
  const providers = [broker, keyringProvider];
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

  store.addAgent({
    scopeMode: "listed",
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    name: "laptop Hermes",
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_B,
    personId: PERSON,
    token: TOKEN_B,
    name: "server OpenClaw",
  });

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
      notifier: apiNotifier,
      analytics: {
        name: "spy",
        shutdown: async () => {},
        capture: (event) => {
          analyticsSpy?.(event as { event: string; properties?: Record<string, unknown> });
        },
      },
    },
    mcp,
  });
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

beforeEach(() => {
  analyticsSpy = null;
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

describe("a Gmail connection through a link provider: the ask, the button, the return, the relay", () => {
  let actionId = "";
  let connectionId = "";

  it("the agent's proposal is routed to the link provider: a link ask with the target named, no redirect URI, and nothing minted yet", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({
        error: "awaiting_connection",
        provider: "broker",
        url: expect.stringContaining(`${CONSOLE_URL}/pending/`),
      });
      expect(said.redirectUri).toBeUndefined();
      expect(said.message).toContain("through broker");
      actionId = said.pendingActionId as string;
      expect(store.pendingActions.get(actionId)?.payload).toMatchObject({
        provider: "broker",
        providerConnect: "link",
        providerTarget: "gmail",
        vendor: "gmail",
        primaryHost: "https://gmail.googleapis.com/gmail/v1",
        hosts: ["gmail.googleapis.com", "www.googleapis.com"],
      });
      expect(broker.minted).toHaveLength(0);
      expect(await listConnections()).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("the console's button mints the provider's link for the person, with this server's return route as both redirect URIs", async () => {
    const res = await app.request(`/api/pending-actions/${actionId}/link`, linkPost());
    expect(res.status).toBe(200);
    const started = (await res.json()) as { url: string; expiresAt: string; provider: string };
    expect(started.provider).toBe("broker");
    const link = new URL(started.url);
    expect(link.searchParams.get("app")).toBe("gmail");
    expect(link.searchParams.get("token")).toMatch(/^ltok_/);
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const minted = broker.minted.at(-1);
    expect(minted?.personId).toBe(PERSON);
    expect(minted?.target).toBe("gmail");
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

  /**
   * GRA-147: a provider whose `start` fails is not a dead end. On an ask of its own — the suite's
   * shared ask is a link ask to the end — the ask moves onto the keyring in place: same row, same
   * link; the button answers the fallback, the agent's repeated call is worded for the form, and
   * a second press finds a keyring ask.
   */
  it("a provider that cannot start its link steps aside: the ask becomes the keyring's form in place, the button says so, and the agent's repeated call is worded for the form", async () => {
    const captured: { event: string; properties?: Record<string, unknown> }[] = [];
    analyticsSpy = (event) => captured.push(event);
    const proposal = { ...PROPOSAL, displayName: "Gmail (provider down)" };
    const a = await connect(TOKEN_A);
    try {
      const asked = body(await a.call("request_connection", proposal));
      expect(asked).toMatchObject({ error: "awaiting_connection", provider: "broker" });
      const id = asked.pendingActionId as string;

      broker.failNext(new FakeLinkProviderError("the broker refused to mint (fake)"));
      const res = await app.request(`/api/pending-actions/${id}/link`, from("POST"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        fallback: "form",
        provider: "broker",
        message: "broker could not start its sign-in",
      });
      const row = store.pendingActions.get(id);
      expect(row?.answeredAt).toBeNull();
      expect(row?.payload).toMatchObject({
        provider: "keyring",
        providerConnect: "form",
        providerTarget: null,
        vendor: "gmail",
        scheme: "oauth_authorization_code",
        providerFallback: { from: "broker", at: expect.any(String) },
      });
      // The provider's own words are not kept on the row nor returned (Greptile on #120).
      expect(JSON.stringify(row?.payload)).not.toContain("refused to mint");
      expect(String(row?.payload.note)).toContain("broker could not start its sign-in");
      expect(captured.map((e) => e.event)).toEqual(["provider_link_fell_back"]);

      // The agent's repeated call reuses the same ask and is worded for the form, naming no broker.
      const answer = body(await a.call("request_connection", proposal));
      expect(answer).toMatchObject({ error: "awaiting_connection", pendingActionId: id });
      expect(String(answer.message)).not.toContain("broker");
      expect(String(answer.message)).toContain("OAuth client");
      expect(answer.provider).toBeUndefined();

      // A second press finds a keyring ask and is refused as the form's: the fallback is once.
      const pressed = await app.request(`/api/pending-actions/${id}/link`, from("POST"));
      expect(pressed.status).toBe(400);
      expect(String(((await pressed.json()) as { message: string }).message)).toContain("keyring");
    } finally {
      await a.close();
    }
  });

  it("a minted link and a return are counted per provider and outcome", async () => {
    const captured: { event: string; properties?: Record<string, unknown> }[] = [];
    analyticsSpy = (event) => captured.push(event);
    // A second press on the suite's ask: a fresh link, which the next test's return then uses.
    const res = await app.request(`/api/pending-actions/${actionId}/link`, from("POST"));
    expect(res.status).toBe(200);
    const minted = broker.minted.at(-1);
    // A minted link is said on the row, so a start from the other door that fails a moment later
    // finds it written and leaves it the provider's.
    expect(store.pendingActions.get(actionId)?.payload.linkStartedAt).toEqual(expect.any(String));
    // The provider's own error redirect: counted as a failed return, and the ask stays open.
    await app.request(minted?.error ?? "");
    expect(captured.map((e) => [e.event, e.properties?.provider, e.properties?.outcome])).toEqual([
      ["provider_link_started", "broker", undefined],
      ["provider_link_returned", "broker", "failed"],
    ]);
    expect(store.pendingActions.get(actionId)?.answeredAt).toBeNull();
  });

  it("the provider's error redirect leaves the ask open with the reason, and a return before any account was connected does too", async () => {
    const minted = broker.minted.at(-1);
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
    // The console's link carries no `from`, so its landing page stays up for the person.
    expect(errored.from).toBeUndefined();
  });

  it("a return whose link the ask card minted carries from=card through to the console's page (GRA-117), read from the query alone", async () => {
    const minted = broker.minted.at(-1);
    const fromCard = consoleOutcome(await landing(`${minted?.error ?? ""}&from=card`));
    expect(fromCard).toMatchObject({ status: "failed", pendingActionId: actionId, from: "card" });
    // Another word is not the card's, and is not copied.
    const other = consoleOutcome(await landing(`${minted?.error ?? ""}&from=elsewhere`));
    expect(other.from).toBeUndefined();
  });

  it("a state that is not Graft's is refused before anything is read, naming no ask", async () => {
    const forged = consoleOutcome(
      await app.request("/api/providers/link/callback?state=abc.def&outcome=success"),
    );
    expect(forged).toMatchObject({ status: "failed" });
    expect(forged.pendingActionId).toBeUndefined();
    expect(broker.accounts).toHaveLength(0);
  });

  it("the return confirms the account the provider now holds, makes the connection with the account id and no credential, gives it to the requesting agent, and answers the ask", async () => {
    // The person signed in at Google on the provider's page: the provider now holds the account.
    const account = broker.connectAccount({
      personId: PERSON,
      target: "gmail",
      label: "aleks@example.com",
    });
    const minted = broker.minted.at(-1);
    const outcome = consoleOutcome(await landing(minted?.success ?? ""));
    expect(outcome).toMatchObject({
      status: "connected",
      pendingActionId: actionId,
      connectionId: expect.any(String),
      message: expect.stringContaining("connected through broker as aleks@example.com"),
    });
    connectionId = outcome.connectionId as string;

    const [connection] = await listConnections();
    expect(connection).toMatchObject({
      id: connectionId,
      provider: "broker",
      vendor: "gmail",
      scheme: "relay",
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
    // The return announces the row to every session whose scope reaches it (Greptile on #88):
    // A's, on its list; B, on a list without it, is not told.
    expect(apiNotifier.changed.mock.calls.map(([agentId]) => agentId)).toEqual([AGENT_A]);
    apiNotifier.changed.mockClear();

    // The browser landing twice — a refresh — says connected and makes nothing more.
    const again = consoleOutcome(await landing(minted?.success ?? ""));
    expect(again).toMatchObject({ status: "connected", connectionId });
    expect(await listConnections()).toHaveLength(1);
  });

  it("the agent's next call answers connected, and its execute tool's call leaves for the provider's upstream with the vendor URL in the path — never for Google", async () => {
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
      // The runner prints its envelope (GRA-186): the module's result beside the blobs it wrote.
      expect(JSON.parse(String(run.output))).toMatchObject({
        result: { messages: [{ id: "18f1", threadId: "18f1" }] },
        blobs: [],
      });

      const [left] = vendor.requests;
      if (!left) throw new Error("nothing left the proxy");
      const url = new URL(left.url);
      expect(url.origin).toBe("https://broker.fake");
      const segments = url.pathname.split("/");
      expect(segments.slice(0, 3)).toEqual(["", "proxy", "relay"]);
      expect(decodeFakeRelaySegment(segments[3] ?? "")?.href).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
      );
      const ref = store.connections.get(connectionId)?.providerRef;
      expect(url.searchParams.get("account")).toBe(ref);
      expect(left.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TOKEN}`);
      expect(left.headers.get("x-up-account")).toBe(ref);
      expect(left.headers.get("x-graft-token")).toBeNull();
      // The event names the vendor host the call was for and the relay that carried it — the
      // generic scheme, since that is what this provider's plugin calls itself (GRA-103).
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "forwarded",
        host: "gmail.googleapis.com",
        relay: "relay",
      });
    } finally {
      await a.close();
    }
  }, 60_000);

  it("revoke asks the provider to delete the account and forgets its id; a release that fails is on the row, and Retry release clears it", async () => {
    // The provider down: the revoke stands, the failure is recorded, the id is kept for the retry.
    broker.failNext(new FakeLinkProviderError("the broker is unreachable (fake)"));
    const revoked = await app.request(`/api/connections/${connectionId}/revoke`, from("POST"));
    expect(revoked.status).toBe(200);
    const result = (await revoked.json()) as {
      connection: ConnectionWire;
      providerRelease: { provider: string; released: boolean; failure?: string };
    };
    expect(result.providerRelease).toEqual({
      provider: "broker",
      released: false,
      failure: "FakeLinkProviderError",
    });
    expect(result.connection.revokedAt).toEqual(expect.any(String));
    expect(result.connection.providerReleaseFailedAt).toEqual(expect.any(String));
    expect(store.connections.get(connectionId)?.providerRef).toMatch(/^acct_/);
    expect(broker.accounts).toHaveLength(1);

    // The connection stays in the agent's scope awaiting reconnection (ADR 0007), but its execute
    // tool leaves the list (GRA-69), and a client that still names it from a snapshot is refused
    // as connection_revoked before the build approval or the proxy is reached: nothing relays,
    // whatever the provider still holds, and no build approval is needed to see the refusal. The
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

    // Retry from the card: the same release, the mark cleared, the account gone at the provider.
    const retried = await app.request(`/api/connections/${connectionId}/release`, from("POST"));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      providerRelease: { provider: "broker", released: true },
      connection: { providerReleaseFailedAt: null, revokedAt: expect.any(String) },
    });
    expect(store.connections.get(connectionId)?.providerRef).toBeNull();
    expect(broker.deleted).toHaveLength(1);
    expect(broker.accounts).toHaveLength(0);

    // Nothing outstanding now: a second retry is refused, not re-run.
    const nothing = await app.request(`/api/connections/${connectionId}/release`, from("POST"));
    expect(nothing.status).toBe(409);
  });

  it("a fresh link after the revoke reconnects the same row in place — the agent's scope still names it", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({ error: "awaiting_connection", provider: "broker" });
      const newAsk = said.pendingActionId as string;
      expect(newAsk).not.toBe(actionId);
      const started = (await (
        await app.request(`/api/pending-actions/${newAsk}/link`, linkPost())
      ).json()) as { url: string };
      expect(started.url).toContain("app=gmail");
      broker.connectAccount({ personId: PERSON, target: "gmail", label: "aleks@example.com" });
      const outcome = consoleOutcome(await landing(broker.minted.at(-1)?.success ?? ""));
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
    store.addAgent({
      scopeMode: "listed",
      id: "agent_d",
      personId: PERSON,
      token: `${TOKEN_B}d`,
      name: "fourth",
    });
    store.addAgent({
      scopeMode: "listed",
      id: "agent_e",
      personId: PERSON,
      token: `${TOKEN_B}e`,
      name: "fifth",
    });
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
      const started = await app.request(
        `/api/pending-actions/${askD}/link`,
        linkPost({ approveBuild: true }),
      );
      expect(started.status).toBe(200);
      const mintedD = broker.minted.at(-1);
      broker.connectAccount({ personId: PERSON, target: "gmail", label: "d@example.com" });
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
      expect((await app.request(`/api/pending-actions/${askE}/link`, linkPost())).status).toBe(200);
      const mintedE = broker.minted.at(-1);
      broker.connectAccount({ personId: PERSON, target: "gmail", label: "e@example.com" });
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
    const landed: { event: string; properties?: Record<string, unknown> }[] = [];
    analyticsSpy = (event) => landed.push(event);
    // A fresh agent, so the ask is new. The person's existing Gmail connection is not in its scope,
    // which since GRA-104 is the scope ask — a relay provider's row counts as the connection the
    // person already has (GRA-76), and this is Aleks's Claude.ai case of 2026-09-19 — so the row is
    // set aside for the landing this test is about.
    store.addAgent({
      scopeMode: "listed",
      id: "agent_c",
      personId: PERSON,
      token: `${TOKEN_B}c`,
      name: "third",
    });
    const a = await connect(`${TOKEN_B}c`);
    const setAside = [...store.connections.values()].filter((row) => row.vendor === "gmail");
    try {
      const asked = body(await a.call("request_connection", PROPOSAL));
      expect(asked).toMatchObject({
        error: "awaiting_scope",
        reason: "awaiting_scope",
        connectionId: setAside[0]?.id,
        provider: "broker",
        url: expect.stringContaining("/pending/"),
        message: expect.stringContaining("via broker"),
      });
      expect(String(asked.message)).toContain("allow you to use it");
      expect(String(asked.message)).not.toContain("under Scope");
      for (const row of setAside) store.connections.delete(row.id);

      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({ error: "awaiting_connection", provider: "broker" });
      const askId = said.pendingActionId as string;
      await app.request(`/api/pending-actions/${askId}/link`, linkPost());
      const minted = broker.minted.at(-1);
      broker.connectAccount({ personId: PERSON, target: "gmail", label: "aleks@example.com" });
      const before = (await listConnections()).length;

      const [first, second] = await Promise.all([
        landing(minted?.success ?? ""),
        landing(minted?.success ?? ""),
      ]);
      const outcomes = [consoleOutcome(first), consoleOutcome(second)];
      expect(outcomes.map((o) => o.status)).toEqual(["connected", "connected"]);
      // Both landings are counted as connected returns — the loser's read of the winner's answer too.
      expect(
        landed
          .filter((e) => e.event === "provider_link_returned")
          .map((e) => e.properties?.outcome),
      ).toEqual(["connected", "connected"]);
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
      // The keyring's ask: a vendor the link provider does not cover takes the form, and the button says so.
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
      const form = await app.request(
        `/api/pending-actions/${said.pendingActionId}/link`,
        linkPost(),
      );
      expect(form.status).toBe(400);
      expect(await form.json()).toMatchObject({
        message: expect.stringContaining("keyring provider connects a vendor with a credential"),
      });
      const missing = await app.request("/api/pending-actions/pa_nope/link", linkPost());
      expect(missing.status).toBe(404);
      // An ask already answered is 409, as for the submits.
      const answered = await app.request(`/api/pending-actions/${actionId}/link`, linkPost());
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
    // Two things at once (GRA-148). No `authUrl` and no CORS origin, so nothing is trusted by
    // name: `Sec-Fetch-Site` is the browser's own word that the submit is same-origin, and the
    // origin check takes it. And the submit is the bare `POST` a console cached before GRA-75
    // sends, with no body and so no content type to declare, which `emptyIs` still reads as `{}`.
    const started = await bare.request("/api/pending-actions/pa_1/link", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(started.status).toBe(400);
    expect(await started.json()).toMatchObject({
      message: expect.stringContaining("no public URL"),
    });
    expect((await bare.request("/api/providers/link/callback?state=a.b")).status).toBe(404);
  });
});
