/**
 * The proxy's vocabulary. Everything here is stated in terms of a **connection**, its **scheme**,
 * its **host set** and a **capability token** — the words CONTEXT.md gives *Proxy*, *Connection*
 * and *Capability token*. A person and an agent appear only as ids, compared and carried onto the
 * wide event; the proxy resolves neither, and there is no toolbox, working set or approval in this
 * package at all. That is what lets it move to its own service by DNS alone (GRA-1, "The proxy and
 * the capability token"): everything Graft-shaped is bound to these types through `ProxyDeps`, by
 * `apps/server/src/app.ts` today.
 *
 * Copied from Cando's proxy package and re-read on the way in (ADR 0011). Three things changed: a
 * connection belongs to a person and declares a set of hosts, not to an agent with one base URL
 * (ADR 0007, ADR 0010); the token names the connections in reach rather than one app; and the
 * brokered-credential seam was dropped, because Graft holds every credential itself (ADR 0001) —
 * and then came back in a narrower shape as the **relay** (ADR 0019, GRA-57): a connection whose
 * provider holds the credential elsewhere is not decrypted here but relayed to the upstream proxy
 * that holds it, with everything above the credential rung unchanged.
 */

/**
 * Every scheme the proxy implements. The connection table's column enum and this list are asserted
 * equal once GRA-6 adds the table, so a scheme added to one without the other fails a test rather
 * than a vendor call.
 */
export const AUTH_SCHEMES = [
  "api_key_header",
  "api_key_query",
  "bearer",
  "basic",
  "oauth2_client_credentials",
  "oauth_authorization_code",
  "unleashed_hmac",
  "snowflake_keypair_jwt",
  /**
   * Signs nothing: a public API called as-is (GRA-66). A connection all the same — hosts pinned,
   * egress through the proxy, writes intercepted on a dry run — because a placeholder credential
   * is not neutral: Open-Meteo redirects any keyed request to its customer host, whatever the key.
   */
  "none",
] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/**
 * The schemes that **relay** rather than sign (ADR 0019; ported from Cando's CAN-563). A relay
 * scheme sends the vendor request through an upstream proxy that injects the credential it holds —
 * a company's API gateway, a broker's Connect proxy — so this proxy never sees that credential,
 * only the fields that address the upstream. Kept apart from `AUTH_SCHEMES` on purpose: those are
 * the schemes a person may choose on the console's form, and a relay is never one of them — a
 * connection's *provider* decides that it relays (`ProxyConnection.relay`), and nothing a person
 * types can. `gateway` (GRA-58) and `pipedream_connect_proxy` (GRA-59) are the first two: a
 * company's API gateway fronting the vendor (`gateway-relay.ts`) and Pipedream's Connect proxy
 * (`pipedream-relay.ts`). The engine (`relay.ts`, `app.ts`) and its own tests still stand on a
 * plugin defined in the test, so a scheme is added here by adding its plugin to `RELAYS` and
 * nothing in the ladder changes.
 */
export const RELAY_SCHEMES = ["gateway", "pipedream_connect_proxy"] as const;
export type RelayScheme = (typeof RELAY_SCHEMES)[number];

/** Every scheme name a connection row may carry: what it signs with, or what it relays through. */
export type ProxyScheme = AuthScheme | RelayScheme;

export function isAuthScheme(value: string): value is AuthScheme {
  return (AUTH_SCHEMES as readonly string[]).includes(value);
}

export function isRelayScheme(value: string): value is RelayScheme {
  return (RELAY_SCHEMES as readonly string[]).includes(value);
}

/** A decrypted credential: named string fields, as the scheme plugin reads them. */
export type CredentialFields = Readonly<Record<string, string>>;

/** A scheme's non-secret parameters — a header name, a prefix, a query parameter name. */
export type SchemeConfig = Readonly<Record<string, string>>;

/**
 * The two ids a ciphertext is bound to; the host's vault checks them on decrypt. The person rather
 * than an organisation because a connection is the person's (ADR 0007).
 */
export type CredentialScope = { personId: string; connectionId: string };

/**
 * What the proxy needs to know about a connection, and nothing more. `personId` is here only to be
 * compared against the token's `person` claim — the proxy never looks a person up. The credential
 * rides on the row, envelope-encrypted, and the host's vault decrypts it (`ProxyDeps`).
 */
export type ProxyConnection = {
  id: string;
  /** The owner (ADR 0007). */
  personId: string;
  authScheme: AuthScheme | null;
  /**
   * The base URL the plain form `/c/<id>/<path>` resolves against — scheme, host, an optional port
   * and path prefix, as in `https://api.vendor.example/v1`. Null until the connection is set up.
   */
  primaryHost: string | null;
  /**
   * Every hostname the connection may reach, the primary's among them — the set the person saw on
   * the handoff page (ADR 0010). The explicit form `/c/<id>/h/<host>/<path>` is refused for a host
   * outside it, and a redirect is followed only within it. Compared lower-case.
   */
  hosts: readonly string[];
  schemeConfig: SchemeConfig | null;
  credentialCiphertext: Uint8Array | null;
  /**
   * How a call through this connection reaches the vendor (ADR 0019). Absent or null — every
   * keyring connection — the row's credential is decrypted and the scheme plugin signs, exactly as
   * before this field existed. Set, the connection's provider holds the credential at an upstream
   * proxy, and the ladder relays: the resolved vendor request is rewritten into a request to that
   * upstream, which injects the credential and answers with the vendor's response. The host builds
   * this from the provider's answer (`@graft/core`'s `toProxyConnection`); the row's scheme, config
   * and ciphertext are null beside it, since the proxy has nothing of its own to sign with.
   */
  relay?: ProxyRelay | null;
  /**
   * When the person revoked the connection, or null. Set, every call is refused
   * `connection_revoked` before the row's scheme, hosts or credential are read (GRA-68): the
   * console's Reconnect is the one way back, and the columns a revoke leaves null, a keyring row's
   * ciphertext or a relay row's reference, would otherwise have the refusal name the wrong repair.
   * Optional like `relay`, so a connection that was never revoked (a seed, a test's literal) need
   * not say so; `toProxyConnection` sets it for every row it builds, and resolves a revoked row to
   * no scheme, no ciphertext and no relay besides, so a host that leaves it unset is still refused,
   * only less precisely.
   */
  revokedAt?: Date | null;
  /**
   * The name of the provider that holds this connection's credential elsewhere and has nothing for
   * it yet: a one-click link the person opened and did not finish (ADR 0019). Such a row has its
   * scheme and its primary host and lacks only the provider's reference, so the refusal names what
   * is missing and who holds it (`connection_not_ready`, GRA-68) rather than the columns it happens
   * to find null. Opaque text for that sentence and nothing more; the proxy still knows nothing of
   * what a provider is. Absent for every row whose provider resolved, and for every keyring row.
   */
  pendingProvider?: string | null;
};

/**
 * The outgoing request as a scheme plugin sees it: the URL and the headers, nothing else. A signing
 * plugin sets a header or a query parameter on it; a relay plugin replaces the URL and rewrites the
 * headers wholesale (`relay.ts`).
 */
export type SchemeTarget = { url: URL; headers: Headers };

/**
 * What an upstream proxy does with a caller's headers — the rules of the relay, as data, so a
 * plugin says *which* upstream it addresses and this table says *how* the caller's headers travel
 * (ADR 0019, "what Cando's relay taught"). Pipedream forwards a header to the vendor only under an
 * `x-pd-proxy-` prefix and refuses a documented list outright, `user-agent` among them; a gateway
 * that fronts the vendor itself forwards everything under its own name. Names are compared
 * lower-case, as `Headers` reports them.
 */
export type RelayHeaderRules = {
  /**
   * Every caller header is renamed under this prefix on the way to the upstream — including one
   * that already carries it, so a caller sending `x-pd-proxy-authorization` cannot re-introduce a
   * header the outgoing policy stripped (the upstream strips exactly one prefix). Null forwards the
   * caller's headers under their own names.
   */
  prefix: string | null;
  /** Forwarded under their own name even when a prefix is set: the framing pair, `content-type` and `accept`. */
  passThrough: readonly string[];
  /** Dropped, not prefixed: the upstream would refuse the request for them, and the vendor loses nothing it needed. */
  refuse: readonly string[];
  /** Dropped by family — `sec-*`, `proxy-*`. */
  refusePrefixes: readonly string[];
};

/**
 * A relay scheme's plugin: code we wrote that rewrites the resolved vendor request into the request
 * the upstream proxy takes — the vendor URL carried in the upstream's own way (a path segment, a
 * query parameter, a header), the caller's headers under the upstream's rules, and the upstream's
 * own authentication from `fields`. What it does not do is decide anything the ladder already
 * decided: the vendor host was judged, the dry run has intercepted a write, the capability token has
 * admitted the call and been swept off the wire, all before `relay` runs. The shape GRA-58's gateway
 * and GRA-59's Pipedream plugins implement (`RELAYS` in `relay.ts`).
 */
export type RelayPlugin = {
  kind: "relay";
  /** The name the row's `scheme` column carries and the wide event records — a `RELAY_SCHEMES` entry. */
  scheme: string;
  /** The upstream's rules for the caller's headers; a connection may override a rule (`ProxyRelay.rules`). */
  rules: RelayHeaderRules;
  /**
   * Rewrite `target` in place: `target.url` becomes the upstream's URL for this vendor request,
   * `target.headers` the caller's headers under `rules` (`relayHeaders` does that half) plus the
   * upstream's authentication from `fields`. Throws a scheme configuration error for a field it
   * cannot run without, as a signing plugin does (`scheme-errors.ts`).
   */
  relay: (target: SchemeTarget, fields: CredentialFields, rules: RelayHeaderRules) => void;
  /**
   * The names of the headers `relay` sets of its own — lower-cased — which is all a dry run needs
   * of it: a write intercepted under the claim previews the request that would have left for the
   * upstream without assembling the relay's fields (`dry-run.ts`).
   */
  headerNames: () => readonly string[];
};

/**
 * A relayed connection, as the host resolves it per call (`ProxyConnection.relay`): the plugin, the
 * fields that address the upstream — an upstream token, the ids naming the account there —
 * assembled when the call is about to leave and never persisted by the proxy, and any rule the
 * connection's provider overrides on the plugin's defaults.
 */
export type ProxyRelay = {
  plugin: RelayPlugin;
  /**
   * The relay's fields. Late and possibly expensive — a broker token to mint — so it sits on the
   * same rung as a decrypt: after the caller's body is accepted and after a dry run has intercepted
   * a write. Throws when the upstream cannot be addressed; the proxy answers one 502
   * `relay_unavailable` and never retries.
   */
  obtain: () => Promise<CredentialFields>;
  rules?: Partial<RelayHeaderRules>;
  /**
   * Header names the relay sets for *this* connection beyond the ones the plugin names for every
   * connection (`RelayPlugin.headerNames`), lower-cased — a gateway's deployment identity header,
   * whose name is the deployment's configuration and reaches the plugin only as one of `fields`
   * (GRA-58). The dry run lists them beside the plugin's so a write's preview says authentication
   * to the upstream would have been present, without `obtain` ever running.
   */
  headerNames?: readonly string[];
  /**
   * How the upstream is reached, when the proxy's own way out will not do: a company gateway on a
   * private network needs the address guard lifted for its hostname (GRA-58), and lifting it on the
   * proxy's shared fetch would lift it for a *vendor* host of the same name too — a keyring
   * connection naming the gateway's public-looking name would then send its decrypted credential
   * to the private address. So the exemption rides on the relay leg alone: the ladder sends a
   * relayed hop through this fetch and every other request through its own. Absent, the relay goes
   * out the proxy's way, fully guarded.
   */
  upstreamFetch?: UpstreamFetch;
};

/**
 * A cache for what a scheme *derives* from a credential — the access token an OAuth2 client
 * credentials exchange buys, the JWT the Snowflake scheme signs — keyed by the plugin, per
 * connection. Per process. `get` is synchronous, so a shared cache is not a drop-in: it needs an
 * async `get` and the reads of it in `schemes.ts` awaited.
 */
export type DerivedCredentialCache = {
  get: (key: string) => CredentialFields | undefined;
  set: (key: string, value: CredentialFields, ttlMs: number) => void;
  delete: (key: string) => void;
};

/**
 * Run one asynchronous step per key at a time: a caller that arrives while a step for the same key
 * is in flight awaits that step's result rather than starting its own. What makes two concurrent
 * calls against an expired authorization-code token refresh it once (ADR 0005; `single-flight.ts`).
 */
export type SingleFlight = <T>(key: string, run: () => Promise<T>) => Promise<T>;

/**
 * What a scheme plugin's `derive` step is handed: the connection it is deriving for (the cache
 * key), the proxy's own way out to the network (so a token endpoint answers to the same
 * public-address rule as the vendor), the call's one deadline, the cache, and the clock the cache
 * reads — one clock, so a signed token's expiry and its cache entry's cannot disagree. `once` is
 * the single-flight for a refresh, and `storeCredential` is how a scheme whose stored credential
 * rotates itself — an authorization-code refresh token buying a new access token — hands the
 * rotated fields back to the host to keep, so the next process sends the token this one bought.
 */
export type SchemeRuntime = {
  connectionId: string;
  upstreamFetch: UpstreamFetch;
  signal: AbortSignal;
  cache: DerivedCredentialCache;
  now: () => number;
  once: SingleFlight;
  /** Persist the credential the scheme just rotated — the whole record, secrets included. */
  storeCredential: (fields: CredentialFields) => Promise<void>;
};

/**
 * The claims a verified capability token carries (CONTEXT.md, *Capability token*; minted by
 * `@graft/token`). `person` is the owner every connection is compared against, `agent` the harness
 * connection the exec ran for, `connections` the ids in reach for this exec — the agent's scope,
 * or the part of it the exec was minted for (ADR 0007) — and `tool` what it was minted for. The
 * proxy compares `person` and `connections` against the row; `agent` and `tool` are carried onto
 * the wide event so a vendor call can be traced to the exec that made it.
 */
export type CapabilityClaims = {
  person: string;
  agent: string;
  connections: readonly string[];
  tool: string;
  jti: string;
  exp: number;
  /**
   * The dry-run claim (CONTEXT.md, *Dry run*). True only when the minter asked for a dry run; a
   * token without the claim verifies as `false` and behaves exactly as an ordinary one. With it,
   * `GET` and `HEAD` are forwarded and every other method stops at the proxy with a preview
   * (`dry-run.ts`).
   */
  dryRun: boolean;
};

/** How a dry-run call ended: the read reached the vendor, or the write stopped here. */
export type DryRunOutcome = "forwarded" | "intercepted";

/**
 * What the host's verifier answers. Three refusals rather than one `null`, because the caller is
 * agent code that has to decide between "mint me a new one" (expired) and "something is wrong"
 * (invalid), and because a deployment with no key pair should say so rather than look like every
 * token is bad.
 */
export type TokenVerdict =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: "expired" | "invalid" | "unconfigured" };

/** The published verification keys — RFC 7517's `{ keys: [...] }`. Null when unconfigured. */
export type JsonWebKeySet = { keys: Record<string, unknown>[] };

/** The request the proxy hands its upstream fetch: a plain shape, so a test can record it. */
export type UpstreamRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
};

/**
 * The upstream answer, as the smallest structural slice of `Response` the proxy reads. A real
 * `Response` satisfies it; so does undici's, which is a different class from the global one.
 */
export type UpstreamResponse = {
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * How the proxy reaches a vendor. The default (`createUpstreamFetch`) pins DNS resolution to
 * public addresses; a test injects one that records the request and answers from a script.
 * Redirects are never followed by the fetch itself — the proxy decides about them.
 */
export type UpstreamFetch = (
  request: UpstreamRequest,
  init: { signal: AbortSignal },
) => Promise<UpstreamResponse>;

export type ProxyOptions = {
  /**
   * The break glass (GRA-1, "The proxy and the capability token"): follow a vendor redirect when
   * it stays inside the connection's host set. Off by default — a redirect is the classic way a
   * credential leaves the host it was entered for.
   */
  followRedirects: boolean;
  /**
   * One deadline for the whole call — from the caller's first body byte to the vendor's last —
   * so neither a caller that never finishes sending nor a vendor that never finishes answering
   * can hold a connection and a buffer past it. Named for the vendor leg, which is what it bounds
   * in practice; a body cap of ten megabytes is read in well under a second.
   */
  upstreamTimeoutMs: number;
  /** The most bytes a request or a response body may carry through the proxy. */
  maxBodyBytes: number;
};

/**
 * Why a call ended the way it did — one word per category, and the wide event's `outcome`. The
 * refusal categories double as the `reason` in the JSON body the caller sees, so what the agent's
 * code reads and what the operator greps are the same word.
 */
export type ProxyOutcome =
  | "forwarded"
  | "redirect_returned"
  /** A write stopped by the dry-run claim and answered with a preview — not a refusal. */
  | "dry_run_intercepted"
  | "proxy_unconfigured"
  | "bad_connection_id"
  | "token_missing"
  | "token_invalid"
  | "token_expired"
  | "connection_unknown"
  /** The connection belongs to a person other than the token's (ADR 0007). */
  | "person_mismatch"
  /** The connection is the person's, but not among the ids the token names — outside the scope. */
  | "connection_not_in_token"
  | "connection_not_ready"
  /**
   * The person revoked the connection (GRA-68). Distinct from `connection_not_ready` so the agent's
   * next sentence is "ask the person to reconnect it in the console", not a proposal of the hosts
   * and scheme the row still has: a revoke leaves a keyring row with no credential and a relay row
   * with no reference, and the columns it leaves null are not what is missing. Read after the
   * person and scope checks, so another person's token learns nothing from it.
   */
  | "connection_revoked"
  /**
   * An authorization-code connection whose person has not completed the consent at the vendor —
   * a client secret is stored and no token is (ADR 0005). Distinct from `connection_not_ready` so
   * the agent's next sentence is "complete the consent", not "enter a credential".
   */
  | "consent_required"
  | "credential_unreadable"
  /** A relayed connection's fields could not be assembled — the upstream proxy cannot be addressed (ADR 0019). */
  | "relay_unavailable"
  | "credential_incomplete"
  | "token_exchange_failed"
  | "bad_target"
  /** The explicit form named a host the connection does not declare (ADR 0010). */
  | "host_not_in_set"
  | "host_not_public"
  | "request_too_large"
  | "request_timeout"
  | "response_too_large"
  | "upstream_timeout"
  | "upstream_unreachable"
  | "proxy_error";

/**
 * The one wide event per call — the audit trail GRA-1 asks for: identifiers, the method, the host
 * and vendor path, whether a query string was present, the statuses, latency and byte counts.
 * **Never** a header, a body or a query value: the query is where an API key rides for one of the
 * schemes, and a header is where it rides for the others. Nulls mark what the call never got far
 * enough to learn — a refused token has no connection.
 */
export type ProxyEvent = {
  outcome: ProxyOutcome;
  /** What the proxy answered the caller. */
  status: number;
  /** What the vendor answered the proxy, when it was asked. */
  upstreamStatus: number | null;
  method: string;
  /** The vendor path — everything after the connection and host segments, without the query. */
  path: string | null;
  hasQuery: boolean;
  connectionId: string | null;
  /** From the token, once it verified. */
  personId: string | null;
  agentId: string | null;
  tool: string | null;
  /** The vendor hostname the call resolved to; null when it was refused before resolving one. */
  host: string | null;
  latencyMs: number;
  requestBytes: number | null;
  responseBytes: number | null;
  /** Redirects followed within the host set under the break-glass flag; 0 on an ordinary call. */
  redirectHops: number;
  /**
   * Whether the token carried the dry-run claim, and — once the call got that far — whether it was
   * forwarded to the vendor or intercepted with a preview. Null when neither happened: a call
   * refused before the decision, or an ordinary call. The audit trail's honest answer to "did this
   * reach a vendor".
   */
  dryRun: boolean;
  dryRunOutcome: DryRunOutcome | null;
  /**
   * What an authorization-code connection's stored token did on this call (ADR 0005): `refreshed`
   * when this call bought a fresh access token with the refresh token and stored it,
   * `refresh_failed` when it tried and the vendor's token endpoint refused — after which the
   * vendor's own 401 went back to the caller and the connection was marked for re-consent. Null
   * for every other scheme, and for a call that sent the stored token as it was. Under
   * single-flight, two concurrent calls that shared one refresh record it once, on the call that
   * made it.
   */
  oauth: "refreshed" | "refresh_failed" | null;
  /**
   * The relay scheme the call left through (ADR 0019) — the upstream proxy that injected the
   * credential — or null for a call the proxy signed itself, or refused before the decision. `host`
   * and `path` stay the vendor's either way: the audit trail names where the request was *for*, and
   * this field says what carried it.
   */
  relay: string | null;
  /**
   * The vendor reflected a credential value — into a header or a text-like body — and the proxy
   * redacted it before answering (`echo.ts`; ADR 0010, amended). The audit trail's record that a
   * vendor echoes what it is sent, which is worth knowing about a vendor; false on every call that
   * was refused or intercepted, since no vendor answered.
   */
  credentialEchoed: boolean;
  /**
   * The error behind an `upstream_unreachable`, `credential_unreadable`, `relay_unavailable`,
   * `token_exchange_failed` or `proxy_error` outcome, flattened to one line; null otherwise. `name: message` down the
   * cause chain for the proxy's own errors and the network's; for what a host-injected dependency
   * threw — the vault, the connection store — the dependency and the class names only, because
   * those messages are the host's to compose and might carry anything (`failure.ts`). Never a
   * stack, never a body.
   */
  failure: string | null;
};

/**
 * Everything the proxy is handed rather than owns. The shape is the boundary made concrete: a host
 * binds these to a store, a vault and a key pair; a test binds them to maps and a recorder; nothing
 * in the package reaches past them. What any of them throws is recorded on the event by class name
 * and never by message (`guardHostDeps` in `failure.ts`), so a host may throw whatever is useful
 * to it without reading the proxy's log rules.
 */
export type ProxyDeps = {
  /** Stateless verification of a capability token — the host holds the public key. */
  verifyToken: (token: string) => Promise<TokenVerdict>;
  /** The verification keys, for `/.well-known/jwks.json`. Null when the host has no key pair. */
  jwks: () => Promise<JsonWebKeySet | null>;
  connections: {
    /** A read by id, unscoped — the proxy does the scoping against the token's claims. */
    get: (connectionId: string) => Promise<ProxyConnection | null>;
  };
  /** The vault's decrypt half. Throws when the ciphertext is not this row's or is damaged. */
  decryptCredential: (ciphertext: Uint8Array, scope: CredentialScope) => Promise<CredentialFields>;
  /**
   * The vault's encrypt half and the row write, for a credential a scheme rotated on the way to
   * the vendor — an authorization-code refresh (ADR 0005). The fields are the whole record to store,
   * secrets included; the host encrypts them under the same scope it decrypts with. Optional: a host
   * without it still gets the refreshed token for this call, and forgets it with the process.
   */
  storeCredential?: (scope: CredentialScope, fields: CredentialFields) => Promise<void>;
  /**
   * A refresh the vendor's token endpoint refused, so the person has to consent again (ADR 0005):
   * the host marks the connection so the console offers Reconnect. `reason` is the proxy's own
   * sentence and `upstreamStatus` the endpoint's status; neither ever carries the endpoint's body.
   */
  credentialRefreshFailed?: (
    scope: CredentialScope,
    detail: { reason: string; upstreamStatus: number | null },
  ) => Promise<void>;
  /** Defaults to `createUpstreamFetch()` — undici with a public-address-only resolver. */
  upstreamFetch?: UpstreamFetch;
  /** The wide-event sink. Called exactly once per proxied call, refused or forwarded. */
  log: (event: ProxyEvent) => void;
  /** The clock the derived-credential cache and the signing schemes read — injectable for tests. */
  now?: () => number;
  options?: Partial<ProxyOptions>;
};
