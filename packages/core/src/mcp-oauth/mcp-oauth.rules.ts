/**
 * The browser-safe half of Graft's authorization server (ADR 0018): the paths, the parameter names
 * and the pure checks the console's consent page and the server's endpoints both apply. Imports
 * nothing but the platform, because `apps/web` bundles it — an import of `node:crypto` or of a
 * repo here is what would fail `vite build` (AGENTS.md, "three modules stay browser-safe").
 *
 * "Client" throughout is RFC 6749's: the chat product or harness that registered and will hold
 * the tokens (CONTEXT.md, *MCP client*). The agent is the token's subject and is never called a
 * client.
 */

/** Where the MCP endpoint answers, relative to `GRAFT_AUTH_URL` — `apps/server/src/app.ts`'s `MCP_MOUNT_PATH`. */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * The authorization server's four endpoints, under the MCP endpoint's own prefix rather than under
 * `/api`: they are the MCP door's doors, cookie-less and CORS-open to any origin, where `/api` is
 * the console's cookie-authenticated JSON API with the console's CORS. Clients never type these —
 * the metadata document names them — so the shape is for a person reading a log.
 */
export const MCP_OAUTH_PATHS = {
  authorize: "/mcp/oauth/authorize",
  token: "/mcp/oauth/token",
  register: "/mcp/oauth/register",
  revoke: "/mcp/oauth/revoke",
} as const;

/** RFC 9728 §3: the protected resource's document, at the origin's root and path-suffixed for the resource. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** RFC 8414 §3: the authorization server's document, at the issuer's root. */
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** The console route the authorization endpoint sends the browser to (`apps/web/src/routes/_auth/_shell/consent.tsx`). */
export const MCP_CONSENT_PATH = "/consent";

/** An origin with no path, query or fragment and no trailing slash — what an issuer and a resource are built on. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/** The issuer (RFC 8414 §2): `GRAFT_AUTH_URL`'s origin, exactly as the metadata document says it. */
export function mcpIssuer(authUrl: string): string {
  return originOf(authUrl);
}

/**
 * The MCP endpoint's canonical URI (RFC 8707 §2, as the MCP specification reads it): lowercase
 * scheme and host, the mount path, no trailing slash, no query, no fragment. What the protected
 * resource metadata calls `resource`, what a client sends as `resource`, and what every token is
 * bound to.
 */
export function mcpResourceUrl(authUrl: string): string {
  return `${originOf(authUrl)}${MCP_ENDPOINT_PATH}`;
}

/** The URL the MCP door's `WWW-Authenticate` names (RFC 9728 §5.1) — the path-suffixed form, for a resource with a path. */
export function protectedResourceMetadataUrl(authUrl: string): string {
  return `${originOf(authUrl)}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_ENDPOINT_PATH}`;
}

/** The console's consent page, under `GRAFT_CONSOLE_URL`, carrying the authorization request as its query. */
export function mcpConsentUrl(consoleUrl: string, params: AuthorizationRequestParams): string {
  const url = new URL(consoleUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${MCP_CONSENT_PATH}`;
  url.search = authorizationRequestSearch(params).toString();
  return url.toString();
}

/**
 * Two resource URIs are the same resource when they agree after the normalisation RFC 8707 §2
 * asks for: case-insensitive scheme and host, a trailing slash ignored, and no fragment. Anything
 * unparseable is nobody's resource.
 */
export function sameResource(a: string, b: string): boolean {
  const normalise = (value: string): string | null => {
    try {
      const url = new URL(value);
      if (url.hash) return null;
      return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return null;
    }
  };
  const left = normalise(a);
  return left !== null && left === normalise(b);
}

/** The parameters of an authorization request (RFC 6749 §4.1.1, RFC 7636 §4.3, RFC 8707 §2), as strings. */
export const AUTHORIZATION_REQUEST_PARAM_NAMES = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

export type AuthorizationRequestParamName = (typeof AUTHORIZATION_REQUEST_PARAM_NAMES)[number];

export type AuthorizationRequestParams = Partial<Record<AuthorizationRequestParamName, string>>;

/**
 * The request out of a query — a `URLSearchParams`, or the record a router hands a route. Only the
 * named parameters, only as non-empty strings: a repeated or absent parameter is absent, and the
 * console page cannot carry anything the authorization endpoint did not send it.
 */
export function readAuthorizationRequestParams(
  search: URLSearchParams | Record<string, unknown>,
): AuthorizationRequestParams {
  const params: AuthorizationRequestParams = {};
  for (const name of AUTHORIZATION_REQUEST_PARAM_NAMES) {
    const value = search instanceof URLSearchParams ? search.get(name) : search[name];
    if (typeof value === "string" && value.length > 0) params[name] = value;
  }
  return params;
}

/** The request as a query again — what the authorization endpoint hands the console. */
export function authorizationRequestSearch(params: AuthorizationRequestParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const name of AUTHORIZATION_REQUEST_PARAM_NAMES) {
    const value = params[name];
    if (value) search.set(name, value);
  }
  return search;
}

/**
 * A redirect URI a client may register (MCP authorization specification, "Communication Security":
 * `localhost` or HTTPS). Absolute; `https:` anywhere, `http:` on a loopback host alone; never a
 * fragment or credentials. Loopback is judged on the parsed hostname — `localhost`, `127.0.0.1` as
 * the parser normalises every IPv4 shorthand to, `[::1]` — while the authorization request must
 * match the registered *string* exactly, so a client that spells loopback two ways has two redirect
 * URIs to register.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes("#")) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Where the client will be sent back — the host, for the consent page to show beside the client's name. */
export function redirectTargetOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/** RFC 7636 §4.2: a `code_challenge` is 43 to 128 characters of the unreserved set. */
export function isValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** RFC 7636 §4.1: a `code_verifier` is 43 to 128 characters of the unreserved set. */
export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/**
 * The redirect back to the client (RFC 6749 §4.1.2 and §4.1.2.1): the registered URI with the
 * parameters appended to whatever query it already carries, and `iss` beside them (RFC 9207), so
 * a client that checks the issuer can. The fragment is never touched.
 */
export function clientRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}
