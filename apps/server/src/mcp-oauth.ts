import {
  type AgentDeps,
  authenticateClient,
  authorizationErrorRedirect,
  authorizationServerMetadata,
  type ConsentDecision,
  decideConsent,
  describeClient,
  grantTokens,
  judgeAuthorizationRequest,
  MCP_METADATA_PATHS,
  MCP_OAUTH_PATHS,
  MCP_REGISTRATION_MAX_BYTES,
  type McpOAuthDeps,
  mcpConsentUrl,
  mcpResourceUrl,
  OAuthProtocolError,
  type PresentedClientCredentials,
  protectedResourceMetadata,
  readAuthorizationRequestParams,
  redirectTargetOf,
  registerMcpClient,
  requirePerson,
  revokeToken,
  type ServiceContext,
  ServiceError,
  type SessionLike,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { agentScopeMode } from "@graft/db/schema/agent";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

/**
 * The HTTP face of Graft's authorization server (ADR 0018), in three Hono apps for three mounts:
 *
 * - `createWellKnownApp`, at the origin's root: the RFC 8414 and RFC 9728 documents a chat product
 *   reads after the MCP endpoint's 401 pointed it here. Before the console's SPA fallback, which
 *   would otherwise answer `index.html` for anything a browser-shaped client asks with `Accept:
 *   text/html` — and a JSON document served as a page is a connector that silently never connects.
 * - `createMcpOAuthApp`, at `/mcp/oauth`: registration, the authorization endpoint, the token
 *   endpoint and revocation. Cookie-less and CORS-open to every origin: the callers are the
 *   products' servers and, for a browser-based client such as the MCP Inspector, the browser itself,
 *   and none of them is the console. Outside `/api`, where the console's CORS and Better Auth live.
 * - `createMcpConsentRoutes`, under `/api/mcp-oauth`: the two routes the console's consent page
 *   calls with the person's session — describe the request, then decide it. These are the console's
 *   and wear the API's CORS and its error shape.
 *
 * The rules and every check are `@graft/core`'s (`mcp-oauth.service.ts`); this file parses the
 * wire — a form body, a `Basic` header, a query — and writes the protocol's answers: a JSON error
 * at the RFC's status for the four endpoints, a redirect for the authorization endpoint.
 */

export type McpOAuthServerOptions = {
  db: DbOrTx;
  deps: McpOAuthDeps;
  /** The consent mints or names an agent through the agent service (ADR 0018). */
  agent: AgentDeps;
  /** `GRAFT_AUTH_URL` — the issuer and the resource are its origin. */
  authUrl: string;
  /** `GRAFT_CONSOLE_URL` — where the authorization endpoint sends the browser to consent. */
  consoleUrl: string;
};

/** Where `createMcpOAuthApp` is mounted; the endpoints in `MCP_OAUTH_PATHS` sit under it. */
export const MCP_OAUTH_MOUNT_PATH = "/mcp/oauth";

/** Where `createWellKnownApp`'s documents live; excluded from the console's SPA fallback by this prefix. */
export const WELL_KNOWN_PATH = "/.well-known";

/** The absolute path from `@graft/core` as this app's relative route, asserted to sit under the mount. */
function under(path: string): string {
  if (!path.startsWith(`${MCP_OAUTH_MOUNT_PATH}/`)) {
    throw new Error(`${path} is not under ${MCP_OAUTH_MOUNT_PATH}`);
  }
  return path.slice(MCP_OAUTH_MOUNT_PATH.length);
}

/** RFC 6749 §5.1 and §5.2: a token answer, and an error, are never cached. */
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

const openCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 });

/** The metadata documents, CORS-open, cacheable for an hour — they change with a deploy and never else. */
export function createWellKnownApp(options: Pick<McpOAuthServerOptions, "authUrl">): Hono {
  const app = new Hono();
  const config = { authUrl: options.authUrl };
  const resourcePath = new URL(mcpResourceUrl(options.authUrl)).pathname;
  const headers = { "cache-control": "public, max-age=3600" };

  app.use(`${WELL_KNOWN_PATH}/*`, openCors);
  app.get(MCP_METADATA_PATHS.authorizationServer, (c) =>
    c.json(authorizationServerMetadata(config), 200, headers),
  );
  // Both forms RFC 9728 §3 admits for a resource with a path: `/.well-known/oauth-protected-resource`
  // and the path-suffixed `/.well-known/oauth-protected-resource/mcp`, which the door names.
  for (const path of [
    MCP_METADATA_PATHS.protectedResource,
    `${MCP_METADATA_PATHS.protectedResource}${resourcePath}`,
  ]) {
    app.get(path, (c) => c.json(protectedResourceMetadata(config), 200, headers));
  }
  return app;
}

/**
 * A request body, bounded before it is parsed: the declared `Content-Length` first, so an honest
 * oversize is refused before a byte is read, and the read text again, because a stream may say one
 * thing and carry another. The four endpoints are open or nearly so, and none of their legitimate
 * bodies comes anywhere near the cap — a registration is a few hundred bytes, a token request
 * less. Refused in the protocol's own shape, with the error word the endpoint's RFC uses.
 */
async function boundedBody(request: Request, error: string): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MCP_REGISTRATION_MAX_BYTES) {
    throw new OAuthProtocolError(error, `The body is over ${MCP_REGISTRATION_MAX_BYTES} bytes`);
  }
  const text = await request.text();
  if (text.length > MCP_REGISTRATION_MAX_BYTES) {
    throw new OAuthProtocolError(error, `The body is over ${MCP_REGISTRATION_MAX_BYTES} bytes`);
  }
  return text;
}

/**
 * The body of a token or revocation request (RFC 6749 §4.1.3: `application/x-www-form-urlencoded`),
 * first value per name. A JSON body is not the protocol's and reads as no fields, which the
 * endpoint refuses as `invalid_request` naming the field it wanted.
 */
async function formFields(request: Request): Promise<Record<string, string | undefined>> {
  const text = await boundedBody(request, "invalid_request");
  const fields: Record<string, string | undefined> = {};
  for (const [name, value] of new URLSearchParams(text)) {
    if (fields[name] === undefined) fields[name] = value;
  }
  return fields;
}

/**
 * Who the client says it is (RFC 6749 §2.3.1): the `Basic` header's pair, else the body's
 * `client_id` and `client_secret`. A client that presents both, and disagrees between them, is
 * refused — the RFC forbids more than one method in a request. The header's values are
 * form-decoded as the RFC asks, falling back to the raw text for a client that did not encode.
 */
function presentedCredentials(
  headers: Headers,
  form: Record<string, string | undefined>,
): PresentedClientCredentials {
  const header = headers.get("authorization");
  const basic = header ? /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header.trim()) : null;
  if (!basic?.[1]) {
    return {
      clientId: form.client_id ?? null,
      clientSecret: form.client_secret ?? null,
      viaHeader: false,
    };
  }
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const formDecode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const clientId = formDecode(colon === -1 ? decoded : decoded.slice(0, colon));
  const clientSecret = colon === -1 ? null : formDecode(decoded.slice(colon + 1));
  if (form.client_id !== undefined && form.client_id !== clientId) {
    throw new OAuthProtocolError(
      "invalid_request",
      "client_id in the body disagrees with the Authorization header",
    );
  }
  return { clientId, clientSecret, viaHeader: true };
}

/**
 * The four endpoints. Errors leave as RFC 6749 §5.2's `{ error, error_description }` at the
 * error's own status, with `WWW-Authenticate: Basic` on an `invalid_client` that tried the header
 * (§5.2's one shape rule); anything that is not the protocol's is a 500 `server_error` that says
 * nothing else, because a dependency's message might carry anything.
 */
export function createMcpOAuthApp(options: McpOAuthServerOptions): Hono {
  const app = new Hono();
  const ctx: ServiceContext = { db: options.db };
  const config = { authUrl: options.authUrl };
  const { deps } = options;

  app.use("*", openCors);

  app.onError((error, c) => {
    if (error instanceof OAuthProtocolError) {
      const headers: Record<string, string> = { ...NO_STORE };
      if (error.error === "invalid_client" && c.req.header("authorization")) {
        headers["www-authenticate"] = 'Basic realm="graft"';
      }
      return c.json(error.body, error.status, headers);
    }
    console.error("mcp oauth error", error);
    return c.json(
      { error: "server_error", error_description: "Something went wrong" },
      500,
      NO_STORE,
    );
  });

  /**
   * RFC 7591 §3: a JSON body of client metadata, unauthenticated, answered 201 with the id and,
   * for a confidential client, the secret — the one time it is shown.
   */
  app.post(under(MCP_OAUTH_PATHS.register), async (c) => {
    const text = await boundedBody(c.req.raw, "invalid_client_metadata");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthProtocolError("invalid_client_metadata", "The registration is not JSON");
    }
    return c.json(await registerMcpClient(ctx, body, deps), 201, NO_STORE);
  });

  /**
   * RFC 6749 §4.1.1: the browser arrives here from the product. A request whose client or redirect
   * URI is in doubt goes to the console as it is, where the person reads a refusal — never to the
   * URI in doubt (OAuth 2.1 §4.1.2.1); a request whose client is sound but whose parameters are
   * wrong goes back to the client's registered URI as an error; a sound request goes to the console's
   * consent page carrying its parameters, and the console's own guard sends a signed-out person to
   * sign in and back (ADR 0006). Nothing is written here: the request is judged again at consent.
   */
  app.get(under(MCP_OAUTH_PATHS.authorize), async (c) => {
    const params = readAuthorizationRequestParams(new URL(c.req.url).searchParams);
    const verdict = await judgeAuthorizationRequest(ctx, params, deps, config);
    if (!verdict.ok && verdict.redirectable) {
      return c.redirect(authorizationErrorRedirect(verdict, config), 302);
    }
    return c.redirect(mcpConsentUrl(options.consoleUrl, params), 302);
  });

  /** RFC 6749 §3.2: the two grants, after the client has proved itself. */
  app.post(under(MCP_OAUTH_PATHS.token), async (c) => {
    const form = await formFields(c.req.raw);
    const client = await authenticateClient(
      ctx,
      presentedCredentials(c.req.raw.headers, form),
      deps,
    );
    return c.json(await grantTokens(ctx, client, form, deps, config), 200, NO_STORE);
  });

  /** RFC 7009 §2: revoke what was presented, and answer 200 whatever it was. */
  app.post(under(MCP_OAUTH_PATHS.revoke), async (c) => {
    const form = await formFields(c.req.raw);
    const client = await authenticateClient(
      ctx,
      presentedCredentials(c.req.raw.headers, form),
      deps,
    );
    if (!form.token) throw new OAuthProtocolError("invalid_request", "token is required");
    await revokeToken(ctx, client, form.token, deps);
    return c.body(null, 200, NO_STORE);
  });

  return app;
}

/** What the consent page shows (ADR 0018): the client as registered and where it will be sent back. */
export type ConsentRequestDescription = {
  client: { id: string; name: string; clientUri: string | null; logoUri: string | null };
  redirectUri: string;
  /** The redirect URI's host — what the page prints beside the client's name. */
  redirectTarget: string;
  scope: string | null;
  resource: string;
};

const consentRequestSchema = z.object({
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  response_type: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

const consentBody = z.object({
  request: consentRequestSchema,
  decision: z.enum(["allow", "deny"]),
  agent: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("new"),
        name: z.string(),
        /** `all` when absent (ADR 0007 as amended 2026-09-19); `listed` takes `connectionIds`. */
        scopeMode: z.enum(agentScopeMode).optional(),
        connectionIds: z.array(z.string()).optional(),
      }),
      z.object({ kind: z.literal("existing"), agentId: z.string() }),
    ])
    .optional(),
});

export type ConsentRequestBody = z.infer<typeof consentBody>;

/**
 * The console's two routes (ADR 0006: the console is the channel), under the API and its session.
 * `GET /request` judges the parameters the page was handed and describes the client, or refuses
 * with the reason word in `details` for the page to show; `POST /consent` takes the person's
 * decision and answers where to send the browser. A refusal here is a `ServiceError` and rides the
 * API's error shape; the protocol's own error shape belongs to the four endpoints above.
 */
export function createMcpConsentRoutes(
  options: McpOAuthServerOptions & { getSession: (headers: Headers) => Promise<SessionLike> },
): Hono {
  const routes = new Hono();
  const ctx: ServiceContext = { db: options.db };
  const config = { authUrl: options.authUrl };

  routes.get("/request", async (c) => {
    requirePerson(await options.getSession(c.req.raw.headers));
    const params = readAuthorizationRequestParams(new URL(c.req.url).searchParams);
    const verdict = await judgeAuthorizationRequest(ctx, params, options.deps, config);
    if (!verdict.ok) {
      if (verdict.redirectable) {
        throw new ServiceError("BAD_REQUEST", `${verdict.error}: ${verdict.description}`, {
          details: {
            reason: verdict.error,
            redirectTo: authorizationErrorRedirect(verdict, config),
          },
        });
      }
      throw new ServiceError("BAD_REQUEST", verdict.message, {
        details: { reason: verdict.reason },
      });
    }
    const description: ConsentRequestDescription = {
      client: describeClient(verdict.client),
      redirectUri: verdict.request.redirectUri,
      redirectTarget: redirectTargetOf(verdict.request.redirectUri),
      scope: verdict.request.scope,
      resource: verdict.request.resource,
    };
    return c.json(description);
  });

  routes.post("/consent", async (c) => {
    const principal = requirePerson(await options.getSession(c.req.raw.headers));
    let json: unknown;
    try {
      json = await c.req.raw.json();
    } catch {
      throw new ServiceError("BAD_REQUEST", "The body is not JSON");
    }
    const parsed = consentBody.safeParse(json);
    if (!parsed.success) {
      throw new ServiceError("BAD_REQUEST", "The body does not match the route's shape", {
        details: { issues: parsed.error.issues },
      });
    }
    const body = parsed.data;
    let decision: ConsentDecision;
    if (body.decision === "deny") {
      decision = { decision: "deny" };
    } else if (!body.agent) {
      throw new ServiceError(
        "BAD_REQUEST",
        "An allow names the agent: a new one, or an existing one",
      );
    } else {
      decision = { decision: "allow", agent: body.agent };
    }
    const outcome = await decideConsent(
      ctx,
      principal,
      readAuthorizationRequestParams(body.request),
      decision,
      options.deps,
      options.agent,
      config,
    );
    return c.json(outcome);
  });

  return routes;
}
