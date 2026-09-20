import { randomBytes } from "node:crypto";

import { createAuth } from "@graft/auth";
import {
  createConnectionDeps,
  defaultAgentDeps,
  defaultApprovalDeps,
  defaultLedgerDeps,
  defaultMcpOAuthDeps,
  defaultPendingActionDeps,
  defaultToolDeps,
  defaultWorkingSetDeps,
  protectedResourceMetadataUrl,
} from "@graft/core";
import { createDb, type Database } from "@graft/db";
import { applyMigrations } from "@graft/db/migrate";
import { markPersonEmailVerified } from "@graft/db/repo/person";
import { createMcpDeps } from "@graft/mcp";
import { createFakeSandboxBackend } from "@graft/sandbox";
import { createCredentialVault, createLocalKeyring } from "@graft/vault";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientProvider,
  registerClient,
  startAuthorization,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { sql } from "drizzle-orm";
import { initLogger } from "evlog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { createDatabaseConnections } from "./connections";

/**
 * GRA-53's acceptance criterion, end to end over a real Postgres (ADR 0018): the MCP TypeScript
 * SDK's own client, with an `OAuthClientProvider` in place of a chat product's, against the same
 * server `index.ts` serves — discovery from the 401, dynamic registration, the authorization code
 * flow with PKCE through the console's consent route (the person's part is one authenticated
 * `POST`, the browser's redirects followed by hand), the token, `initialize` and `tools/list` as
 * the minted agent, a refresh when the access token has run out, and a refusal once the agent is
 * revoked. Every request the client makes goes through `app.request`, so nothing listens on a port
 * and the whole transport still runs.
 *
 * Like `database.integration.test.ts`, this needs `TEST_DATABASE_URL`, makes a throwaway database
 * per run, and skips itself without one — but fails rather than skipping under `CI`.
 */
const adminUrl = process.env.TEST_DATABASE_URL;

if (!adminUrl && process.env.CI) {
  throw new Error(
    "TEST_DATABASE_URL is unset under CI. The MCP OAuth integration suite needs a real Postgres; " +
      "restore the `postgres` service in .github/workflows/ci.yml rather than letting this skip.",
  );
}

initLogger({ silent: true });

const AUTH_URL = "http://graft.test";
const CONSOLE_URL = "http://console.graft.test";
const AUTH_SECRET = "auth-secret-that-is-long-enough-32-chars";
const REDIRECT = "http://localhost:6274/oauth/callback";

/**
 * A chat product's half of the flow, as the SDK models it: remembers what it registered, the tokens
 * it was issued and the verifier it minted, and records the authorization URL it would have opened
 * for the person — the test plays the browser from there.
 */
class ProductProvider implements OAuthClientProvider {
  clientInfo: OAuthClientInformationMixed | undefined;
  issued: OAuthTokens | undefined;
  verifier: string | undefined;
  authorizationUrls: URL[] = [];

  constructor(
    readonly name: string,
    readonly authMethod: "none" | "client_secret_basic",
  ) {}

  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: this.authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }
  clientInformation() {
    return this.clientInfo;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.clientInfo = info;
  }
  tokens() {
    return this.issued;
  }
  saveTokens(tokens: OAuthTokens) {
    this.issued = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrls.push(url);
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("no verifier saved");
    return this.verifier;
  }
  /**
   * What the SDK's `auth()` calls when the server answers `invalid_grant` on a refresh: the
   * product forgets the tokens and starts a fresh authorization — which is how a revoked agent
   * becomes "connect again" in the product's UI rather than a dead connector.
   */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.issued = undefined;
    if (scope === "all" || scope === "client") this.clientInfo = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
  }
}

describe.skipIf(!adminUrl)("a chat product connects over MCP OAuth (ADR 0018)", () => {
  let admin: Database;
  let db: Database;
  let databaseName: string;
  let app: ReturnType<typeof createServer>;
  let cookie: string;
  let personId: string;
  const vault = createCredentialVault(createLocalKeyring("test-secret-that-is-long-enough-32"));
  const sandbox = createFakeSandboxBackend();

  /** The SDK's `fetch`, pointed at the app: the whole server without a socket. */
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) =>
    app.request(url instanceof Request ? url : url.toString(), init);

  beforeAll(async () => {
    if (!adminUrl) return;
    admin = createDb(adminUrl);
    databaseName = `graft_oauth_it_${randomBytes(6).toString("hex")}`;
    await admin.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    db = createDb(url.toString());
    await applyMigrations(db);

    const auth = createAuth({ db, secret: AUTH_SECRET, baseURL: AUTH_URL });
    // Registering opens no session until the address is verified (GRA-94): verify as the boot
    // verifies its admin, then sign in for the cookie.
    const signedUp = await auth.api.signUpEmail({
      body: { email: "ada@example.com", password: "a-password-that-is-long-enough", name: "Ada" },
    });
    await markPersonEmailVerified(db, "ada@example.com");
    const signedIn = await auth.api.signInEmail({
      body: { email: "ada@example.com", password: "a-password-that-is-long-enough" },
      returnHeaders: true,
    });
    cookie = signedIn.headers.get("set-cookie") ?? "";
    personId = signedUp.user.id;

    const connectionDeps = createConnectionDeps({ encrypt: vault.encrypt });
    const handoff = {
      consoleUrl: CONSOLE_URL,
      secret: "oauth-it-handoff-secret-that-is-long-enough-32",
      waitMs: 0,
      ttlMs: 60_000,
    };
    const mcpOAuth = {
      db,
      deps: defaultMcpOAuthDeps,
      agent: defaultAgentDeps,
      authUrl: AUTH_URL,
      consoleUrl: CONSOLE_URL,
    };
    app = createServer({
      keys: null,
      vault,
      connections: createDatabaseConnections(db),
      followRedirects: false,
      api: {
        auth: {
          handler: (request) => auth.handler(request),
          getSession: (headers) => auth.api.getSession({ headers }),
        },
        deps: {
          db,
          agent: defaultAgentDeps,
          connection: connectionDeps,
          workingSet: defaultWorkingSetDeps,
          tool: defaultToolDeps,
          ledger: defaultLedgerDeps,
          approval: defaultApprovalDeps,
          pendingAction: defaultPendingActionDeps,
          modelKey: { encrypt: vault.encrypt } as never,
        },
        corsOrigins: [CONSOLE_URL],
        handoff,
        mcpOAuth,
      },
      mcp: createMcpDeps({
        db,
        connection: connectionDeps,
        sandbox,
        keys: null,
        proxyPublicUrl: `${AUTH_URL}/api/proxy`,
        handoff,
        resourceMetadataUrl: protectedResourceMetadataUrl(AUTH_URL),
      }),
      mcpOAuth,
    });
  }, 60_000);

  afterAll(async () => {
    await sandbox.close();
    await db?.close();
    if (admin && databaseName) {
      await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${databaseName}"`));
      await admin.close();
    }
  });

  /** The person's part, played by the test: follow the authorization redirect to the console, consent, take the code. */
  async function consentAs(
    authorizationUrl: URL,
    agent:
      | { kind: "new"; name: string; connectionIds: string[] }
      | { kind: "existing"; agentId: string },
  ): Promise<{ code: string; state: string | null; agentId: string }> {
    const toConsole = await app.request(authorizationUrl.toString());
    expect(toConsole.status).toBe(302);
    const consentUrl = new URL(toConsole.headers.get("location") ?? "");
    expect(consentUrl.origin + consentUrl.pathname).toBe(`${CONSOLE_URL}/consent`);

    const request = Object.fromEntries(consentUrl.searchParams);
    const described = await app.request(
      `${AUTH_URL}/api/mcp-oauth/request?${consentUrl.searchParams}`,
      {
        headers: { cookie },
      },
    );
    expect(described.status).toBe(200);

    const decided = await app.request(`${AUTH_URL}/api/mcp-oauth/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ request, decision: "allow", agent }),
    });
    expect(decided.status).toBe(200);
    const { redirectTo, agent: minted } = (await decided.json()) as {
      redirectTo: string;
      agent: { id: string };
    };
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    return {
      code: back.searchParams.get("code") ?? "",
      state: back.searchParams.get("state"),
      agentId: minted.id,
    };
  }

  it("runs the whole flow with the SDK's client: 401 → discovery → registration → consent → token → tools/list as the minted agent → refresh → refusal after revoke", async () => {
    const provider = new ProductProvider("Test Chat Product", "none");
    const serverUrl = new URL(`${AUTH_URL}/mcp`);

    // 1. The first connection attempt: the 401's challenge starts discovery and registration, and
    //    ends with the URL the product would open for the person.
    const first = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider,
      fetch: fetchFn,
    });
    await expect(new Client({ name: "product", version: "0.0.0" }).connect(first)).rejects.toThrow(
      UnauthorizedError,
    );
    expect(provider.clientInfo?.client_id).toBeDefined();
    expect(provider.clientInfo).not.toHaveProperty("client_secret");
    const authorizationUrl = provider.authorizationUrls[0];
    if (!authorizationUrl) throw new Error("the product was not sent to authorize");
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${AUTH_URL}/mcp/oauth/authorize`,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("resource")).toBe(`${AUTH_URL}/mcp`);

    // 2. The person, in the console: signed in, sees the client's name, consents as a new agent.
    const { code, agentId } = await consentAs(authorizationUrl, {
      kind: "new",
      name: "Test Chat Product",
      connectionIds: [],
    });
    expect(code).toMatch(/^grftc_/);

    // 3. The product exchanges the code, then connects as the agent.
    await first.finishAuth(code);
    expect(provider.issued?.access_token).toMatch(/^grfta_/);
    expect(provider.issued?.refresh_token).toMatch(/^grftr_/);

    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider,
      fetch: fetchFn,
    });
    const client = new Client({ name: "product", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("find_tool");

      // The agent the consent minted: named for the client, no static token, the client recorded.
      const agents = await app.request(`${AUTH_URL}/api/agents/${agentId}`, {
        headers: { cookie },
      });
      expect(agents.status).toBe(200);
      const { agent } = (await agents.json()) as {
        agent: { name: string; tokenPrefix: string | null; connectedVia: unknown; revokedAt: null };
      };
      expect(agent).toMatchObject({
        name: "Test Chat Product",
        tokenPrefix: null,
        connectedVia: { clientId: provider.clientInfo?.client_id, clientName: "Test Chat Product" },
      });
      const stored = await db.execute<{ token_hash: string | null; person_id: string }>(
        sql`select token_hash, person_id from agent where id = ${agentId}`,
      );
      expect(stored.rows[0]).toEqual({ token_hash: null, person_id: personId });

      // Every token is a hash in the row and nowhere else.
      const rows = await db.execute<{ kind: string; token_hash: string }>(
        sql`select kind, token_hash from mcp_token where agent_id = ${agentId} order by kind`,
      );
      expect(rows.rows.map((row) => row.kind)).toEqual(["access", "refresh"]);
      const dump = JSON.stringify(rows.rows);
      expect(dump).not.toContain(provider.issued?.access_token ?? "!");
      expect(dump).not.toContain(provider.issued?.refresh_token ?? "!");

      // 4. The access token runs out; the SDK refreshes on the 401 and the call goes through.
      const before = provider.issued?.access_token;
      await db.execute(
        sql`update mcp_token set expires_at = now() - interval '1 minute' where agent_id = ${agentId} and kind = 'access'`,
      );
      const afterExpiry = await client.listTools();
      expect(afterExpiry.tools.map((tool) => tool.name)).toContain("find_tool");
      expect(provider.issued?.access_token).not.toBe(before);
      const refreshRows = await db.execute<{ rotated_at: Date | null }>(
        sql`select rotated_at from mcp_token where agent_id = ${agentId} and kind = 'refresh' order by created_at`,
      );
      expect(refreshRows.rows).toHaveLength(2);
      expect(refreshRows.rows[0]?.rotated_at).not.toBeNull();
      expect(refreshRows.rows[1]?.rotated_at).toBeNull();

      // 5. The person revokes the agent in the console: the next call is refused, the refresh is
      //    refused, and the product is sent to authorize again — which is how it asks the person
      //    to reconnect.
      const revoked = await app.request(`${AUTH_URL}/api/agents/${agentId}/revoke`, {
        method: "POST",
        headers: { cookie },
      });
      expect(revoked.status).toBe(200);
      const direct = await app.request(`${AUTH_URL}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.issued?.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": transport.sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      });
      expect(direct.status).toBe(401);
      expect(await direct.json()).toMatchObject({ reason: "token_unknown" });
      expect(direct.headers.get("www-authenticate")).toContain('error="invalid_token"');

      const urlsBefore = provider.authorizationUrls.length;
      await expect(client.listTools()).rejects.toThrow(UnauthorizedError);
      expect(provider.authorizationUrls.length).toBe(urlsBefore + 1);
      const tokenRows = await db.execute<{ revoked_at: Date | null }>(
        sql`select revoked_at from mcp_token where agent_id = ${agentId}`,
      );
      for (const row of tokenRows.rows) expect(row.revoked_at).not.toBeNull();
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);

  it("admits a confidential client through the SDK's Basic authentication, and binds the grant to an existing agent", async () => {
    const provider = new ProductProvider("Confidential Product", "client_secret_basic");
    const serverUrl = `${AUTH_URL}/mcp`;

    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn });
    expect(info.authorizationServerUrl).toBe(AUTH_URL);
    expect(info.resourceMetadata?.resource).toBe(`${AUTH_URL}/mcp`);
    const metadata = info.authorizationServerMetadata;
    if (!metadata) throw new Error("no authorization server metadata");

    const registered = await registerClient(AUTH_URL, {
      metadata,
      clientMetadata: provider.clientMetadata,
      fetchFn,
    });
    expect(registered.client_secret).toMatch(/^grfts_/);
    provider.saveClientInformation(registered);

    const { authorizationUrl, codeVerifier } = await startAuthorization(AUTH_URL, {
      metadata,
      clientInformation: registered,
      redirectUrl: REDIRECT,
      resource: new URL(serverUrl),
      state: "confidential-state",
    });

    // The person names an agent they already have — one made in the console with a static token.
    const existing = await app.request(`${AUTH_URL}/api/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop Hermes" }),
    });
    const { agent: made } = (await existing.json()) as { agent: { id: string } };
    const { code, state } = await consentAs(authorizationUrl, {
      kind: "existing",
      agentId: made.id,
    });
    expect(state).toBe("confidential-state");

    const tokens = await exchangeAuthorization(AUTH_URL, {
      metadata,
      clientInformation: registered,
      authorizationCode: code,
      codeVerifier,
      redirectUri: REDIRECT,
      resource: new URL(serverUrl),
      fetchFn,
    });
    expect(tokens.access_token).toMatch(/^grfta_/);

    // The token is the existing agent's, which now records the client as its origin.
    const shown = await app.request(`${AUTH_URL}/api/agents/${made.id}`, { headers: { cookie } });
    const { agent } = (await shown.json()) as {
      agent: { tokenPrefix: string | null; connectedVia: { clientName: string } | null };
    };
    expect(agent.tokenPrefix).toMatch(/^grft_/);
    expect(agent.connectedVia?.clientName).toBe("Confidential Product");

    const initialize = await app.request(`${AUTH_URL}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "product", version: "0.0.0" },
        },
      }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeTruthy();
  }, 60_000);
});
