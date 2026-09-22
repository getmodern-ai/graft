import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pkceChallenge, toProxyConnection } from "@graft/core";
import {
  createMcpDeps,
  createToolListChangedNotifier,
  executeToolName,
  openAgentSession,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import type { UpstreamRequest } from "@graft/proxy";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createServer } from "./app";
import { createDatabaseCredentialRotation } from "./connections";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * GRA-30's acceptance criteria where the three doors meet (`connection-handoff.test.ts`'s shape,
 * ADR 0005): an agent's MCP session proposes an OAuth connection; the person submits the client id
 * and secret over the JSON API and is handed an authorize URL; the vendor — a fake OAuth provider
 * whose token endpoint and API both answer from a script — sends the browser to the callback with a
 * code; the callback exchanges it with PKCE and the client secret, stores the tokens beside the
 * secret, answers the ask, and the waiting tool says connected. Then the proxy injects the token,
 * refreshes it through `apps/server`'s own binding when the vendor refuses it and stores the rotated
 * record, marks the connection for re-consent when the refresh is refused while the vendor's 401
 * reaches the tool, and a revoke clears it all. Nothing any API answers, and nothing the callback's
 * redirect to the console carries, is a token, a secret, the code or the verifier.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const AGENT_A = "agent_a";
const TOKEN_A = "grft_oauth_server_test_token_a_0000000000000000000";
const SESSION = { user: { id: PERSON } };
const AUTH_URL = "http://graft.test";
const CONSOLE_URL = "http://console.graft.test";
const REDIRECT_URI = "http://graft.test/api/oauth/callback";
const TOKEN_URL = "https://oauth2.vendor.example/token";
const MESSAGES = { messages: [{ id: "m1", subject: "Hello" }] };

const PROPOSAL = {
  vendor: "mail",
  displayName: "Mail",
  primaryHost: "https://mail.vendor.example",
  scheme: "oauth_authorization_code",
  schemeConfig: {
    authorizeUrl: "https://accounts.vendor.example/o/oauth2/auth",
    tokenUrl: TOKEN_URL,
    scopes: "mail.readonly",
  },
  docsUrl: "https://developer.vendor.example/oauth",
};

const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch("/v1/messages");
  if (!res.ok) throw new Error(\`GET /v1/messages \${res.status}\`);
  return await res.json();
};
`;
const RUN = `echo '{}' | node /graft/runner.mjs ${sandboxPath("tools/mail/list-messages/v1")}`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let app: ReturnType<typeof createServer>;
let mcp: ReturnType<typeof createMcpDeps>;

/** The fake provider's script, settable per test: what the token endpoint and the API answer. */
let issued = 0;
let tokenEndpoint: (request: UpstreamRequest) => Response = () => tokenResponse();
let api: (token: string | null) => Response = () => Response.json(MESSAGES);
/** The exchanges the callback made, through the server's own fetch seam. */
const exchanges: UpstreamRequest[] = [];
/** A connection id whose next locked read finds it revoked: a revoke committing just before the lock is granted. */
let revokeAtLock: string | null = null;
/** The connection deps the server was built with, for the spies on its locked read and its write. */
let connectionDeps: ReturnType<typeof createFakeDeps>["connection"];
/** The process's notifier as the API's routes see it: what a connect or a reconnection announces to. */
const apiNotifier = { changed: vi.fn() };
const announced = () => apiNotifier.changed.mock.calls.map(([agentId]) => agentId);

function tokenResponse(overrides: Record<string, unknown> = {}) {
  issued += 1;
  return Response.json({
    access_token: `access-${issued}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: `refresh-${issued}`,
    ...overrides,
  });
}

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  const fake = createFakeDeps(store);
  const connection = {
    ...fake.connection,
    // Spied, so a test can see the callback classify a reconnection from the row *locked* — and
    // play a revoke landing at the moment the lock is granted (`revokeAtLock`).
    findConnectionForUpdate: vi.fn(async (db, personId: string, id: string) => {
      if (revokeAtLock === id) {
        revokeAtLock = null;
        const row = store.connections.get(id);
        if (row) store.connections.set(id, { ...row, revokedAt: new Date() });
      }
      return fake.connection.findConnectionForUpdate(db, personId, id);
    }),
    setConnectionCredential: vi.fn(fake.connection.setConnectionCredential),
    vault: {
      encrypt: (
        fields: Record<string, string>,
        scope: { personId: string; connectionId: string },
      ) => vendor.vault.encrypt(fields, scope),
    },
  };
  connectionDeps = connection;
  vendor = await startFakeVendor({
    keys,
    connections: [],
    resolve: async (id) => {
      const row = store.connections.get(id);
      return row ? toProxyConnection(row) : null;
    },
    // The real binding over the fake store: a refresh through the proxy lands in the row.
    rotation: createDatabaseCredentialRotation(fake.db, connection),
    respond: (request) => {
      if (request.url === TOKEN_URL) return tokenEndpoint(request);
      const authorization = request.headers.get("authorization");
      return api(authorization ? authorization.replace(/^Bearer /, "") : null);
    },
  });
  sandbox = createFakeSandboxBackend();
  const dir = join(sandbox.toolboxRoot(PERSON), "tools/mail/list-messages/v1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), MODULE);

  store.addAgent({
    scopeMode: "listed",
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    name: "laptop Hermes",
  });

  const handoff = {
    consoleUrl: CONSOLE_URL,
    secret: "graft-oauth-server-test-handoff-secret-32-chars",
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
    oauthRedirectUri: REDIRECT_URI,
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
      // The origin the console submits from, which the origin check reads (GRA-148).
      authUrl: AUTH_URL,
      handoff,
      notifier: apiNotifier,
      oauth: {
        authUrl: AUTH_URL,
        decrypt: (ciphertext, scope) => vendor.vault.decrypt(ciphertext, scope),
        upstreamFetch: async (request) => {
          exchanges.push(request);
          return tokenEndpoint(request);
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

/**
 * Every state-changing request under `/api` names an origin this deployment serves the console on
 * (GRA-148, `origin-guard.ts`); here that is the server's own, as it is wherever the console is
 * served same-origin (`console.ts`).
 */
const json = (value: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", origin: AUTH_URL },
  body: JSON.stringify(value),
});

/** A mutation with no body, a revoke, from the same origin. */
const from = (method: "POST" | "PUT" | "DELETE") => ({ method, headers: { origin: AUTH_URL } });

type ConnectionWire = {
  id: string;
  scheme: string;
  credentialSetAt: string | null;
  revokedAt: string | null;
  oauth: {
    status: string;
    consentedAt: string | null;
    expiresAt: string | null;
    refreshedAt: string | null;
    consentRequired: { at: string; reason: string } | null;
  } | null;
};

const listConnections = async () =>
  ((await (await app.request("/api/connections")).json()) as { connections: ConnectionWire[] })
    .connections;

const decode = (bytes: Uint8Array | null) =>
  new URLSearchParams(new TextDecoder().decode(bytes ?? new Uint8Array()));

/** The vendor "sends the browser back": the callback, as a top-level GET with no session. */
const callback = (query: Record<string, string>) =>
  app.request(`/api/oauth/callback?${new URLSearchParams(query)}`);

/**
 * Where the callback sends the browser on (GRA-48): a redirect to the console's `/oauth/callback`
 * under the handoff's console URL, with the outcome in its query and nothing else in it — the
 * status word, the connection when the state named one, and the sentence the console shows.
 */
function landing(res: Response) {
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get("location") as string);
  expect(`${url.origin}${url.pathname}`).toBe(`${CONSOLE_URL}/oauth/callback`);
  for (const key of url.searchParams.keys()) {
    expect(["status", "connectionId", "message"], key).toContain(key);
  }
  return {
    href: url.href,
    status: url.searchParams.get("status"),
    connectionId: url.searchParams.get("connectionId"),
    message: url.searchParams.get("message") ?? "",
  };
}

/** Every string that must appear in no answer and no page. */
const SECRETS = ["client-secret-value", "access-", "refresh-", "code_verifier", "verifier"];

function expectNoSecret(text: string) {
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
}

/** The PKCE verifier the consent's start wrote on the row — what the callback exchanges the code with. */
function verifierOf(connectionId: string): string {
  const state = store.connections.get(connectionId)?.oauthRefreshState as
    | { pkce?: { verifier: string } }
    | null
    | undefined;
  if (!state?.pkce) throw new Error(`no consent in progress for ${connectionId}`);
  return state.pkce.verifier;
}

/** Decrypt a row's record the way the proxy does — the test holds the vault the service encrypts with. */
async function storedRecord(connectionId: string) {
  const row = store.connections.get(connectionId);
  if (!row?.credentialCiphertext) return null;
  return vendor.vault.decrypt(row.credentialCiphertext, { personId: PERSON, connectionId });
}

describe("an OAuth connection proposed over MCP, consented in the browser, called through the proxy", () => {
  let connectionId = "";
  let actionId = "";

  it("the agent gets the link and the redirect URI; the redirect URI the form fetches is the callback's own", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = body(await a.call("request_connection", PROPOSAL));
      expect(said).toMatchObject({
        error: "awaiting_connection",
        redirectUri: REDIRECT_URI,
        pendingActionId: expect.any(String),
      });
      actionId = said.pendingActionId as string;
      expect(String(said.message)).toContain(REDIRECT_URI);

      const shown = await app.request("/api/oauth/redirect-uri");
      expect(shown.status).toBe(200);
      expect(await shown.json()).toEqual({ redirectUri: REDIRECT_URI });
      expect(new URL(REDIRECT_URI).pathname).toBe("/api/oauth/callback");
    } finally {
      await a.close();
    }
  });

  it("the submit stores the client secret, gives the connection to the agent, leaves the ask open and hands back an authorize URL with PKCE and a signed state", async () => {
    const submitted = await app.request(
      `/api/pending-actions/${actionId}/connection`,
      json({
        ...PROPOSAL,
        schemeConfig: { ...PROPOSAL.schemeConfig, clientId: "client-id-value" },
        credential: { clientSecret: "client-secret-value" },
      }),
    );
    expect(submitted.status).toBe(201);
    const text = await submitted.text();
    expectNoSecret(text);
    const result = JSON.parse(text) as {
      connection: ConnectionWire;
      pendingAction: { answeredAt: string | null };
      authorizeUrl: string;
    };
    connectionId = result.connection.id;
    expect(result.connection.oauth).toMatchObject({
      status: "awaiting_consent",
      consentedAt: null,
    });
    expect(result.connection.credentialSetAt).toEqual(expect.any(String));
    expect(result.pendingAction.answeredAt).toBeNull();

    const url = new URL(result.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.vendor.example/o/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id-value");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("mail.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // The verifier is on the row, never in the URL or any answer; its challenge is.
    const verifier = verifierOf(connectionId);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(verifier));
    expect(text).not.toContain(verifier);

    const scope = (await (await app.request(`/api/agents/${AGENT_A}`)).json()) as {
      connectionIds: string[];
    };
    expect(scope.connectionIds).toEqual([connectionId]);
    // The row entered A's list the moment the submit made it — before any consent — and the
    // submit is what tells A's session (`connected.ts`); the callback later adds nothing.
    expect(announced()).toEqual([AGENT_A]);
    apiNotifier.changed.mockClear();

    // Before the consent: the agent's call still waits, and the proxy refuses the vendor call.
    const a = await connect(TOKEN_A);
    try {
      expect(body(await a.call("request_connection", PROPOSAL))).toMatchObject({
        error: "awaiting_connection",
        pendingActionId: actionId,
      });
      store.grantBuild(AGENT_A, connectionId);
      const run = body(await a.call(executeToolName(connectionId), { command: RUN }));
      expect(run.exitCode).not.toBe(0);
      expect(String(run.output)).toContain("409");
      expect(vendor.events.at(-1)).toMatchObject({ outcome: "consent_required", status: 409 });
    } finally {
      await a.close();
    }
  });

  it("a tampered state and a vendor error each send the browser to the console with the refusal, store nothing and keep the ask open", async () => {
    const authorize = new URL(
      (
        (await (
          await app.request(
            `/api/connections/${connectionId}/oauth/authorize-url`,
            json({ pendingActionId: actionId }),
          )
        ).json()) as { authorizeUrl: string }
      ).authorizeUrl,
    );
    const state = authorize.searchParams.get("state") as string;

    // An unverifiable state names no connection, so no waiting console takes the message as its own.
    const tampered = landing(await callback({ code: "c", state: `${state}x` }));
    expect(tampered.status).toBe("failed");
    expect(tampered.connectionId).toBeNull();
    expect(tampered.message).toContain("not one Graft issued");
    expect(tampered.href).not.toContain(state);

    const declined = landing(await callback({ error: "access_denied", state }));
    expect(declined).toMatchObject({
      status: "declined",
      connectionId,
      message: expect.stringContaining("You declined to connect Mail"),
    });
    expect(declined.href).not.toContain(state);

    expect(exchanges).toHaveLength(0);
    expect((await listConnections())[0]?.oauth?.status).toBe("awaiting_consent");
    expect(store.pendingActions.get(actionId)?.answeredAt).toBeNull();
  });

  it("the callback exchanges the code with PKCE and the client secret, stores the tokens, answers the ask, and the tool says connected", async () => {
    const authorize = new URL(
      (
        (await (
          await app.request(
            `/api/connections/${connectionId}/oauth/authorize-url`,
            json({ pendingActionId: actionId }),
          )
        ).json()) as { authorizeUrl: string }
      ).authorizeUrl,
    );
    const state = authorize.searchParams.get("state") as string;
    const verifier = verifierOf(connectionId);

    const landed = landing(await callback({ code: "the-code", state }));
    expect(landed).toMatchObject({
      status: "connected",
      connectionId,
      message: expect.stringContaining("Mail is connected"),
    });
    // The query is the status word, the connection and the sentence; the code and the state that
    // arrived, the verifier and what the token endpoint answered all stay on this side.
    expectNoSecret(landed.href);
    expect(landed.href).not.toContain("the-code");
    expect(landed.href).not.toContain(state);

    // The exchange: RFC 6749 §4.1.3 with RFC 7636's verifier, the client in the body.
    expect(exchanges).toHaveLength(1);
    const exchange = exchanges[0] as UpstreamRequest;
    expect(exchange.url).toBe(TOKEN_URL);
    expect(exchange.method).toBe("POST");
    const form = decode(exchange.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(form.get("code_verifier")).toBe(verifier);
    expect(form.get("client_id")).toBe("client-id-value");
    expect(form.get("client_secret")).toBe("client-secret-value");

    // Stored as one record beside the client secret; the verifier gone; the public shape says connected.
    expect(await storedRecord(connectionId)).toEqual({
      clientSecret: "client-secret-value",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: expect.any(String),
    });
    const row = store.connections.get(connectionId);
    expect(row?.oauthRefreshState).toEqual({
      consentedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    const connections = await listConnections();
    expect(connections[0]?.oauth).toMatchObject({
      status: "connected",
      consentedAt: expect.any(String),
    });
    expectNoSecret(JSON.stringify(connections));

    // The ask is answered by the callback; the waiting tool takes it. Neither announces: the list
    // gained the execute tool when the submit made the row, and the tokens change no list
    // (Greptile on #88, twice: the settle's repeat and the callback's silence).
    expect(store.pendingActions.get(actionId)?.answer).toEqual({ connectionId });
    expect(announced()).toEqual([]);
    const a = await connect(TOKEN_A);
    try {
      const connected = await a.call("request_connection", PROPOSAL);
      expect(connected.isError).toBeFalsy();
      expect(body(connected)).toMatchObject({
        status: "connected",
        connectionId,
        executeTool: executeToolName(connectionId),
      });
      expectNoSecret(JSON.stringify(body(connected)));

      // The execute tool reaches the fake provider's API with the access token injected.
      const run = body(await a.call(executeToolName(connectionId), { command: RUN }));
      expect(run.exitCode, JSON.stringify(run)).toBe(0);
      // The runner prints its envelope (GRA-186): the module's result beside the blobs it wrote.
      expect(JSON.parse(String(run.output))).toEqual({ result: MESSAGES, blobs: [] });
      const request = vendor.requests.at(-1);
      expect(request?.url).toBe("https://mail.vendor.example/v1/messages");
      expect(request?.headers.get("authorization")).toBe("Bearer access-1");
      expect(vendor.events.at(-1)).toMatchObject({ outcome: "forwarded", oauth: null });
    } finally {
      await a.close();
    }
  });

  it("a vendor 401 is refreshed through the server's binding: the rotated record lands in the row, the call succeeds, the event says refreshed", async () => {
    api = (token) =>
      token === "access-1"
        ? Response.json({ error: "invalid_credentials" }, { status: 401 })
        : Response.json(MESSAGES);
    const a = await connect(TOKEN_A);
    try {
      const run = body(await a.call(executeToolName(connectionId), { command: RUN }));
      expect(run.exitCode, JSON.stringify(run)).toBe(0);
      const refresh = vendor.requests.find((r) => r.url === TOKEN_URL) as UpstreamRequest;
      const form = decode(refresh.body);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("refresh-1");
      expect(form.get("client_secret")).toBe("client-secret-value");
      expect(vendor.requests.at(-1)?.headers.get("authorization")).toBe("Bearer access-2");
      expect(vendor.events.at(-1)).toMatchObject({ outcome: "forwarded", oauth: "refreshed" });

      expect(await storedRecord(connectionId)).toEqual({
        clientSecret: "client-secret-value",
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: expect.any(String),
      });
      const listed = (await listConnections())[0];
      expect(listed?.oauth).toMatchObject({ status: "connected", refreshedAt: expect.any(String) });
      expectNoSecret(JSON.stringify(listed));
    } finally {
      await a.close();
    }
  });

  it("a refresh the vendor refuses lets its 401 reach the tool, marks the connection for re-consent, and Reconnect clears the mark", async () => {
    api = (token) =>
      token === "access-2"
        ? Response.json({ error: "revoked" }, { status: 401 })
        : Response.json(MESSAGES);
    tokenEndpoint = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const a = await connect(TOKEN_A);
    try {
      const run = body(await a.call(executeToolName(connectionId), { command: RUN }));
      expect(run.exitCode).not.toBe(0);
      expect(String(run.output)).toContain("401");
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "forwarded",
        upstreamStatus: 401,
        oauth: "refresh_failed",
      });
      const listed = (await listConnections())[0];
      expect(listed?.oauth).toMatchObject({
        status: "consent_required",
        consentRequired: { reason: expect.stringContaining("could not be refreshed") },
      });
      expect(String(listed?.oauth?.consentRequired?.reason)).not.toContain("invalid_grant");

      // Reconnect: a fresh consent with the client secret still in place, no ask behind it.
      tokenEndpoint = () => tokenResponse();
      const started = (await (
        await app.request(`/api/connections/${connectionId}/oauth/authorize-url`, json({}))
      ).json()) as { authorizeUrl: string };
      const state = new URL(started.authorizeUrl).searchParams.get("state") as string;
      expect(landing(await callback({ code: "again", state })).status).toBe("connected");
      const after = (await listConnections())[0];
      expect(after?.oauth).toMatchObject({ status: "connected", consentRequired: null });
      api = () => Response.json(MESSAGES);
      const ok = body(await a.call(executeToolName(connectionId), { command: RUN }));
      expect(ok.exitCode, JSON.stringify(ok)).toBe(0);
      expect(vendor.requests.at(-1)?.headers.get("authorization")).toBe("Bearer access-3");
    } finally {
      await a.close();
    }
  });

  it("request_credential on an OAuth connection is answered by a consent, not a typed secret", async () => {
    const a = await connect(TOKEN_A);
    try {
      const asked = body(await a.call("request_credential", { connectionId, reason: "401" }));
      expect(asked).toMatchObject({
        error: "awaiting_credential",
        pendingActionId: expect.any(String),
      });
      const askId = asked.pendingActionId as string;

      // A consent for another connection's ask is refused; this connection's proceeds.
      const other = store.addConnection({
        id: "conn_other",
        personId: PERSON,
        vendor: "other",
        primaryHost: "https://api.other.example",
      });
      const wrong = await app.request(
        `/api/connections/${other.id}/oauth/authorize-url`,
        json({ pendingActionId: askId }),
      );
      expect(wrong.status).toBe(400);

      const started = (await (
        await app.request(
          `/api/connections/${connectionId}/oauth/authorize-url`,
          json({ pendingActionId: askId }),
        )
      ).json()) as { authorizeUrl: string };
      const state = new URL(started.authorizeUrl).searchParams.get("state") as string;
      expect(landing(await callback({ code: "reconsent", state })).status).toBe("connected");
      expect(store.pendingActions.get(askId)?.answer).toEqual({ connectionId });

      const connected = await a.call("request_credential", { connectionId });
      expect(connected.isError).toBeFalsy();
      expect(body(connected)).toMatchObject({ status: "connected", connectionId });
    } finally {
      await a.close();
    }
  });

  /**
   * The one consent that changes a list: the row was revoked when the browser came back, and
   * `completeOAuthConsent` clears the mark with the record, so the execute tool returns to every
   * list whose scope reaches the row and those sessions are told (Greptile on #88). The revoke is
   * played as landing **between the callback's unlocked read of the row and its locked one** — the
   * moment a revoke committing under the same row lock would surface — so the classification is
   * shown to come from the locked row inside the transaction, before the record is written; read
   * from the unlocked row it would say "live" and the write would clear the revoke with nobody
   * told. In practice a revoke clears the client secret and the re-entry that restores it is the
   * reconnection that announces (the next test), so this is the guard's own case rather than a
   * flow the console offers.
   */
  it("a consent completed on a row revoked meanwhile is its reconnection, classified from the row locked inside the transaction, and tells every session whose scope reaches it", async () => {
    apiNotifier.changed.mockClear();
    const lockedRead = vi.mocked(connectionDeps.findConnectionForUpdate);
    const write = vi.mocked(connectionDeps.setConnectionCredential);
    lockedRead.mockClear();
    write.mockClear();
    const started = (await (
      await app.request(`/api/connections/${connectionId}/oauth/authorize-url`, json({}))
    ).json()) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get("state") as string;
    expect(store.connections.get(connectionId)?.revokedAt).toBeNull();
    revokeAtLock = connectionId;

    expect(landing(await callback({ code: "while-revoked", state })).status).toBe("connected");
    expect(revokeAtLock).toBeNull();
    expect(store.connections.get(connectionId)?.revokedAt).toBeNull();
    // Locked read first, the record written after it, and the announcement from what the lock saw.
    expect(lockedRead).toHaveBeenCalledWith(expect.anything(), PERSON, connectionId);
    expect(lockedRead.mock.invocationCallOrder[0] ?? Number.NaN).toBeLessThan(
      write.mock.invocationCallOrder[0] ?? Number.NaN,
    );
    expect(announced()).toEqual([AGENT_A]);
    apiNotifier.changed.mockClear();
  });

  it("revoke clears the tokens, the client secret, the consent state, the approvals and the build approval, and leaves the tool", async () => {
    store.addTool({
      id: "tool_mail_list",
      personId: PERSON,
      vendor: "mail",
      name: "list-messages",
      description: "Lists messages",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: connectionId,
      path: "tools/mail/list-messages/v1",
    });
    store.approvals.set(`${AGENT_A} tool_mail_list`, {
      agentId: AGENT_A,
      toolId: "tool_mail_list",
      decision: "allow",
      decidedAt: new Date(),
      askEveryCall: false,
      owner: "person",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const revoked = await app.request(`/api/connections/${connectionId}/revoke`, from("POST"));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      connection: { id: connectionId, credentialSetAt: null, revokedAt: expect.any(String) },
      approvalsDeleted: 1,
      buildApprovalsDeleted: 1,
    });
    const row = store.connections.get(connectionId);
    expect(row?.credentialCiphertext).toBeNull();
    expect(row?.oauthRefreshState).toBeNull();
    expect(await storedRecord(connectionId)).toBeNull();
    expect(store.approvals.size).toBe(0);
    expect(store.buildApprovals.size).toBe(0);
    const tools = (await (await app.request("/api/tools")).json()) as { tools: { id: string }[] };
    expect(tools.tools.map((tool) => tool.id)).toContain("tool_mail_list");

    // Reconnecting after a revoke: the client secret again, then the consent. The re-entry is the
    // reconnection — it clears `revoked_at` — so it is what announces the row's return; the consent
    // that follows finds the row live and announces nothing more.
    apiNotifier.changed.mockClear();
    const reentered = await app.request(
      `/api/connections/${connectionId}/credential`,
      json({ fields: { clientSecret: "client-secret-value" } }, "PUT"),
    );
    expect(reentered.status).toBe(200);
    expect(announced()).toEqual([AGENT_A]);
    apiNotifier.changed.mockClear();
    expect(
      ((await reentered.json()) as { connection: ConnectionWire }).connection.oauth,
    ).toMatchObject({
      status: "awaiting_consent",
    });
    const started = (await (
      await app.request(`/api/connections/${connectionId}/oauth/authorize-url`, json({}))
    ).json()) as { authorizeUrl: string };
    const state = new URL(started.authorizeUrl).searchParams.get("state") as string;
    expect(landing(await callback({ code: "after-revoke", state })).status).toBe("connected");
    expect((await listConnections())[0]).toMatchObject({
      revokedAt: null,
      oauth: { status: "connected" },
    });
    expect(announced()).toEqual([]);
  });
});
