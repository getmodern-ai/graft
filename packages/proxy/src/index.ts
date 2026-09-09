/**
 * `@graft/proxy` — the credential-injecting reverse proxy, the one route from a sandbox to a
 * vendor (CONTEXT.md, *Proxy*; ADR 0010).
 *
 * **This package knows only a connection, its scheme, its host set and a capability token.** A
 * person and an agent reach it as ids on the token — the person compared against the connection's
 * owner, the agent carried onto the wide event — and it knows nothing of what either is, nor of a
 * toolbox, a working set or an approval. It imports nothing from any other `@graft/*` package.
 * That is the boundary GRA-1 draws ("the proxy separable from the server by DNS alone"): the
 * proxy is mounted inside `apps/server` today and moves to its own service by changing where it is
 * mounted, so everything Graft-shaped stays on the host's side of `ProxyDeps` — the token
 * verifier, the connection read, the vault's decrypt, the wide-event sink. `apps/server/src/app.ts`
 * is that host binding; the README says the same thing for a reader who starts there.
 *
 * What is exported here is what a host imports to mount the proxy and bind its deps, what the
 * runner and the check need to agree with it on (the path forms, the header names, the field
 * table), and what the README names — no more. Each module is reachable by name through the
 * package's `./*` export for a reader who wants one piece: `@graft/proxy/types` for the rest of the
 * vocabulary, and `/public-host`, `/credential-fields`, `/scheme-parameters` and `/cause-chain` for
 * the tables a host — or the console's bundle — takes without the Hono app.
 */
export { createProxyApp, DEFAULT_PROXY_OPTIONS, HOST_SEGMENT_MARKER, proxyPathFor } from "./app";
export {
  SCHEME_CREDENTIAL_FIELDS,
  SCHEME_ISSUED_CREDENTIAL_FIELDS,
  SCHEME_OPTIONAL_CREDENTIAL_FIELDS,
} from "./credential-fields";
export { DRY_RUN_HEADER, DRY_RUN_PREVIEW_STATUS, isSafeMethod } from "./dry-run";
export { CREDENTIAL_REDACTED, REDACTED_CREDENTIAL, REDACTED_HEADER } from "./echo";
export {
  type ClientAuth,
  clientAuthOf,
  isTokenExpiring,
  OAUTH2_TOKEN_SKEW_MS,
  requestToken,
  type TokenRequest,
  type TokenResponse,
  tokenEndpointOf,
  tokenExpiresAt,
} from "./oauth";
export { CredentialRefreshError, DerivedCredentialError } from "./scheme-errors";
export {
  requiredParametersOf,
  SCHEME_PARAMETERS,
  type SchemeParameterRule,
} from "./scheme-parameters";
export { SNOWFLAKE_TOKEN_TYPE_HEADER, UNLEASHED_CLIENT_TYPE } from "./schemes";
export { INBOUND_AUTH_HEADERS, TOKEN_HEADERS } from "./token";
export type {
  CapabilityClaims,
  CredentialFields,
  CredentialScope,
  JsonWebKeySet,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  ProxyOutcome,
  TokenVerdict,
  UpstreamFetch,
  UpstreamRequest,
} from "./types";
export { AUTH_SCHEMES } from "./types";
export { createUpstreamFetch } from "./upstream";
