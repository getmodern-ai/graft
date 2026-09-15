import { timingSafeEqual } from "node:crypto";

import type { AgentConnectedVia } from "@graft/db/repo/agent";
import type { McpAuthorizationCodeRow, McpClientRow } from "@graft/db/repo/mcp-oauth";
import { type McpClientAuthMethod, mcpClientAuthMethod } from "@graft/db/schema/mcp-oauth";

import type { AgentDeps } from "../agent/agent.deps";
import {
  type AgentOutput,
  connectExistingAgentToClient,
  createAgentForClient,
} from "../agent/agent.service";
import { pkceChallenge } from "../connection/oauth-consent";
import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import {
  hashAgentToken,
  MCP_ACCESS_TOKEN_PREFIX,
  MCP_AUTHORIZATION_CODE_PREFIX,
  MCP_CLIENT_SECRET_PREFIX,
  MCP_REFRESH_TOKEN_PREFIX,
  mintOpaqueToken,
  type Principal,
} from "../tenancy";
import type { McpOAuthDeps } from "./mcp-oauth.deps";
import { openRotationReplay, sealRotationReplay } from "./mcp-oauth.replay";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  type AuthorizationRequestParams,
  clientRedirect,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  MCP_OAUTH_PATHS,
  mcpIssuer,
  mcpResourceUrl,
  PROTECTED_RESOURCE_METADATA_PATH,
  sameResource,
} from "./mcp-oauth.rules";

/**
 * Graft as the authorization server for its own MCP endpoint (ADR 0018): the subset of OAuth 2.1
 * the MCP authorization specification asks a server to speak so that a chat product can connect by
 * URL alone — RFC 8414 and RFC 9728 metadata, RFC 7591 registration, the authorization code grant
 * with PKCE `S256` required, RFC 8707 resource indicators, refresh with rotation, RFC 7009
 * revocation. **The subject of every token is an agent**: the person's consent mints one or names
 * one, the code is bound to it, and everything a client does with the token is that agent's —
 * its scope, its working set, its approvals, its history. Nothing here is a person's token.
 *
 * Plain functions with injected deps, as every service in this package; the HTTP shapes — the form
 * bodies, the header parsing, the redirects — are `apps/server/src/mcp-oauth.ts`'s. A refusal on
 * the protocol's own endpoints is an `OAuthProtocolError`, RFC 6749 §5.2's `{ error,
 * error_description }` at 400 or 401; a refusal on the console's consent routes is a
 * `ServiceError` like any other route's.
 */

/** An hour, as the MCP specification's "short-lived" suggests; the refresh token is what lasts. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 3600;
/** RFC 6749 §4.1.2's recommended maximum. */
export const MCP_AUTHORIZATION_CODE_TTL_SECONDS = 600;
/**
 * How long after a refresh token was rotated a second presentation of it is read as a retry and
 * **answered with the same successor pair** — a client whose refresh succeeded but whose response
 * was lost recovers without the person consenting again. Past it, the same presentation is a
 * replay and revokes every token of the grant (OAuth 2.1 §4.3.1). Thirty seconds is the window
 * `@better-auth/mcp` settled on for the same clients. The pair is kept sealed under the retired
 * token itself (`mcp-oauth.replay.ts`), never in the clear, so the database alone cannot open it.
 */
export const MCP_REFRESH_GRACE_SECONDS = 30;
/** RFC 7591 registration bounds — an open, unauthenticated write, so every field it stores is bounded. */
export const MCP_REGISTRATION_MAX_BYTES = 16 * 1024;
export const MCP_MAX_REDIRECT_URIS = 10;
export const MCP_REDIRECT_URI_MAX_LENGTH = 2048;
/** Dead access tokens and expired codes older than this are deleted on the way past. */
export const MCP_PRUNE_AFTER_SECONDS = 24 * 60 * 60;
export const MCP_CLIENT_NAME_MAX_LENGTH = 100;
/** What the consent page shows for a client that registered no `client_name`. */
export const MCP_CLIENT_NAME_PLACEHOLDER = "An MCP client";

/** What the server knows that the rules cannot: the issuer, from `GRAFT_AUTH_URL`. */
export type McpOAuthConfig = { authUrl: string };

/** RFC 6749 §5.2 and RFC 7591 §3.2.2: the protocol's own refusal shape, at its own status. */
export class OAuthProtocolError extends Error {
  constructor(
    public readonly error: string,
    description: string,
    public readonly status: 400 | 401 = 400,
  ) {
    super(description);
    this.name = "OAuthProtocolError";
  }

  get body(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Metadata (RFC 8414, RFC 9728)
// ---------------------------------------------------------------------------------------------

/**
 * RFC 8414 §2: what the products need to know and nothing Graft does not do. `code` alone; PKCE
 * `S256` alone (`plain` is not offered — OAuth 2.1 withdrew it); the three client authentication
 * methods RFC 7591 defaults among; registration open, because both products register at connect
 * time. No `scopes_supported`: Graft attaches no meaning to the OAuth scope string — the agent's
 * scope, the connections it may use, is chosen on the consent page (CONTEXT.md, *Scope*).
 */
export function authorizationServerMetadata(config: McpOAuthConfig) {
  const issuer = mcpIssuer(config.authUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}${MCP_OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${MCP_OAUTH_PATHS.token}`,
    registration_endpoint: `${issuer}${MCP_OAUTH_PATHS.register}`,
    revocation_endpoint: `${issuer}${MCP_OAUTH_PATHS.revoke}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...mcpClientAuthMethod],
    revocation_endpoint_auth_methods_supported: [...mcpClientAuthMethod],
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://docs.getgraft.ai/graft/harnesses/claude-and-chatgpt",
  };
}

/** RFC 9728 §2: the MCP endpoint names its authorization server — this same origin. */
export function protectedResourceMetadata(config: McpOAuthConfig) {
  return {
    resource: mcpResourceUrl(config.authUrl),
    authorization_servers: [mcpIssuer(config.authUrl)],
    bearer_methods_supported: ["header"],
    resource_name: "Graft",
    resource_documentation: "https://docs.getgraft.ai/graft/harnesses/any-mcp-client",
  };
}

/** The two documents' paths, for the server to mount; re-exported so the mount and the rules cannot drift. */
export const MCP_METADATA_PATHS = {
  authorizationServer: AUTHORIZATION_SERVER_METADATA_PATH,
  protectedResource: PROTECTED_RESOURCE_METADATA_PATH,
} as const;

// ---------------------------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------------------------

export type ClientRegistration = {
  redirectUris: string[];
  tokenEndpointAuthMethod: McpClientAuthMethod;
  name: string;
  scope: string | null;
  clientUri: string | null;
  logoUri: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
};

const optionalString = (value: unknown, max = 500): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;

const optionalHttpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * RFC 7591 §2, as much of it as Graft reads. Refused as `invalid_redirect_uri` for a redirect URI
 * the MCP specification's communication-security rule excludes, and `invalid_client_metadata` for
 * a grant, response type or authentication method Graft does not offer — a client asking for
 * `implicit` or `client_credentials` would never get a token, and is better told at registration.
 * Everything optional is kept if it parses and dropped if it does not; a broken `logo_uri` is not
 * a reason to refuse a connection.
 */
export function validateClientRegistration(body: unknown): ClientRegistration {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OAuthProtocolError("invalid_client_metadata", "The registration is not an object");
  }
  const input = body as Record<string, unknown>;

  const redirectUris = input.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthProtocolError(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of absolute URIs",
    );
  }
  if (redirectUris.length > MCP_MAX_REDIRECT_URIS) {
    throw new OAuthProtocolError(
      "invalid_redirect_uri",
      `redirect_uris may name at most ${MCP_MAX_REDIRECT_URIS} URIs`,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri === "string" && uri.length > MCP_REDIRECT_URI_MAX_LENGTH) {
      throw new OAuthProtocolError(
        "invalid_redirect_uri",
        `A redirect URI is at most ${MCP_REDIRECT_URI_MAX_LENGTH} characters`,
      );
    }
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      throw new OAuthProtocolError(
        "invalid_redirect_uri",
        `A redirect URI must be https, or http on localhost, with no fragment: ${String(uri)}`,
      );
    }
  }

  const method = input.token_endpoint_auth_method ?? "client_secret_basic";
  if (!(mcpClientAuthMethod as readonly unknown[]).includes(method)) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of ${mcpClientAuthMethod.join(", ")}`,
    );
  }

  const grantTypes = input.grant_types ?? ["authorization_code"];
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")
  ) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      "grant_types may name authorization_code and refresh_token only",
    );
  }
  if (!grantTypes.includes("authorization_code")) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      "grant_types must include authorization_code — it is the one way to a token",
    );
  }

  const responseTypes = input.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== "code")) {
    throw new OAuthProtocolError("invalid_client_metadata", "response_types may name code only");
  }

  const name = optionalString(input.client_name, MCP_CLIENT_NAME_MAX_LENGTH);
  return {
    redirectUris: [...new Set(redirectUris as string[])],
    tokenEndpointAuthMethod: method as McpClientAuthMethod,
    name: name ?? MCP_CLIENT_NAME_PLACEHOLDER,
    scope: optionalString(input.scope),
    clientUri: optionalHttpsUrl(input.client_uri),
    logoUri: optionalHttpsUrl(input.logo_uri),
    softwareId: optionalString(input.software_id, 200),
    softwareVersion: optionalString(input.software_version, 100),
  };
}

/** RFC 7591 §3.2.1: the registration as the client reads it back, the secret in it once and never again. */
export type ClientRegistrationResponse = {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: 0;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: McpClientAuthMethod;
  grant_types: string[];
  response_types: string[];
  scope?: string;
  client_uri?: string;
  logo_uri?: string;
  software_id?: string;
  software_version?: string;
};

/**
 * Register a client (RFC 7591 §3). Unauthenticated, because a chat product registers before any
 * person is involved; what it gets is an id and, unless it is a public client, a secret it is shown
 * once — the row keeps the secret's hash, as the agent row keeps its token's. Every registration is
 * a row: two connectors from one product are two clients, each with its own consent and its own
 * agent, which is the grain the person revokes at.
 */
export async function registerMcpClient(
  ctx: ServiceContext,
  body: unknown,
  deps: McpOAuthDeps,
): Promise<ClientRegistrationResponse> {
  const registration = validateClientRegistration(body);
  const secret =
    registration.tokenEndpointAuthMethod === "none"
      ? null
      : mintOpaqueToken(MCP_CLIENT_SECRET_PREFIX, deps.randomBytes);
  const grantTypes = ["authorization_code", "refresh_token"];
  const responseTypes = ["code"];
  const row = await deps.insertMcpClient(ctx.db, {
    id: deps.newId(),
    secretHash: secret?.hash ?? null,
    name: registration.name,
    redirectUris: registration.redirectUris,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    grantTypes,
    responseTypes,
    scope: registration.scope,
    clientUri: registration.clientUri,
    logoUri: registration.logoUri,
    softwareId: registration.softwareId,
    softwareVersion: registration.softwareVersion,
  });
  return {
    client_id: row.id,
    ...(secret ? { client_secret: secret.value, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.name,
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.clientUri ? { client_uri: row.clientUri } : {}),
    ...(row.logoUri ? { logo_uri: row.logoUri } : {}),
    ...(row.softwareId ? { software_id: row.softwareId } : {}),
    ...(row.softwareVersion ? { software_version: row.softwareVersion } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The authorization request (RFC 6749 §4.1.1, RFC 7636, RFC 8707)
// ---------------------------------------------------------------------------------------------

/** A request every check passed: what the consent page shows and what a code is bound to. */
export type ValidAuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  /** The canonical resource — the client's, when it sent one and it matched, else the endpoint's own. */
  resource: string;
};

/** The client as the consent page describes it — never the secret's hash. */
export type McpClientDescription = {
  id: string;
  name: string;
  clientUri: string | null;
  logoUri: string | null;
};

export function describeClient(row: McpClientRow): McpClientDescription {
  return { id: row.id, name: row.name, clientUri: row.clientUri, logoUri: row.logoUri };
}

/**
 * Why an authorization request could not go on. The first kind is not redirected anywhere: the
 * client or the redirect URI is the thing in doubt, and OAuth 2.1 §4.1.2.1 forbids sending the
 * browser to a URI the server has not confirmed — the console shows the person a refusal instead.
 * The second kind goes back to the client's registered URI as an error, which is where a client's
 * own mistake belongs.
 */
export type AuthorizationRefusalReason =
  | "unknown_client"
  | "redirect_uri_missing"
  | "redirect_uri_unregistered";

export type AuthorizationVerdict =
  | { ok: true; client: McpClientRow; request: ValidAuthorizationRequest }
  | { ok: false; redirectable: false; reason: AuthorizationRefusalReason; message: string }
  | {
      ok: false;
      redirectable: true;
      redirectUri: string;
      error: string;
      description: string;
      state: string | null;
    };

/**
 * Validate an authorization request against its client — a pure function over the row and the
 * parameters, so the authorization endpoint, the consent page's describing route and the consent's
 * submit apply the same checks and cannot disagree. Redirect URIs match exactly (MCP
 * authorization specification, "Open Redirection"); a request with none is honoured only when the
 * client registered exactly one, as RFC 6749 §3.1.2.3 allows. PKCE is not optional: a request
 * without `S256` is refused, because every client the specification admits sends it and a code
 * without a challenge is a code any interceptor can spend.
 */
export function validateAuthorizationRequest(
  client: McpClientRow | null,
  params: AuthorizationRequestParams,
  config: McpOAuthConfig,
): AuthorizationVerdict {
  if (!params.client_id || !client) {
    return {
      ok: false,
      redirectable: false,
      reason: "unknown_client",
      message: "This request names no registered client",
    };
  }
  let redirectUri: string;
  if (params.redirect_uri) {
    if (!client.redirectUris.includes(params.redirect_uri)) {
      return {
        ok: false,
        redirectable: false,
        reason: "redirect_uri_unregistered",
        message: `${client.name} asked to be sent to an address it did not register`,
      };
    }
    redirectUri = params.redirect_uri;
  } else if (client.redirectUris.length === 1 && client.redirectUris[0]) {
    redirectUri = client.redirectUris[0];
  } else {
    return {
      ok: false,
      redirectable: false,
      reason: "redirect_uri_missing",
      message: `${client.name} did not say where to send you back`,
    };
  }

  const state = params.state ?? null;
  const back = (error: string, description: string): AuthorizationVerdict => ({
    ok: false,
    redirectable: true,
    redirectUri,
    error,
    description,
    state,
  });

  if (params.response_type !== "code") {
    return back("unsupported_response_type", "response_type must be code");
  }
  if (!params.code_challenge) {
    return back("invalid_request", "code_challenge is required (PKCE, S256)");
  }
  if (!isValidCodeChallenge(params.code_challenge)) {
    return back("invalid_request", "code_challenge must be 43 to 128 unreserved characters");
  }
  if (params.code_challenge_method !== "S256") {
    return back("invalid_request", "code_challenge_method must be S256");
  }
  const canonical = mcpResourceUrl(config.authUrl);
  if (params.resource !== undefined && !sameResource(params.resource, canonical)) {
    return back("invalid_target", `resource must be this MCP endpoint, ${canonical}`);
  }

  return {
    ok: true,
    client,
    request: {
      clientId: client.id,
      redirectUri,
      codeChallenge: params.code_challenge,
      state,
      scope: params.scope ?? null,
      resource: canonical,
    },
  };
}

/** The authorization endpoint's and the consent page's shared read: load the client, then judge the request. */
export async function judgeAuthorizationRequest(
  ctx: ServiceContext,
  params: AuthorizationRequestParams,
  deps: McpOAuthDeps,
  config: McpOAuthConfig,
): Promise<AuthorizationVerdict> {
  const client = params.client_id ? await deps.findMcpClient(ctx.db, params.client_id) : null;
  return validateAuthorizationRequest(client, params, config);
}

/** The redirect an invalid-but-redirectable request gets (RFC 6749 §4.1.2.1). */
export function authorizationErrorRedirect(
  verdict: Extract<AuthorizationVerdict, { redirectable: true }>,
  config: McpOAuthConfig,
): string {
  return clientRedirect(
    verdict.redirectUri,
    {
      error: verdict.error,
      error_description: verdict.description,
      state: verdict.state ?? undefined,
    },
    mcpIssuer(config.authUrl),
  );
}

// ---------------------------------------------------------------------------------------------
// The consent (ADR 0018: it mints the agent)
// ---------------------------------------------------------------------------------------------

/** What the person chose on the consent page: no, or yes as this agent. */
export type ConsentDecision =
  | { decision: "deny" }
  | {
      decision: "allow";
      agent:
        | { kind: "new"; name: string; connectionIds: readonly string[] }
        | { kind: "existing"; agentId: string };
    };

export type ConsentOutcome = {
  /** Where the console sends the browser: the client's redirect URI with the code, or the error. */
  redirectTo: string;
  /** The agent the grant is bound to, on an allow. */
  agent: AgentOutput | null;
};

/**
 * The consent's submit (ADR 0006: the console is the channel; ADR 0018: the consent mints the
 * agent). The request is judged again from its parameters — the console page is not trusted to
 * have kept them honest — and then, on an allow, the agent is minted or confirmed the person's and
 * a code bound to it, the client and the challenge is written; on a deny the client is told
 * `access_denied`. Both end in a redirect the console performs. The code is the only value that
 * crosses the browser, and it is spent once at the token endpoint.
 */
export async function decideConsent(
  ctx: ServiceContext,
  principal: Principal,
  params: AuthorizationRequestParams,
  decision: ConsentDecision,
  deps: McpOAuthDeps,
  agentDeps: AgentDeps,
  config: McpOAuthConfig,
): Promise<ConsentOutcome> {
  const verdict = await judgeAuthorizationRequest(ctx, params, deps, config);
  if (!verdict.ok) {
    if (verdict.redirectable) {
      return { redirectTo: authorizationErrorRedirect(verdict, config), agent: null };
    }
    throw new ServiceError("BAD_REQUEST", verdict.message, { details: { reason: verdict.reason } });
  }
  const issuer = mcpIssuer(config.authUrl);
  const { client, request } = verdict;

  if (decision.decision === "deny") {
    return {
      redirectTo: clientRedirect(
        request.redirectUri,
        {
          error: "access_denied",
          error_description: "The person declined to connect",
          state: request.state ?? undefined,
        },
        issuer,
      ),
      agent: null,
    };
  }

  const via: AgentConnectedVia = { clientId: client.id, clientName: client.name };
  const code = mintOpaqueToken(MCP_AUTHORIZATION_CODE_PREFIX, deps.randomBytes);
  const now = deps.now();

  const agent = await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const chosen =
      decision.agent.kind === "new"
        ? (
            await createAgentForClient(
              scoped,
              principal,
              {
                name: decision.agent.name,
                connectionIds: decision.agent.connectionIds,
                connectedVia: via,
              },
              agentDeps,
            )
          ).agent
        : await connectExistingAgentToClient(
            scoped,
            principal,
            decision.agent.agentId,
            via,
            agentDeps,
          );
    await deps.insertMcpAuthorizationCode(tx, {
      id: deps.newId(),
      codeHash: code.hash,
      clientId: client.id,
      agentId: chosen.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: "S256",
      resource: request.resource,
      scope: request.scope,
      expiresAt: new Date(now.getTime() + MCP_AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    });
    return chosen;
  });

  return {
    redirectTo: clientRedirect(
      request.redirectUri,
      { code: code.value, state: request.state ?? undefined },
      issuer,
    ),
    agent,
  };
}

// ---------------------------------------------------------------------------------------------
// Client authentication (RFC 6749 §2.3)
// ---------------------------------------------------------------------------------------------

/** What the token and revocation endpoints found in the request: the header's pair, or the body's. */
export type PresentedClientCredentials = {
  clientId: string | null;
  clientSecret: string | null;
  /** Whether the pair came in an `Authorization: Basic` header, which changes the refusal's shape (RFC 6749 §5.2). */
  viaHeader: boolean;
};

function secretMatches(row: McpClientRow, presented: string | null): boolean {
  if (!row.secretHash || !presented) return false;
  const expected = Buffer.from(row.secretHash, "hex");
  const given = Buffer.from(hashAgentToken(presented), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Who is calling the token endpoint. A public client (`none`) is its `client_id` and nothing more,
 * as RFC 6749 §2.3 allows for a client that cannot keep a secret; a confidential client proves the
 * secret it was shown at registration, whichever of the two RFC 6749 §2.3.1 methods it registered
 * for. Every failure is one `invalid_client` at 401 — which of the pair was wrong is not said.
 */
export async function authenticateClient(
  ctx: ServiceContext,
  presented: PresentedClientCredentials,
  deps: McpOAuthDeps,
): Promise<McpClientRow> {
  const refuse = () =>
    new OAuthProtocolError("invalid_client", "Client authentication failed", 401);
  if (!presented.clientId) throw refuse();
  const client = await deps.findMcpClient(ctx.db, presented.clientId);
  if (!client) throw refuse();
  if (client.tokenEndpointAuthMethod === "none") return client;
  if (!secretMatches(client, presented.clientSecret)) throw refuse();
  return client;
}

// ---------------------------------------------------------------------------------------------
// The token endpoint (RFC 6749 §4.1.3, §6; RFC 7636 §4.6; OAuth 2.1 §4.3.1)
// ---------------------------------------------------------------------------------------------

/** RFC 6749 §5.1: the answer both grants give. */
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
};

async function issueTokens(
  ctx: ServiceContext,
  client: McpClientRow,
  grant: { id: string; agentId: string; resource: string | null; scope: string | null },
  deps: McpOAuthDeps,
): Promise<TokenResponse> {
  const now = deps.now();
  const access = mintOpaqueToken(MCP_ACCESS_TOKEN_PREFIX, deps.randomBytes);
  const refresh = mintOpaqueToken(MCP_REFRESH_TOKEN_PREFIX, deps.randomBytes);
  const shared = {
    clientId: client.id,
    agentId: grant.agentId,
    grantId: grant.id,
    resource: grant.resource,
    scope: grant.scope,
  };
  await deps.insertMcpToken(ctx.db, {
    id: deps.newId(),
    tokenHash: access.hash,
    kind: "access",
    expiresAt: new Date(now.getTime() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000),
    ...shared,
  });
  await deps.insertMcpToken(ctx.db, {
    id: deps.newId(),
    tokenHash: refresh.hash,
    kind: "refresh",
    expiresAt: null,
    ...shared,
  });
  return {
    access_token: access.value,
    token_type: "Bearer",
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.value,
    ...(grant.scope ? { scope: grant.scope } : {}),
  };
}

const invalidGrant = (description: string) => new OAuthProtocolError("invalid_grant", description);

/**
 * A guarded claim's two outcomes, carried out of the transaction so what the loser does — a
 * refusal to throw, a replay to answer — is decided after the commit rather than rolled back with it.
 */
type Claimed = { won: true; tokens: TokenResponse } | { won: false; replayed?: TokenResponse };

/**
 * `grant_type=authorization_code` (RFC 6749 §4.1.3 with RFC 7636 §4.6). The code is looked up by
 * its hash and must be this client's, unspent, in time, sent to the same redirect URI, and answered
 * by a verifier whose `S256` is the challenge the consent stored; the agent it is bound to must
 * still stand, or the pair minted could never resolve and the client would learn that only at its
 * next call. A code presented twice is refused **and the grant it opened is revoked** (RFC 6749
 * §4.1.2: a second use is evidence the code leaked) — whether the second presentation arrives after
 * the first or races it. The consume, the revoke a lost race performs and the pair the winner
 * mints are **one transaction**: the loser's guarded update waits on the winner's row lock, sees
 * the code spent, and its revoke then reaches the winner's tokens, which are committed by the time
 * it runs. Thrown after the transaction, so the revoke it recorded is not rolled back with it.
 */
export async function exchangeAuthorizationCode(
  ctx: ServiceContext,
  client: McpClientRow,
  form: Record<string, string | undefined>,
  deps: McpOAuthDeps,
  config: McpOAuthConfig,
): Promise<TokenResponse> {
  const { code, code_verifier: verifier, redirect_uri: redirectUri, resource } = form;
  if (!code) throw new OAuthProtocolError("invalid_request", "code is required");
  if (!verifier || !isValidCodeVerifier(verifier)) {
    throw new OAuthProtocolError("invalid_request", "code_verifier is required (PKCE, S256)");
  }
  const row = await deps.findMcpAuthorizationCodeByHash(ctx.db, hashAgentToken(code));
  if (!row || row.clientId !== client.id) throw invalidGrant("The code is unknown");
  if (row.consumedAt) {
    await deps.revokeMcpGrant(ctx.db, row.id, deps.now());
    throw invalidGrant("The code was already used; every token it issued is revoked");
  }
  if (row.expiresAt.getTime() <= deps.now().getTime()) throw invalidGrant("The code has expired");
  if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
    throw invalidGrant("redirect_uri does not match the authorization request");
  }
  if (pkceChallenge(verifier) !== row.codeChallenge) {
    throw invalidGrant("code_verifier does not match the code_challenge");
  }
  if (resource !== undefined && !sameResource(resource, mcpResourceUrl(config.authUrl))) {
    throw new OAuthProtocolError("invalid_target", "resource must be this MCP endpoint");
  }
  if (row.agentRevokedAt) {
    throw invalidGrant("The agent this code is for was revoked; connect again");
  }

  const now = deps.now();
  const claimed = await ctx.db.transaction(async (tx): Promise<Claimed> => {
    const consumed = await deps.consumeMcpAuthorizationCode(tx, row.id, now);
    if (!consumed) {
      await deps.revokeMcpGrant(tx, row.id, now);
      return { won: false };
    }
    return {
      won: true,
      tokens: await issueTokens({ db: tx }, client, consumedGrant(consumed), deps),
    };
  });
  if (!claimed.won) {
    throw invalidGrant("The code was already used; every token it issued is revoked");
  }
  return claimed.tokens;
}

function consumedGrant(row: McpAuthorizationCodeRow) {
  return { id: row.id, agentId: row.agentId, resource: row.resource, scope: row.scope };
}

/**
 * `grant_type=refresh_token` (RFC 6749 §6; OAuth 2.1 §4.3.1). The token must be this client's,
 * unrevoked, and its agent must still stand — a revoked agent's refresh is `invalid_grant`, which
 * is how a chat product learns the person cut the connection and asks them to connect again. A
 * refresh token is rotated on every use: the successor is issued, the predecessor stamped, **one
 * successor per predecessor** — the claim is a guarded update that answers exactly one caller, and
 * the claim, the pair it earns and the seal of that pair under the retired token are one
 * transaction. A predecessor presented again **inside the grace window is answered the same pair**,
 * opened from the seal with the token presented — whether it lost a race with a twin request or
 * comes back after a dropped response — so the client recovers without the person; past the window
 * it is a replay, and every token of the grant is revoked.
 */
export async function refreshTokens(
  ctx: ServiceContext,
  client: McpClientRow,
  form: Record<string, string | undefined>,
  deps: McpOAuthDeps,
): Promise<TokenResponse> {
  const presented = form.refresh_token;
  if (!presented) throw new OAuthProtocolError("invalid_request", "refresh_token is required");
  const hash = hashAgentToken(presented);
  const row = await deps.findMcpRefreshTokenByHash(ctx.db, hash);
  if (!row || row.clientId !== client.id) throw invalidGrant("The refresh token is unknown");
  if (row.revokedAt) throw invalidGrant("The refresh token is revoked");
  if (row.agentRevokedAt) {
    throw invalidGrant("The agent this token belongs to was revoked; connect again");
  }
  const now = deps.now();
  /** The retired token's retry: the same pair from the seal, or a refusal that opened nothing. */
  const replay = (sealed: string | null): TokenResponse => {
    const same = openRotationReplay(presented, row.id, sealed);
    if (!same) throw invalidGrant("The refresh token was already used");
    return same;
  };
  if (row.rotatedAt) {
    if (now.getTime() - row.rotatedAt.getTime() > MCP_REFRESH_GRACE_SECONDS * 1000) {
      await deps.revokeMcpGrant(ctx.db, row.grantId, now);
      throw invalidGrant("The refresh token was already used; every token of the grant is revoked");
    }
    return replay(row.rotationReplay);
  }
  await deps.pruneMcpExpired(ctx.db, new Date(now.getTime() - MCP_PRUNE_AFTER_SECONDS * 1000));
  const claimed = await ctx.db.transaction(async (tx): Promise<Claimed> => {
    const won = await deps.rotateMcpToken(tx, row.id, now);
    if (!won) {
      // Lost to a twin request: its claim, pair and seal are committed by the time the guarded
      // update answered, so the seal is there to open — the same pair the twin was given.
      const settled = await deps.findMcpTokenByHash(tx, hash);
      return { won: false, replayed: replay(settled?.rotationReplay ?? null) };
    }
    const tokens = await issueTokens(
      { db: tx },
      client,
      { id: row.grantId, agentId: row.agentId, resource: row.resource, scope: row.scope },
      deps,
    );
    await deps.setMcpTokenRotationReplay(
      tx,
      row.id,
      sealRotationReplay(presented, row.id, tokens, deps.randomBytes),
    );
    return { won: true, tokens };
  });
  if (claimed.won) return claimed.tokens;
  if (!claimed.replayed) throw invalidGrant("The refresh token was already used");
  return claimed.replayed;
}

/** The token endpoint's dispatch on `grant_type`; anything else is `unsupported_grant_type`. */
export async function grantTokens(
  ctx: ServiceContext,
  client: McpClientRow,
  form: Record<string, string | undefined>,
  deps: McpOAuthDeps,
  config: McpOAuthConfig,
): Promise<TokenResponse> {
  switch (form.grant_type) {
    case "authorization_code":
      return exchangeAuthorizationCode(ctx, client, form, deps, config);
    case "refresh_token":
      return refreshTokens(ctx, client, form, deps);
    default:
      throw new OAuthProtocolError(
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token",
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Revocation (RFC 7009)
// ---------------------------------------------------------------------------------------------

/**
 * RFC 7009 §2: revoke the presented token, or say nothing — an unknown token and another client's
 * token both answer the same 200, so the endpoint confirms nothing about tokens it did not issue to
 * this caller. A refresh token takes its grant with it, access tokens included (§2.1); an access
 * token goes alone, and the refresh token that minted it goes on working, which is what the RFC
 * allows and what a client that rotates its access token wants.
 */
export async function revokeToken(
  ctx: ServiceContext,
  client: McpClientRow,
  token: string,
  deps: McpOAuthDeps,
): Promise<void> {
  const row = await deps.findMcpTokenByHash(ctx.db, hashAgentToken(token));
  if (!row || row.clientId !== client.id || row.revokedAt) return;
  const now = deps.now();
  if (row.kind === "refresh") await deps.revokeMcpGrant(ctx.db, row.grantId, now);
  else await deps.revokeMcpToken(ctx.db, row.id, now);
}
