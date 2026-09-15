import type { AgentRow } from "@graft/db/repo/agent";
import type { ConnectionRow } from "@graft/db/repo/connection";
import type { McpAuthorizationCodeRow, McpClientRow, McpTokenRow } from "@graft/db/repo/mcp-oauth";
import { describe, expect, it, vi } from "vitest";

import type { AgentDeps } from "../agent/agent.deps";
import { generatePkce } from "../connection/oauth-consent";
import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import {
  hashAgentToken,
  MCP_ACCESS_TOKEN_PREFIX,
  MCP_AUTHORIZATION_CODE_PREFIX,
  MCP_CLIENT_SECRET_PREFIX,
  MCP_REFRESH_TOKEN_PREFIX,
} from "../tenancy";
import type { McpOAuthDeps } from "./mcp-oauth.deps";
import {
  isAllowedRedirectUri,
  mcpConsentUrl,
  readAuthorizationRequestParams,
  sameResource,
} from "./mcp-oauth.rules";
import {
  authenticateClient,
  authorizationErrorRedirect,
  authorizationServerMetadata,
  decideConsent,
  grantTokens,
  judgeAuthorizationRequest,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_AUTHORIZATION_CODE_TTL_SECONDS,
  MCP_REFRESH_GRACE_SECONDS,
  OAuthProtocolError,
  protectedResourceMetadata,
  registerMcpClient,
  revokeToken,
  validateAuthorizationRequest,
  validateClientRegistration,
} from "./mcp-oauth.service";

/**
 * Graft's authorization server with maps in place of tables (ADR 0018) — the reference shape of
 * `agent.service.test.ts`, extended with a fake store so the token endpoint's rotation and
 * revocation can be asserted on the rows they leave. `db` is never dereferenced; the transaction
 * fake hands the same handle to its body.
 */

const NOW = new Date("2026-09-15T10:00:00Z");
const CONFIG = { authUrl: "https://app.getgraft.ai" };
const PRINCIPAL = { personId: "person_1" };

/**
 * A transaction fake that **serialises** its bodies, the way Postgres serialises two guarded
 * updates of one row: the second body starts after the first has committed, so a race the service
 * settles with a guarded update inside a transaction is a race this fake can stage. Re-entrant —
 * a body that opens a transaction of its own (`insertNewAgent` inside `decideConsent`) runs it in
 * place, as a savepoint would — so nothing here deadlocks on itself.
 */
const inner = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(inner) };
let chain: Promise<unknown> = Promise.resolve();
const fakeDb = {
  transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const run = chain.then(() => fn(inner));
    chain = run.catch(() => undefined);
    return run;
  },
};
const ctx = { db: fakeDb } as unknown as ServiceContext;

type Store = {
  clients: Map<string, McpClientRow>;
  codes: Map<string, McpAuthorizationCodeRow>;
  tokens: Map<string, McpTokenRow>;
  agents: Map<string, AgentRow>;
  clock: { now: Date };
};

function agentRow(id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    personId: "person_1",
    name: id,
    tokenHash: null,
    tokenPrefix: null,
    connectedViaClientId: null,
    connectedViaClientName: null,
    workingSetCap: 20,
    idleWindowDays: 21,
    revokedAt: null,
    owner: "person",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(overrides: { clock?: Date } = {}) {
  const store: Store = {
    clients: new Map(),
    codes: new Map(),
    tokens: new Map(),
    agents: new Map([
      ["agent_1", agentRow("agent_1", { tokenHash: "h", tokenPrefix: "grft_abc" })],
    ]),
    clock: { now: overrides.clock ?? NOW },
  };
  let counter = 0;
  const now = () => store.clock.now;
  const stamp = <T extends object>(
    row: T,
  ): T & { createdAt: Date; updatedAt: Date; owner: "person" } =>
    ({ owner: "person", createdAt: now(), updatedAt: now(), ...row }) as never;

  const deps: McpOAuthDeps = {
    insertMcpClient: vi.fn(async (_db, input) => {
      const row = stamp({
        secretHash: null,
        scope: null,
        clientUri: null,
        logoUri: null,
        softwareId: null,
        softwareVersion: null,
        ...input,
      }) as McpClientRow;
      store.clients.set(row.id, row);
      return row;
    }),
    findMcpClient: vi.fn(async (_db, id) => store.clients.get(id) ?? null),
    insertMcpAuthorizationCode: vi.fn(async (_db, input) => {
      const row = stamp({
        resource: null,
        scope: null,
        consumedAt: null,
        ...input,
      }) as McpAuthorizationCodeRow;
      store.codes.set(row.id, row);
      return row;
    }),
    findMcpAuthorizationCodeByHash: vi.fn(async (_db, hash) => {
      const row = [...store.codes.values()].find((candidate) => candidate.codeHash === hash);
      if (!row) return null;
      return { ...row, agentRevokedAt: store.agents.get(row.agentId)?.revokedAt ?? null };
    }),
    consumeMcpAuthorizationCode: vi.fn(async (_db, id, at) => {
      const row = store.codes.get(id);
      if (!row || row.consumedAt) return null;
      const consumed = { ...row, consumedAt: at };
      store.codes.set(id, consumed);
      return consumed;
    }),
    insertMcpToken: vi.fn(async (_db, input) => {
      const row = stamp({
        resource: null,
        scope: null,
        expiresAt: null,
        rotatedAt: null,
        revokedAt: null,
        ...input,
      }) as McpTokenRow;
      store.tokens.set(row.id, row);
      return row;
    }),
    findMcpTokenByHash: vi.fn(
      async (_db, hash) => [...store.tokens.values()].find((row) => row.tokenHash === hash) ?? null,
    ),
    findMcpRefreshTokenByHash: vi.fn(async (_db, hash) => {
      const row = [...store.tokens.values()].find(
        (candidate) => candidate.tokenHash === hash && candidate.kind === "refresh",
      );
      if (!row) return null;
      return { ...row, agentRevokedAt: store.agents.get(row.agentId)?.revokedAt ?? null };
    }),
    findAgentByMcpAccessTokenHash: vi.fn(async (_db, hash) => {
      const row = [...store.tokens.values()].find(
        (candidate) =>
          candidate.tokenHash === hash && candidate.kind === "access" && !candidate.revokedAt,
      );
      const agent = row ? store.agents.get(row.agentId) : undefined;
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
      const row = store.tokens.get(id);
      if (!row || row.rotatedAt) return null;
      const rotated = { ...row, rotatedAt: at };
      store.tokens.set(id, rotated);
      return rotated;
    }),
    revokeMcpToken: vi.fn(async (_db, id, at) => {
      const row = store.tokens.get(id);
      if (row && !row.revokedAt) store.tokens.set(id, { ...row, revokedAt: at });
    }),
    revokeMcpGrant: vi.fn(async (_db, grantId, at) => {
      let n = 0;
      for (const [id, row] of store.tokens) {
        if (row.grantId === grantId && !row.revokedAt) {
          store.tokens.set(id, { ...row, revokedAt: at });
          n += 1;
        }
      }
      return n;
    }),
    pruneMcpExpired: vi.fn(async () => {}),
    newId: () => `id_${++counter}`,
    now,
  };

  const agentDeps: AgentDeps = {
    insertAgent: vi.fn(async (_db, input) => {
      const row = agentRow(input.id, {
        ...input,
        createdAt: now(),
        updatedAt: now(),
      } as Partial<AgentRow>);
      store.agents.set(row.id, row);
      return row;
    }),
    findAgent: vi.fn(async (_db, personId, agentId) => {
      const row = store.agents.get(agentId);
      return row && row.personId === personId ? row : null;
    }),
    findAgentByTokenHash: vi.fn(async () => null),
    findAgentByMcpAccessTokenHash: deps.findAgentByMcpAccessTokenHash,
    listAgents: vi.fn(async () => [...store.agents.values()]),
    updateAgent: vi.fn(async () => null),
    revokeAgent: vi.fn(async () => null),
    revokeMcpTokensForAgent: vi.fn(async () => 0),
    setAgentConnectedVia: vi.fn(async (_db, _personId, agentId, via) => {
      const row = store.agents.get(agentId);
      if (!row || row.connectedViaClientId) return null;
      const updated = {
        ...row,
        connectedViaClientId: via.clientId,
        connectedViaClientName: via.clientName,
      };
      store.agents.set(agentId, updated);
      return updated;
    }),
    replaceAgentConnections: vi.fn(async () => {}),
    listAgentConnectionIds: vi.fn(async () => []),
    findConnectionsByIds: vi.fn(async (_db, _p, ids: readonly string[]) =>
      ids.map((id) => ({ id, personId: "person_1", vendor: "demo" }) as ConnectionRow),
    ),
    listAllActiveAgents: vi.fn(async () => []),
    newId: () => `agent_${++counter}`,
    now,
  };

  return { store, deps, agentDeps };
}

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const registration = (extra: Record<string, unknown> = {}) => ({
  redirect_uris: [REDIRECT],
  client_name: "Claude",
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  ...extra,
});

async function registered(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  return registerMcpClient(ctx, registration(extra), h.deps);
}

/** Walk a client through the consent to a code, the way the console does. */
async function consented(
  h: ReturnType<typeof harness>,
  clientId: string,
  options: { agent?: "new" | "existing"; state?: string; scope?: string } = {},
) {
  const pkce = generatePkce();
  const params = readAuthorizationRequestParams(
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: "https://app.getgraft.ai/mcp",
      ...(options.state ? { state: options.state } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    }),
  );
  const outcome = await decideConsent(
    ctx,
    PRINCIPAL,
    params,
    {
      decision: "allow",
      agent:
        options.agent === "existing"
          ? { kind: "existing", agentId: "agent_1" }
          : { kind: "new", name: "Claude", connectionIds: ["conn_1"] },
    },
    h.deps,
    h.agentDeps,
    CONFIG,
  );
  const code = new URL(outcome.redirectTo).searchParams.get("code") ?? "";
  return { pkce, params, outcome, code };
}

describe("the metadata documents", () => {
  it("names the issuer, the four endpoints under it, code with S256 alone, and the three client auth methods", () => {
    const doc = authorizationServerMetadata(CONFIG);
    expect(doc.issuer).toBe("https://app.getgraft.ai");
    expect(doc.authorization_endpoint).toBe("https://app.getgraft.ai/mcp/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://app.getgraft.ai/mcp/oauth/token");
    expect(doc.registration_endpoint).toBe("https://app.getgraft.ai/mcp/oauth/register");
    expect(doc.revocation_endpoint).toBe("https://app.getgraft.ai/mcp/oauth/revoke");
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual([
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]);
    expect(doc).not.toHaveProperty("scopes_supported");
  });

  it("names the MCP endpoint as the resource and this origin as its authorization server, whatever path the auth URL carries", () => {
    const doc = protectedResourceMetadata({ authUrl: "https://app.getgraft.ai/api/auth" });
    expect(doc.resource).toBe("https://app.getgraft.ai/mcp");
    expect(doc.authorization_servers).toEqual(["https://app.getgraft.ai"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("the rules", () => {
  it("admits https anywhere and http on loopback alone, never a fragment or credentials", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:3000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    // The URL parser reads the shorthand as 127.0.0.1 — loopback, so admitted; the registered
    // string is what an authorization request must then match exactly.
    expect(isAllowedRedirectUri("http://127.1/cb")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("https://user:pw@claude.ai/cb")).toBe(false);
    expect(isAllowedRedirectUri("cursor://callback")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("compares resources after RFC 8707's normalisation", () => {
    expect(sameResource("https://App.GetGraft.ai/mcp/", "https://app.getgraft.ai/mcp")).toBe(true);
    expect(sameResource("https://app.getgraft.ai/mcp", "https://app.getgraft.ai/mcp2")).toBe(false);
    expect(sameResource("https://app.getgraft.ai/mcp#x", "https://app.getgraft.ai/mcp")).toBe(
      false,
    );
    expect(sameResource("nope", "https://app.getgraft.ai/mcp")).toBe(false);
  });

  it("carries the request into the console's consent URL, under a path-prefixed console too", () => {
    const url = new URL(
      mcpConsentUrl("https://app.getgraft.ai/console/", { client_id: "c1", state: "s", scope: "" }),
    );
    expect(url.pathname).toBe("/console/consent");
    expect(url.searchParams.get("client_id")).toBe("c1");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("registration (RFC 7591)", () => {
  it("issues an id and no secret to a public client, echoing what Graft will honour", async () => {
    const h = harness();
    const answer = await registered(h);
    expect(answer.client_id).toBe("id_1");
    expect(answer).not.toHaveProperty("client_secret");
    expect(answer.client_name).toBe("Claude");
    expect(answer.redirect_uris).toEqual([REDIRECT]);
    expect(answer.token_endpoint_auth_method).toBe("none");
    expect(answer.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(answer.response_types).toEqual(["code"]);
    expect(h.store.clients.get("id_1")?.secretHash).toBeNull();
  });

  it("issues a confidential client a secret once and stores only its hash; the method defaults to client_secret_basic", async () => {
    const h = harness();
    const answer = await registered(h, { token_endpoint_auth_method: undefined });
    expect(answer.client_secret?.startsWith(MCP_CLIENT_SECRET_PREFIX)).toBe(true);
    expect(answer.client_secret_expires_at).toBe(0);
    expect(answer.token_endpoint_auth_method).toBe("client_secret_basic");
    const row = h.store.clients.get(answer.client_id);
    expect(row?.secretHash).toBe(hashAgentToken(answer.client_secret ?? ""));
    expect(JSON.stringify(row)).not.toContain(answer.client_secret);
  });

  it("names a client that registered no name, and trims and bounds one that did", () => {
    expect(validateClientRegistration({ redirect_uris: [REDIRECT] }).name).toBe("An MCP client");
    expect(
      validateClientRegistration({
        redirect_uris: [REDIRECT],
        client_name: `  ${"x".repeat(200)} `,
      }).name,
    ).toHaveLength(100);
  });

  it("refuses a redirect URI outside the specification's rule, and metadata Graft does not offer", () => {
    const attempt = (body: unknown) => {
      try {
        validateClientRegistration(body);
        return null;
      } catch (error) {
        return error instanceof OAuthProtocolError ? error.error : "not-protocol";
      }
    };
    expect(attempt({})).toBe("invalid_redirect_uri");
    expect(attempt({ redirect_uris: [] })).toBe("invalid_redirect_uri");
    expect(attempt({ redirect_uris: ["http://evil.example/cb"] })).toBe("invalid_redirect_uri");
    expect(attempt(registration({ token_endpoint_auth_method: "private_key_jwt" }))).toBe(
      "invalid_client_metadata",
    );
    expect(attempt(registration({ grant_types: ["implicit"] }))).toBe("invalid_client_metadata");
    expect(attempt(registration({ grant_types: ["refresh_token"] }))).toBe(
      "invalid_client_metadata",
    );
    expect(attempt(registration({ response_types: ["token"] }))).toBe("invalid_client_metadata");
    expect(attempt("nope")).toBe("invalid_client_metadata");
  });

  it("bounds the registration: at most ten redirect URIs, none over 2048 characters", () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb/${i}`);
    expect(() => validateClientRegistration({ redirect_uris: many })).toThrow(OAuthProtocolError);
    expect(() =>
      validateClientRegistration({ redirect_uris: [`https://claude.ai/${"x".repeat(2100)}`] }),
    ).toThrow(OAuthProtocolError);
    expect(
      validateClientRegistration({ redirect_uris: many.slice(0, 10) }).redirectUris,
    ).toHaveLength(10);
  });

  it("keeps an https client_uri and logo_uri and drops one that is not", () => {
    const kept = validateClientRegistration(
      registration({ client_uri: "https://claude.ai", logo_uri: "http://claude.ai/logo.png" }),
    );
    expect(kept.clientUri).toBe("https://claude.ai/");
    expect(kept.logoUri).toBeNull();
  });
});

describe("the authorization request", () => {
  const params = (clientId: string, extra: Record<string, string | undefined> = {}) =>
    readAuthorizationRequestParams(
      new URLSearchParams(
        Object.fromEntries(
          Object.entries({
            client_id: clientId,
            redirect_uri: REDIRECT,
            response_type: "code",
            code_challenge: generatePkce().challenge,
            code_challenge_method: "S256",
            state: "xyz",
            ...extra,
          }).filter(([, value]) => value !== undefined) as [string, string][],
        ),
      ),
    );

  it("passes a well-formed request, resolving the resource to the endpoint's canonical URL", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const verdict = await judgeAuthorizationRequest(
      ctx,
      params(client_id, { resource: "https://APP.getgraft.ai/mcp/" }),
      h.deps,
      CONFIG,
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.client.name).toBe("Claude");
    expect(verdict.request).toMatchObject({
      clientId: client_id,
      redirectUri: REDIRECT,
      state: "xyz",
      scope: null,
      resource: "https://app.getgraft.ai/mcp",
    });
  });

  it("refuses an unknown client, a missing or unregistered redirect URI, without a redirect", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const unknown = await judgeAuthorizationRequest(ctx, params("nobody"), h.deps, CONFIG);
    expect(unknown).toMatchObject({ ok: false, redirectable: false, reason: "unknown_client" });
    const none = await judgeAuthorizationRequest(ctx, params(""), h.deps, CONFIG);
    expect(none).toMatchObject({ ok: false, redirectable: false, reason: "unknown_client" });
    const other = validateAuthorizationRequest(
      h.store.clients.get(client_id) ?? null,
      params(client_id, { redirect_uri: "https://claude.ai/other" }),
      CONFIG,
    );
    expect(other).toMatchObject({
      ok: false,
      redirectable: false,
      reason: "redirect_uri_unregistered",
    });
    // A client with two registered URIs that names none is refused; one with exactly one is honoured.
    const two = {
      ...(h.store.clients.get(client_id) as McpClientRow),
      redirectUris: [REDIRECT, "https://x.example/cb"],
    };
    expect(
      validateAuthorizationRequest(two, params(client_id, { redirect_uri: undefined }), CONFIG),
    ).toMatchObject({ ok: false, reason: "redirect_uri_missing" });
    const one = validateAuthorizationRequest(
      h.store.clients.get(client_id) ?? null,
      params(client_id, { redirect_uri: undefined }),
      CONFIG,
    );
    expect(one.ok).toBe(true);
  });

  it("sends the client's own mistakes back to its registered URI as an error, with the state and the issuer", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const client = h.store.clients.get(client_id) ?? null;
    const cases: [Record<string, string | undefined>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: undefined }, "invalid_request"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ];
    for (const [extra, error] of cases) {
      const verdict = validateAuthorizationRequest(client, params(client_id, extra), CONFIG);
      expect(verdict).toMatchObject({
        ok: false,
        redirectable: true,
        error,
        redirectUri: REDIRECT,
      });
      if (verdict.ok || !verdict.redirectable) throw new Error("unreachable");
      const url = new URL(authorizationErrorRedirect(verdict, CONFIG));
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get("error")).toBe(error);
      expect(url.searchParams.get("state")).toBe("xyz");
      expect(url.searchParams.get("iss")).toBe("https://app.getgraft.ai");
    }
  });
});

describe("the consent (ADR 0018: it mints the agent)", () => {
  it("mints an agent named for the client with the chosen scope, binds a code to it, and sends the browser back with code, state and iss", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { outcome, code, pkce } = await consented(h, client_id, { state: "s1", scope: "mcp" });

    const url = new URL(outcome.redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("iss")).toBe("https://app.getgraft.ai");
    expect(code.startsWith(MCP_AUTHORIZATION_CODE_PREFIX)).toBe(true);

    expect(outcome.agent).toMatchObject({
      name: "Claude",
      tokenPrefix: null,
      connectedVia: { clientId: client_id, clientName: "Claude" },
    });
    const inserted = vi.mocked(h.agentDeps.insertAgent).mock.calls[0]?.[1];
    expect(inserted).toMatchObject({ tokenHash: null, tokenPrefix: null, name: "Claude" });
    expect(h.agentDeps.replaceAgentConnections).toHaveBeenCalledWith(
      expect.anything(),
      { personId: "person_1", agentId: outcome.agent?.id },
      ["conn_1"],
    );

    const row = [...h.store.codes.values()][0];
    expect(row).toMatchObject({
      codeHash: hashAgentToken(code),
      clientId: client_id,
      agentId: outcome.agent?.id,
      redirectUri: REDIRECT,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      resource: "https://app.getgraft.ai/mcp",
      scope: "mcp",
      consumedAt: null,
    });
    expect(row?.expiresAt).toEqual(
      new Date(NOW.getTime() + MCP_AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    );
    expect(JSON.stringify([...h.store.codes.values()])).not.toContain(code);
  });

  it("binds the code to an existing agent of the person's instead, recording the client on it", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { outcome } = await consented(h, client_id, { agent: "existing" });
    expect(outcome.agent?.id).toBe("agent_1");
    expect(outcome.agent?.connectedVia).toEqual({ clientId: client_id, clientName: "Claude" });
    expect(h.agentDeps.insertAgent).not.toHaveBeenCalled();
    expect([...h.store.codes.values()][0]?.agentId).toBe("agent_1");
  });

  it("sends a deny back as access_denied with the state, minting nothing", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const pkce = generatePkce();
    const outcome = await decideConsent(
      ctx,
      PRINCIPAL,
      {
        client_id,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state: "s2",
      },
      { decision: "deny" },
      h.deps,
      h.agentDeps,
      CONFIG,
    );
    const url = new URL(outcome.redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("s2");
    expect(outcome.agent).toBeNull();
    expect(h.agentDeps.insertAgent).not.toHaveBeenCalled();
    expect(h.store.codes.size).toBe(0);
  });

  it("judges the request again and refuses an unregistered redirect URI as BAD_REQUEST, minting nothing", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const attempt = decideConsent(
      ctx,
      PRINCIPAL,
      {
        client_id,
        redirect_uri: "https://evil.example/cb",
        response_type: "code",
        code_challenge: generatePkce().challenge,
        code_challenge_method: "S256",
      },
      { decision: "allow", agent: { kind: "new", name: "Claude", connectionIds: [] } },
      h.deps,
      h.agentDeps,
      CONFIG,
    );
    await expect(attempt).rejects.toThrow(ServiceError);
    await expect(attempt).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { reason: "redirect_uri_unregistered" },
    });
    expect(h.agentDeps.insertAgent).not.toHaveBeenCalled();
  });

  it("refuses to lend a revoked agent or another person's agent to a client", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    h.store.agents.set("agent_1", agentRow("agent_1", { revokedAt: NOW }));
    await expect(consented(h, client_id, { agent: "existing" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    h.store.agents.set("agent_1", agentRow("agent_1", { personId: "person_2" }));
    await expect(consented(h, client_id, { agent: "existing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.store.codes.size).toBe(0);
  });
});

describe("client authentication (RFC 6749 §2.3)", () => {
  it("admits a public client by id alone, and a confidential one by its secret from either method", async () => {
    const h = harness();
    const pub = await registered(h);
    await expect(
      authenticateClient(
        ctx,
        { clientId: pub.client_id, clientSecret: null, viaHeader: false },
        h.deps,
      ),
    ).resolves.toMatchObject({ id: pub.client_id });

    const conf = await registered(h, { token_endpoint_auth_method: "client_secret_post" });
    await expect(
      authenticateClient(
        ctx,
        { clientId: conf.client_id, clientSecret: conf.client_secret ?? null, viaHeader: true },
        h.deps,
      ),
    ).resolves.toMatchObject({ id: conf.client_id });
  });

  it("refuses an unknown client, a missing secret and a wrong secret as one invalid_client at 401", async () => {
    const h = harness();
    const conf = await registered(h, { token_endpoint_auth_method: "client_secret_basic" });
    for (const presented of [
      { clientId: null, clientSecret: null, viaHeader: false },
      { clientId: "nobody", clientSecret: "x", viaHeader: false },
      { clientId: conf.client_id, clientSecret: null, viaHeader: false },
      { clientId: conf.client_id, clientSecret: "grfts_wrong", viaHeader: true },
    ]) {
      const attempt = authenticateClient(ctx, presented, h.deps);
      await expect(attempt).rejects.toThrow(OAuthProtocolError);
      await expect(attempt).rejects.toMatchObject({ error: "invalid_client", status: 401 });
    }
  });
});

describe("the token endpoint", () => {
  const client = (h: ReturnType<typeof harness>, id: string) =>
    h.store.clients.get(id) as McpClientRow;

  it("exchanges a code for an access token and a refresh token bound to the agent, both stored as hashes", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce, outcome } = await consented(h, client_id, { scope: "mcp" });

    const tokens = await grantTokens(
      ctx,
      client(h, client_id),
      {
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        redirect_uri: REDIRECT,
        resource: "https://app.getgraft.ai/mcp",
      },
      h.deps,
      CONFIG,
    );
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      scope: "mcp",
    });
    expect(tokens.access_token.startsWith(MCP_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokens.refresh_token.startsWith(MCP_REFRESH_TOKEN_PREFIX)).toBe(true);

    const rows = [...h.store.tokens.values()];
    expect(rows.map((row) => row.kind).sort()).toEqual(["access", "refresh"]);
    for (const row of rows) {
      expect(row.agentId).toBe(outcome.agent?.id);
      expect(row.clientId).toBe(client_id);
      expect(row.grantId).toBe([...h.store.codes.values()][0]?.id);
    }
    expect(rows.find((row) => row.kind === "access")?.tokenHash).toBe(
      hashAgentToken(tokens.access_token),
    );
    expect(rows.find((row) => row.kind === "access")?.expiresAt).toEqual(
      new Date(NOW.getTime() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000),
    );
    expect(rows.find((row) => row.kind === "refresh")?.expiresAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(tokens.access_token);
    expect(JSON.stringify(rows)).not.toContain(tokens.refresh_token);

    // The door's read resolves the access token to the agent.
    await expect(
      h.deps.findAgentByMcpAccessTokenHash(ctx.db, hashAgentToken(tokens.access_token)),
    ).resolves.toMatchObject({ agentId: outcome.agent?.id, personId: "person_1" });
  });

  it("refuses a wrong verifier, another client's code, another redirect URI, an expired code and a foreign resource as invalid_grant or invalid_target, issuing nothing", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const other = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT };

    const attempt = async (who: string, form: Record<string, string | undefined>) => {
      try {
        await grantTokens(ctx, client(h, who), form, h.deps, CONFIG);
        return null;
      } catch (error) {
        return error instanceof OAuthProtocolError ? error.error : "not-protocol";
      }
    };
    expect(await attempt(client_id, { ...base, code_verifier: generatePkce().verifier })).toBe(
      "invalid_grant",
    );
    expect(await attempt(other.client_id, { ...base, code_verifier: pkce.verifier })).toBe(
      "invalid_grant",
    );
    expect(
      await attempt(client_id, {
        ...base,
        code_verifier: pkce.verifier,
        redirect_uri: "https://claude.ai/other",
      }),
    ).toBe("invalid_grant");
    expect(
      await attempt(client_id, {
        ...base,
        code_verifier: pkce.verifier,
        resource: "https://other.example/mcp",
      }),
    ).toBe("invalid_target");
    expect(await attempt(client_id, { ...base, code_verifier: undefined })).toBe("invalid_request");
    expect(await attempt(client_id, { grant_type: "client_credentials" })).toBe(
      "unsupported_grant_type",
    );
    expect(h.store.tokens.size).toBe(0);

    h.store.clock.now = new Date(NOW.getTime() + MCP_AUTHORIZATION_CODE_TTL_SECONDS * 1000);
    expect(await attempt(client_id, { ...base, code_verifier: pkce.verifier })).toBe(
      "invalid_grant",
    );
    expect(h.store.tokens.size).toBe(0);
  });

  it("spends a code once: the second exchange is refused and revokes every token the first issued", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const form = { grant_type: "authorization_code", code, code_verifier: pkce.verifier };
    const first = await grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG);
    const again = grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG);
    await expect(again).rejects.toMatchObject({ error: "invalid_grant" });
    expect(
      await h.deps.findAgentByMcpAccessTokenHash(ctx.db, hashAgentToken(first.access_token)),
    ).toBeNull();
    for (const row of h.store.tokens.values()) expect(row.revokedAt).toEqual(h.store.clock.now);
  });

  it("refuses a code bound to an agent revoked since the consent, minting nothing", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce, outcome } = await consented(h, client_id);
    const agent = h.store.agents.get(outcome.agent?.id ?? "");
    if (agent) h.store.agents.set(agent.id, { ...agent, revokedAt: NOW });
    await expect(
      grantTokens(
        ctx,
        client(h, client_id),
        { grant_type: "authorization_code", code, code_verifier: pkce.verifier },
        h.deps,
        CONFIG,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect(h.store.tokens.size).toBe(0);
    // And a refresh token whose agent is revoked afterwards is refused the same way.
    h.store.agents.set(agent?.id ?? "", { ...(agent as AgentRow), revokedAt: null });
    const { code: code2, pkce: pkce2 } = await consented(h, client_id, { agent: "existing" });
    const tokens = await grantTokens(
      ctx,
      client(h, client_id),
      { grant_type: "authorization_code", code: code2, code_verifier: pkce2.verifier },
      h.deps,
      CONFIG,
    );
    h.store.agents.set("agent_1", agentRow("agent_1", { revokedAt: NOW }));
    await expect(
      grantTokens(
        ctx,
        client(h, client_id),
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
        h.deps,
        CONFIG,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  /** Two exchanges racing on one code: one pair, and the loser's refusal revokes it (RFC 6749 §4.1.2). */
  it("settles two concurrent exchanges of one code in favour of one, and the other revokes the winner's tokens", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const form = { grant_type: "authorization_code", code, code_verifier: pkce.verifier };
    const results = await Promise.allSettled([
      grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG),
      grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ error: "invalid_grant" });
    // Exactly one pair was minted, and the loser's refusal took it down with the grant.
    expect(h.store.tokens.size).toBe(2);
    for (const row of h.store.tokens.values()) expect(row.revokedAt).toEqual(NOW);
    expect(h.deps.revokeMcpGrant).toHaveBeenCalledTimes(1);
  });

  /** Two refreshes racing on one token: one successor, the other refused, the grant standing. */
  it("settles two concurrent refreshes of one token in favour of one successor", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const first = await grantTokens(
      ctx,
      client(h, client_id),
      { grant_type: "authorization_code", code, code_verifier: pkce.verifier },
      h.deps,
      CONFIG,
    );
    const form = { grant_type: "refresh_token", refresh_token: first.refresh_token };
    const results = await Promise.allSettled([
      grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG),
      grantTokens(ctx, client(h, client_id), form, h.deps, CONFIG),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    // The first pair, plus exactly one successor pair; nothing revoked.
    expect(h.store.tokens.size).toBe(4);
    expect([...h.store.tokens.values()].every((row) => row.revokedAt === null)).toBe(true);
    expect(h.deps.revokeMcpGrant).not.toHaveBeenCalled();
  });

  it("refreshes: a new pair under the same grant, the old refresh token rotated; presented again inside the grace window it is refused with the grant standing, past it the grant is revoked", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const first = await grantTokens(
      ctx,
      client(h, client_id),
      { grant_type: "authorization_code", code, code_verifier: pkce.verifier },
      h.deps,
      CONFIG,
    );
    const grantId = [...h.store.tokens.values()][0]?.grantId;

    h.store.clock.now = new Date(NOW.getTime() + 10_000);
    const second = await grantTokens(
      ctx,
      client(h, client_id),
      { grant_type: "refresh_token", refresh_token: first.refresh_token },
      h.deps,
      CONFIG,
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    const rotated = [...h.store.tokens.values()].find(
      (row) => row.tokenHash === hashAgentToken(first.refresh_token),
    );
    expect(rotated?.rotatedAt).toEqual(h.store.clock.now);
    expect(rotated?.revokedAt).toBeNull();
    for (const row of h.store.tokens.values()) expect(row.grantId).toBe(grantId);
    expect(h.deps.pruneMcpExpired).toHaveBeenCalled();

    // Inside the grace window the same old token is refused as a benign retry: no successor, the
    // grant untouched, the client's way back the successor it already holds.
    h.store.clock.now = new Date(NOW.getTime() + 10_000 + MCP_REFRESH_GRACE_SECONDS * 1000);
    await expect(
      grantTokens(
        ctx,
        client(h, client_id),
        { grant_type: "refresh_token", refresh_token: first.refresh_token },
        h.deps,
        CONFIG,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect(h.store.tokens.size).toBe(4);
    expect([...h.store.tokens.values()].every((row) => row.revokedAt === null)).toBe(true);

    // Past it, the same presentation is a replay: refused, and every token of the grant is revoked.
    h.store.clock.now = new Date(NOW.getTime() + 10_000 + MCP_REFRESH_GRACE_SECONDS * 1000 + 1);
    await expect(
      grantTokens(
        ctx,
        client(h, client_id),
        { grant_type: "refresh_token", refresh_token: first.refresh_token },
        h.deps,
        CONFIG,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    for (const row of h.store.tokens.values()) expect(row.revokedAt).toEqual(h.store.clock.now);
    await expect(
      grantTokens(
        ctx,
        client(h, client_id),
        { grant_type: "refresh_token", refresh_token: second.refresh_token },
        h.deps,
        CONFIG,
      ),
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refuses another client's refresh token and an unknown one alike", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const other = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const tokens = await grantTokens(
      ctx,
      client(h, client_id),
      { grant_type: "authorization_code", code, code_verifier: pkce.verifier },
      h.deps,
      CONFIG,
    );
    for (const [who, token] of [
      [other.client_id, tokens.refresh_token],
      [client_id, "grftr_nobody"],
      [client_id, undefined],
    ] as const) {
      const attempt = grantTokens(
        ctx,
        client(h, who),
        { grant_type: "refresh_token", refresh_token: token },
        h.deps,
        CONFIG,
      );
      await expect(attempt).rejects.toThrow(OAuthProtocolError);
    }
    // The legitimate holder's token is untouched by the others' attempts.
    expect([...h.store.tokens.values()].every((row) => row.revokedAt === null)).toBe(true);
  });
});

describe("revocation (RFC 7009)", () => {
  it("revokes a refresh token with its whole grant, an access token alone, and says nothing about a stranger's", async () => {
    const h = harness();
    const { client_id } = await registered(h);
    const other = await registered(h);
    const { code, pkce } = await consented(h, client_id);
    const tokens = await grantTokens(
      ctx,
      h.store.clients.get(client_id) as McpClientRow,
      { grant_type: "authorization_code", code, code_verifier: pkce.verifier },
      h.deps,
      CONFIG,
    );

    // Another client, or a token nobody issued: nothing happens, nothing is said.
    await revokeToken(
      ctx,
      h.store.clients.get(other.client_id) as McpClientRow,
      tokens.refresh_token,
      h.deps,
    );
    await revokeToken(ctx, h.store.clients.get(client_id) as McpClientRow, "grfta_nobody", h.deps);
    expect([...h.store.tokens.values()].every((row) => row.revokedAt === null)).toBe(true);

    // The access token alone: the refresh token goes on working.
    await revokeToken(
      ctx,
      h.store.clients.get(client_id) as McpClientRow,
      tokens.access_token,
      h.deps,
    );
    expect(
      await h.deps.findAgentByMcpAccessTokenHash(ctx.db, hashAgentToken(tokens.access_token)),
    ).toBeNull();
    const refreshed = await grantTokens(
      ctx,
      h.store.clients.get(client_id) as McpClientRow,
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      h.deps,
      CONFIG,
    );

    // The refresh token: the grant, access tokens included.
    await revokeToken(
      ctx,
      h.store.clients.get(client_id) as McpClientRow,
      refreshed.refresh_token,
      h.deps,
    );
    for (const row of h.store.tokens.values()) expect(row.revokedAt).not.toBeNull();
  });
});
