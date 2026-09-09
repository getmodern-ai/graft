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
 * brokered-credential seam is gone, because Graft holds every credential itself (ADR 0001).
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
  "unleashed_hmac",
  "snowflake_keypair_jwt",
] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

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
 * What a scheme plugin's `derive` step is handed: the connection it is deriving for (the cache
 * key), the proxy's own way out to the network (so a token endpoint answers to the same
 * public-address rule as the vendor), the call's one deadline, the cache, and the clock the cache
 * reads — one clock, so a signed token's expiry and its cache entry's cannot disagree.
 */
export type SchemeRuntime = {
  connectionId: string;
  upstreamFetch: UpstreamFetch;
  signal: AbortSignal;
  cache: DerivedCredentialCache;
  now: () => number;
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
  | "credential_unreadable"
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
   * The error behind an `upstream_unreachable`, `credential_unreadable`, `token_exchange_failed`
   * or `proxy_error` outcome, flattened to one line; null otherwise. `name: message` down the
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
  /** Defaults to `createUpstreamFetch()` — undici with a public-address-only resolver. */
  upstreamFetch?: UpstreamFetch;
  /** The wide-event sink. Called exactly once per proxied call, refused or forwarded. */
  log: (event: ProxyEvent) => void;
  /** The clock the derived-credential cache and the signing schemes read — injectable for tests. */
  now?: () => number;
  options?: Partial<ProxyOptions>;
};
