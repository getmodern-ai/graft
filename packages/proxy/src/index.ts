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
 *
 * The relay (ADR 0019; `relay.ts`) is exported for the two hands that build one: a provider in
 * `@graft/core` picks a plugin from `RELAYS` and hands it to the proxy on the connection, and a new
 * relay plugin applies `relayHeaders` under its rules rather than writing the loop again.
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
export {
  decodePipedreamProxySegment,
  PIPEDREAM_API_ORIGIN,
  PIPEDREAM_CONNECT_PROXY_SCHEME,
  PIPEDREAM_RELAY_FIELDS,
  PIPEDREAM_RELAY_HEADER_PREFIX,
  PIPEDREAM_RELAY_ORIGIN_FIELD,
  PIPEDREAM_RELAY_RULES,
  pipedreamConnectProxyRelay,
  pipedreamProxyUrl,
} from "./pipedream-relay";
export {
  PASSTHROUGH_RELAY_RULES,
  RELAYS,
  relayHeaders,
  relayPassesThrough,
  relayRefuses,
  relayRulesOf,
} from "./relay";
export { CredentialRefreshError, DerivedCredentialError } from "./scheme-errors";
export {
  requiredParametersOf,
  SCHEME_PARAMETERS,
  type SchemeParameterRule,
} from "./scheme-parameters";
export { SNOWFLAKE_TOKEN_TYPE_HEADER, UNLEASHED_CLIENT_TYPE } from "./schemes";
export { INBOUND_AUTH_HEADERS, TOKEN_HEADERS } from "./token";
export type {
  AuthScheme,
  CapabilityClaims,
  CredentialFields,
  CredentialScope,
  JsonWebKeySet,
  ProxyConnection,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  ProxyOutcome,
  ProxyRelay,
  ProxyScheme,
  RelayHeaderRules,
  RelayPlugin,
  RelayScheme,
  SchemeConfig,
  SchemeTarget,
  TokenVerdict,
  UpstreamFetch,
  UpstreamRequest,
} from "./types";
export { AUTH_SCHEMES, isAuthScheme, isRelayScheme, RELAY_SCHEMES } from "./types";
export { createUpstreamFetch } from "./upstream";
