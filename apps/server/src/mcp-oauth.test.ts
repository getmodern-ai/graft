import type { AgentDeps, McpOAuthDeps } from "@graft/core";
import { generatePkce, hashAgentToken } from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { AgentRow } from "@graft/db/repo/agent";
import type { McpAuthorizationCodeRow, McpClientRow, McpTokenRow } from "@graft/db/repo/mcp-oauth";
import { initLogger } from "evlog";
import { describe, expect, it, vi } from "vitest";

import { createServer } from "./app";
import { MCP_OAUTH_MOUNT_PATH } from "./mcp-oauth";

/**
 * The authorization server at the HTTP layer with fakes (ADR 0018): the two documents at the root,
 * the four endpoints' wire shapes — a form body, a `Basic` header, RFC 6749 §5.2's error body at
 * its status, the redirects the authorization endpoint chooses between — and the console's two
 * consent routes behind the session. The protocol's rules are proved in `@graft/core`'s
 * `mcp-oauth.service.test.ts`; the whole flow over a real database and the SDK's client is
 * `mcp-oauth.integration.test.ts`.
 */

initLogger({ silent: true });

const NOW = new Date("2026-09-15T10:00:00Z");
const AUTH_URL = "http://graft.test";
const CONSOLE_URL = "http://console.graft.test";
const REDIRECT = "http://localhost:6274/oauth/callback";
const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };

function harness(session: { user: { id: string } } | null = { user: { id: "person_1" } }) {
  const clients = new Map<string, McpClientRow>();
  const codes = new Map<string, McpAuthorizationCodeRow>();
  const tokens = new Map<string, McpTokenRow>();
  const agents = new Map<string, AgentRow>();
  let counter = 0;
  const stamp = { owner: "person" as const, createdAt: NOW, updatedAt: NOW };

  const deps: McpOAuthDeps = {
    insertMcpClient: vi.fn(async (_db, input) => {
      const row = {
        secretHash: null,
        scope: null,
        clientUri: null,
        logoUri: null,
        softwareId: null,
        softwareVersion: null,
        ...stamp,
        ...input,
      } as McpClientRow;
      clients.set(row.id, row);
      return row;
    }),
    findMcpClient: vi.fn(async (_db, id) => clients.get(id) ?? null),
    insertMcpAuthorizationCode: vi.fn(async (_db, input) => {
      const row = {
        resource: null,
        scope: null,
        consumedAt: null,
        ...stamp,
        ...input,
      } as McpAuthorizationCodeRow;
      codes.set(row.id, row);
      return row;
    }),
    findMcpAuthorizationCodeByHash: vi.fn(
      async (_db, hash) => [...codes.values()].find((row) => row.codeHash === hash) ?? null,
    ),
    consumeMcpAuthorizationCode: vi.fn(async (_db, id, at) => {
      const row = codes.get(id);
      if (!row || row.consumedAt) return null;
      const consumed = { ...row, consumedAt: at };
      codes.set(id, consumed);
      return consumed;
    }),
    insertMcpToken: vi.fn(async (_db, input) => {
      const row = {
        resource: null,
        scope: null,
        expiresAt: null,
        rotatedAt: null,
        revokedAt: null,
        ...stamp,
        ...input,
      } as McpTokenRow;
      tokens.set(row.id, row);
      return row;
    }),
    findMcpTokenByHash: vi.fn(
      async (_db, hash) => [...tokens.values()].find((row) => row.tokenHash === hash) ?? null,
    ),
    findMcpRefreshTokenByHash: vi.fn(async (_db, hash) => {
      const row = [...tokens.values()].find((c) => c.tokenHash === hash && c.kind === "refresh");
      return row ? { ...row, agentRevokedAt: agents.get(row.agentId)?.revokedAt ?? null } : null;
    }),
    findAgentByMcpAccessTokenHash: vi.fn(async (_db, hash) => {
      const row = [...tokens.values()].find(
        (c) => c.tokenHash === hash && c.kind === "access" && !c.revokedAt,
      );
      const agent = row ? agents.get(row.agentId) : undefined;
      if (!row || !agent || agent.revokedAt) return null;
      return {
        tokenId: row.id,
        agentId: agent.id,
        personId: agent.personId,
        clientId: row.clientId,
        expiresAt: row.expiresAt,
      };
    }),
    rotateMcpToken: vi.fn(async (_db, id, at) => {
      const row = tokens.get(id);
      if (row && !row.rotatedAt) tokens.set(id, { ...row, rotatedAt: at });
    }),
    revokeMcpToken: vi.fn(async (_db, id, at) => {
      const row = tokens.get(id);
      if (row) tokens.set(id, { ...row, revokedAt: at });
    }),
    revokeMcpGrant: vi.fn(async (_db, grantId, at) => {
      let n = 0;
      for (const [id, row] of tokens) {
        if (row.grantId === grantId && !row.revokedAt) {
          tokens.set(id, { ...row, revokedAt: at });
          n += 1;
        }
      }
      return n;
    }),
    pruneMcpExpired: vi.fn(async () => {}),
    newId: () => `id_${++counter}`,
    now: () => NOW,
  };

  const agent: AgentDeps = {
    insertAgent: vi.fn(async (_db, input) => {
      const row = {
        tokenHash: null,
        tokenPrefix: null,
        connectedViaClientId: null,
        connectedViaClientName: null,
        workingSetCap: 20,
        idleWindowDays: 21,
        revokedAt: null,
        ...stamp,
        ...input,
      } as AgentRow;
      agents.set(row.id, row);
      return row;
    }),
    findAgent: vi.fn(async (_db, personId, id) => {
      const row = agents.get(id);
      return row && row.personId === personId ? row : null;
    }),
    findAgentByTokenHash: vi.fn(async () => null),
    findAgentByMcpAccessTokenHash: deps.findAgentByMcpAccessTokenHash,
    listAgents: vi.fn(async () => [...agents.values()]),
    updateAgent: vi.fn(async () => null),
    revokeAgent: vi.fn(async () => null),
    revokeMcpTokensForAgent: vi.fn(async () => 0),
    setAgentConnectedVia: vi.fn(async () => null),
    replaceAgentConnections: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => []),
    findConnectionsByIds: vi.fn(async () => []),
    listAllActiveAgents: vi.fn(async () => []),
    newId: () => `agent_${++counter}`,
    now: () => NOW,
  };

  const mcpOAuth = {
    db: fakeDb as unknown as DbOrTx,
    deps,
    agent,
    authUrl: AUTH_URL,
    consoleUrl: CONSOLE_URL,
  };
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    mcpOAuth,
    api: {
      auth: {
        handler: async () => new Response("auth", { status: 200 }),
        getSession: async () => session,
      },
      deps: {
        db: fakeDb as unknown as DbOrTx,
        agent,
      } as never,
      corsOrigins: [CONSOLE_URL],
      handoff: { consoleUrl: CONSOLE_URL, secret: "mcp-oauth-test-handoff-secret-long-enough" },
      mcpOAuth,
    },
  });
  return { app, clients, codes, tokens, agents };
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function register(
  app: ReturnType<typeof harness>["app"],
  extra: Record<string, unknown> = {},
) {
  const res = await app.request(
    `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/register`,
    json({
      redirect_uris: [REDIRECT],
      client_name: "Inspector",
      token_endpoint_auth_method: "none",
      ...extra,
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

const authorizeUrl = (params: Record<string, string>) =>
  `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/authorize?${new URLSearchParams(params)}`;

describe("the metadata documents", () => {
  it("serves both RFC 8414 and RFC 9728 documents at the root, CORS-open, naming this origin", async () => {
    const { app } = harness();
    const as = await app.request(`${AUTH_URL}/.well-known/oauth-authorization-server`, {
      headers: { origin: "http://localhost:6274" },
    });
    expect(as.status).toBe(200);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(await as.json()).toMatchObject({
      issuer: AUTH_URL,
      authorization_endpoint: `${AUTH_URL}/mcp/oauth/authorize`,
      token_endpoint: `${AUTH_URL}/mcp/oauth/token`,
      registration_endpoint: `${AUTH_URL}/mcp/oauth/register`,
      revocation_endpoint: `${AUTH_URL}/mcp/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
    });

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const prm = await app.request(`${AUTH_URL}${path}`);
      expect(prm.status, path).toBe(200);
      expect(await prm.json()).toMatchObject({
        resource: `${AUTH_URL}/mcp`,
        authorization_servers: [AUTH_URL],
      });
    }

    // A preflight from a browser-based client is answered without a cookie's worth of ceremony.
    const preflight = await app.request(`${AUTH_URL}/mcp/oauth/token`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:6274",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("registration", () => {
  it("answers 201 with the id, and 400 in the RFC 7591 shape for a redirect URI outside the rule", async () => {
    const { app, clients } = harness();
    const registered = await register(app, { token_endpoint_auth_method: "client_secret_post" });
    expect(registered.client_secret).toMatch(/^grfts_/);
    expect(clients.get(registered.client_id)?.secretHash).toBe(
      hashAgentToken(registered.client_secret ?? ""),
    );

    const refused = await app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/register`,
      json({ redirect_uris: ["http://evil.example/cb"] }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const notJson = await app.request(`${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/register`, {
      method: "POST",
      body: "nope",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_client_metadata" });
  });
});

describe("the authorization endpoint", () => {
  it("sends a sound request to the console's consent page with its parameters intact", async () => {
    const { app } = harness();
    const { client_id } = await register(app);
    const res = await app.request(
      authorizeUrl({
        client_id,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: generatePkce().challenge,
        code_challenge_method: "S256",
        state: "abc",
        resource: `${AUTH_URL}/mcp`,
      }),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${CONSOLE_URL}/consent`);
    expect(location.searchParams.get("client_id")).toBe(client_id);
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("sends an unknown client, or an unregistered redirect URI, to the console too — never to the URI in doubt", async () => {
    const { app } = harness();
    const { client_id } = await register(app);
    for (const params of [
      { client_id: "nobody", redirect_uri: "http://evil.example/cb", response_type: "code" },
      { client_id, redirect_uri: "http://evil.example/cb", response_type: "code" },
    ]) {
      const res = await app.request(authorizeUrl(params));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")?.startsWith(`${CONSOLE_URL}/consent?`)).toBe(true);
    }
  });

  it("sends the client's own mistake back to its registered URI as an error with the state", async () => {
    const { app } = harness();
    const { client_id } = await register(app);
    const res = await app.request(
      authorizeUrl({ client_id, redirect_uri: REDIRECT, response_type: "code", state: "s" }),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("s");
    expect(location.searchParams.get("iss")).toBe(AUTH_URL);
  });
});

describe("the console's consent routes", () => {
  const request = (client_id: string, challenge: string) => ({
    client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  });

  it("refuses both routes without a session", async () => {
    const { app } = harness(null);
    const described = await app.request(`${AUTH_URL}/api/mcp-oauth/request?client_id=x`);
    expect(described.status).toBe(401);
    const decided = await app.request(
      `${AUTH_URL}/api/mcp-oauth/consent`,
      json({ request: {}, decision: "deny" }),
    );
    expect(decided.status).toBe(401);
  });

  it("describes a sound request — the client's name and where it goes back — and names the reason for one that is not", async () => {
    const { app } = harness();
    const { client_id } = await register(app);
    const sound = await app.request(
      `${AUTH_URL}/api/mcp-oauth/request?${new URLSearchParams(request(client_id, generatePkce().challenge))}`,
    );
    expect(sound.status).toBe(200);
    expect(await sound.json()).toEqual({
      client: { id: client_id, name: "Inspector", clientUri: null, logoUri: null },
      redirectUri: REDIRECT,
      redirectTarget: "localhost:6274",
      scope: null,
      resource: `${AUTH_URL}/mcp`,
    });

    const unregistered = await app.request(
      `${AUTH_URL}/api/mcp-oauth/request?${new URLSearchParams({ ...request(client_id, generatePkce().challenge), redirect_uri: "http://evil.example/cb" })}`,
    );
    expect(unregistered.status).toBe(400);
    expect(await unregistered.json()).toMatchObject({
      error: "BAD_REQUEST",
      details: { reason: "redirect_uri_unregistered" },
    });

    const noPkce = await app.request(
      `${AUTH_URL}/api/mcp-oauth/request?${new URLSearchParams({ client_id, redirect_uri: REDIRECT, response_type: "code" })}`,
    );
    expect(noPkce.status).toBe(400);
    expect(await noPkce.json()).toMatchObject({ details: { reason: "invalid_request" } });
  });

  it("mints the agent on an allow and answers the redirect with the code; a deny answers access_denied", async () => {
    const { app, agents, codes } = harness();
    const { client_id } = await register(app);
    const pkce = generatePkce();
    const allowed = await app.request(
      `${AUTH_URL}/api/mcp-oauth/consent`,
      json({
        request: request(client_id, pkce.challenge),
        decision: "allow",
        agent: { kind: "new", name: "Inspector", connectionIds: [] },
      }),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      redirectTo: string;
      agent: { id: string; connectedVia: unknown };
    };
    const url = new URL(body.redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("code")).toMatch(/^grftc_/);
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(body.agent.connectedVia).toEqual({ clientId: client_id, clientName: "Inspector" });
    expect(agents.get(body.agent.id)?.tokenHash).toBeNull();
    expect([...codes.values()][0]?.agentId).toBe(body.agent.id);

    const denied = await app.request(
      `${AUTH_URL}/api/mcp-oauth/consent`,
      json({ request: request(client_id, pkce.challenge), decision: "deny" }),
    );
    expect(denied.status).toBe(200);
    const deniedBody = (await denied.json()) as { redirectTo: string };
    expect(new URL(deniedBody.redirectTo).searchParams.get("error")).toBe("access_denied");

    const noAgent = await app.request(
      `${AUTH_URL}/api/mcp-oauth/consent`,
      json({ request: request(client_id, pkce.challenge), decision: "allow" }),
    );
    expect(noAgent.status).toBe(400);
  });
});

describe("the token and revocation endpoints", () => {
  async function codeFor(h: ReturnType<typeof harness>, client_id: string) {
    const pkce = generatePkce();
    const res = await h.app.request(
      `${AUTH_URL}/api/mcp-oauth/consent`,
      json({
        request: {
          client_id,
          redirect_uri: REDIRECT,
          response_type: "code",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
        },
        decision: "allow",
        agent: { kind: "new", name: "Inspector", connectionIds: [] },
      }),
    );
    const { redirectTo } = (await res.json()) as { redirectTo: string };
    return { code: new URL(redirectTo).searchParams.get("code") ?? "", verifier: pkce.verifier };
  }

  it("exchanges a code over a form body for a public client, never caching, and refreshes with rotation", async () => {
    const h = harness();
    const { client_id } = await register(h.app);
    const { code, verifier } = await codeFor(h, client_id);
    const res = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^grfta_/);
    expect(tokens.refresh_token).toMatch(/^grftr_/);

    const refreshed = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { refresh_token: string };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("authenticates a confidential client from a Basic header or the body, and refuses a wrong secret as invalid_client at 401", async () => {
    const h = harness();
    const { client_id, client_secret } = await register(h.app, {
      token_endpoint_auth_method: "client_secret_basic",
    });
    const { code, verifier } = await codeFor(h, client_id);
    const basic = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString("base64")}`;
    const res = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form(
        { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT },
        { authorization: basic },
      ),
    );
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { refresh_token: string };

    const viaBody = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        client_secret: client_secret ?? "",
      }),
    );
    expect(viaBody.status).toBe(200);

    const wrong = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form(
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
        { authorization: `Basic ${Buffer.from(`${client_id}:grfts_wrong`).toString("base64")}` },
      ),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe('Basic realm="graft"');
    expect(await wrong.json()).toMatchObject({ error: "invalid_client" });

    const disagree = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({ grant_type: "refresh_token", client_id: "someone-else" }, { authorization: basic }),
    );
    expect(disagree.status).toBe(400);
    expect(await disagree.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers the protocol's errors in its shape: unsupported grant, unknown code, a JSON body", async () => {
    const h = harness();
    const { client_id } = await register(h.app);
    const unsupported = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({ grant_type: "client_credentials", client_id }),
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });

    const unknown = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({
        grant_type: "authorization_code",
        code: "grftc_nobody",
        code_verifier: generatePkce().verifier,
        client_id,
      }),
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "invalid_grant" });

    const asJson = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      json({ grant_type: "authorization_code", client_id }),
    );
    expect(asJson.status).toBe(401);
    expect(await asJson.json()).toMatchObject({ error: "invalid_client" });
  });

  it("revokes over a form body and answers 200 for a stranger's token too", async () => {
    const h = harness();
    const { client_id } = await register(h.app);
    const { code, verifier } = await codeFor(h, client_id);
    const issued = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/token`,
      form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id }),
    );
    const tokens = (await issued.json()) as { access_token: string; refresh_token: string };

    const revoked = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/revoke`,
      form({ token: tokens.refresh_token, client_id }),
    );
    expect(revoked.status).toBe(200);
    for (const row of h.tokens.values()) expect(row.revokedAt).toEqual(NOW);

    const stranger = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/revoke`,
      form({ token: "grfta_nobody", client_id }),
    );
    expect(stranger.status).toBe(200);

    const missing = await h.app.request(
      `${AUTH_URL}${MCP_OAUTH_MOUNT_PATH}/revoke`,
      form({ client_id }),
    );
    expect(missing.status).toBe(400);
  });
});
