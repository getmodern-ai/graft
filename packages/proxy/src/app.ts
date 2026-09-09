import { type Context, Hono } from "hono";

import { declaredLength, readCapped } from "./body";
import { createDerivedCredentialCache } from "./cache";
import {
  type CredentialSource,
  credentialSource,
  tryUrl,
  wireCredential,
} from "./credential-source";
import {
  buildDryRunPreview,
  DRY_RUN_HEADER,
  DRY_RUN_PREVIEW_STATUS,
  type DryRunOutcome,
  isSafeMethod,
  schemeHeaderNames,
} from "./dry-run";
import {
  describeFailure,
  guardHostDeps,
  type Refused,
  refusalBody,
  refuse,
  refuseIncomplete,
  refuseResponseTimeout,
  refuseResponseTooLarge,
  refuseResponseUnreadable,
  refuseUpstreamFailure,
} from "./failure";
import { forwardableRequestHeaders, passthroughResponseHeaders } from "./headers";
import { isPublicHost } from "./public-host";
import { type Hop, isRedirect, nextHop, scrubReturnedRedirect } from "./redirects";
import { SCHEMES, type SchemePlugin, type SchemeTarget } from "./schemes";
import { createSingleFlight } from "./single-flight";
import { extractToken, scrubToken } from "./token";
import type {
  CredentialFields,
  CredentialScope,
  DerivedCredentialCache,
  ProxyDeps,
  ProxyEvent,
  ProxyOptions,
  SchemeConfig,
  SchemeRuntime,
  SingleFlight,
  UpstreamFetch,
  UpstreamResponse,
} from "./types";
import { createUpstreamFetch, isTimeoutFailure } from "./upstream";

/**
 * The proxy — the one route from a sandbox to a vendor (CONTEXT.md, *Proxy*; ADR 0010 for why an
 * SDK goes through it too). Copied from Cando and re-read on the way in (ADR 0011).
 *
 * Two path forms, one ladder. `/c/:connectionId/<vendor path>` names *which* credential and
 * resolves against the connection's primary host — what `ctx.fetch` uses. `/c/:connectionId/h/
 * :host/<vendor path>` names one of the connection's declared hosts explicitly and resolves
 * against that host's origin — what an SDK pointed at `ctx.proxyBase(host)` sends, so one Google
 * connection reaches three Google hosts (ADR 0010). The query string rides along in both. Per
 * call, in order: the capability token is read from wherever the SDK put it and verified
 * statelessly; the connection is loaded and checked to be the token's person's and among the
 * connections the token names (ADR 0007); the target is resolved and refused outside the host
 * set; every credential-shaped inbound header is stripped and the token itself swept from any
 * other position it rode in — the token is the placeholder credential an SDK was constructed with,
 * and it reaches no vendor; the credential is decrypted; the scheme plugin attaches it; the
 * request goes to the resolved host and nowhere else, with the resolver refusing private
 * addresses; a redirect comes back to the caller unless the break-glass flag allows a hop inside
 * the host set; and the vendor's status, headers and body come back verbatim. One wide event per
 * call, whatever happened.
 *
 * One rung is conditional on the token: with the dry-run claim (CONTEXT.md, *Dry run*), a `GET`
 * or `HEAD` takes the ladder above unchanged and comes back marked `x-graft-dry-run: forwarded`,
 * and every other method stops after the host check — before a credential is obtained — with a
 * 202 preview of the request that would have left (`dry-run.ts`).
 *
 * This file is the ladder and the vendor leg; three questions it answers by delegation are modules
 * of their own: `credential-source.ts` says where the credential comes from and what goes on the
 * wire, `redirects.ts` decides about a 3xx, and `failure.ts` builds every refusal —
 * `{ error, reason, message }` with `reason` one of `ProxyOutcome`'s words, the same word the wide
 * event carries, so the agent's code and the operator read the same category. The token itself is
 * never echoed, and what a host-injected dependency throws reaches the event as a class name,
 * never a message (`guardHostDeps` in `failure.ts`).
 */

export const DEFAULT_PROXY_OPTIONS: ProxyOptions = {
  followRedirects: false,
  upstreamTimeoutMs: 30_000,
  maxBodyBytes: 10 * 1024 * 1024,
};

/**
 * The literal segment that says the next one names a host: `/c/<id>/h/<host>/<path>`. A marker
 * rather than sniffing whether a segment looks like a hostname, so the two forms cannot be
 * confused — at the price that a vendor path whose first segment is `h` is reachable only through
 * the explicit form, `/c/<id>/h/<primary host>/h/...`.
 */
export const HOST_SEGMENT_MARKER = "h";

/**
 * The path a caller uses to reach a connection — the plain form against its primary host, or the
 * explicit form for a declared host. The runner's `ctx.proxyBase(host?)` appends this to the
 * proxy's public URL (ADR 0010); exported so the check and the runner's tests build the same
 * string the proxy parses.
 */
export function proxyPathFor(connectionId: string, host?: string): string {
  return host === undefined
    ? `/c/${connectionId}`
    : `/c/${connectionId}/${HOST_SEGMENT_MARKER}/${host.trim().toLowerCase()}`;
}

/** A connection id as the connection service mints them — a `crypto.randomUUID()` today. */
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What the explicit form accepts as a host segment: a DNS name, lower-case, no port or brackets. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Statuses the `Response` constructor refuses a body for, whatever the vendor sent. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function createProxyApp(deps: ProxyDeps): Hono {
  const options: ProxyOptions = { ...DEFAULT_PROXY_OPTIONS, ...deps.options };
  const upstream = deps.upstreamFetch ?? createUpstreamFetch();
  const now = deps.now ?? Date.now;
  // One cache and one single-flight per app: per process in production, per harness in a test.
  const cache = createDerivedCredentialCache(now);
  const once = createSingleFlight();
  // What the host bound, with what it throws recorded by class name and never by message
  // (`failure.ts`). Everything below reads the host through `host`, never through `deps`.
  const host = guardHostDeps(deps);
  const app = new Hono();

  /**
   * The verification key, published so a later standalone proxy — or anything else that wants to
   * check a token — verifies exactly as this one does (GRA-1, "The proxy and the capability
   * token"). Five minutes of caching: a key rotation wants to propagate, and nothing else about it
   * changes.
   */
  app.get("/.well-known/jwks.json", async (c) => {
    const jwks = await host.jwks();
    if (!jwks) {
      return c.json(
        refusalBody(503, "proxy_unconfigured", "This deployment has no capability token key pair"),
        503,
      );
    }
    return c.json(jwks, 200, { "cache-control": "public, max-age=300" });
  });

  const handle = (c: Context) => proxyCall(c, host, options, { upstream, cache, now, once });
  // Both shapes, because `/c/:id/*` alone does not match a bare `/c/:id` (the vendor's root). The
  // explicit host form is inside the wildcard and read out of the raw path by `routeOf`.
  app.all("/c/:connectionId", handle);
  app.all("/c/:connectionId/*", handle);

  return app;
}

/** What one app instance owns for the life of the process, handed to every call. */
type Shared = {
  upstream: UpstreamFetch;
  cache: DerivedCredentialCache;
  now: () => number;
  once: SingleFlight;
};

/** What the wide event learns as the call gets further; nulls for what it never reached. */
type Trace = {
  connectionId: string | null;
  personId: string | null;
  agentId: string | null;
  tool: string | null;
  host: string | null;
  /** From the token once it verifies; the outcome once the call is intercepted or leaves. */
  dryRun: boolean;
  dryRunOutcome: DryRunOutcome | null;
  /** What an authorization-code token did on this call; `forward` sets it (`ProxyEvent.oauth`). */
  oauth: ProxyEvent["oauth"];
};

type Answered = {
  kind: "answered";
  response: Response;
  outcome: "forwarded" | "redirect_returned";
  upstreamStatus: number;
  requestBytes: number;
  responseBytes: number;
  redirectHops: number;
};

/** A write stopped by the dry-run claim: the proxy's own answer, with no vendor status to report. */
type Intercepted = {
  kind: "intercepted";
  response: Response;
  requestBytes: number;
  responseBytes: number;
};

/**
 * One call as the path spelled it. `host` is null for the plain form, the decoded host segment for
 * the explicit form — the empty string when the marker was there and no host followed it.
 */
type Call = {
  url: URL;
  method: string;
  connectionId: string;
  host: string | null;
  vendorPath: string;
};

async function proxyCall(
  c: Context,
  deps: ProxyDeps,
  options: ProxyOptions,
  shared: Shared,
): Promise<Response> {
  const started = performance.now();
  const url = new URL(c.req.url);
  const method = c.req.method.toUpperCase();
  const connectionId = c.req.param("connectionId") ?? "";
  const call: Call = { url, method, connectionId, ...routeOf(url, connectionId) };
  const trace: Trace = {
    connectionId: null,
    personId: null,
    agentId: null,
    tool: null,
    host: null,
    dryRun: false,
    dryRunOutcome: null,
    oauth: null,
  };

  let result: Refused | Answered | Intercepted;
  try {
    result = await decide(c.req.raw, call, trace, deps, options, shared);
  } catch (error) {
    // A bug in the proxy, or a host dependency that threw on a rung with no refusal of its own (the
    // connection store) — not a refusal, but still one event, with the failure flattened onto it.
    result = refuse(500, "proxy_error", "The proxy failed to handle the request", {
      failure: error,
    });
  }

  const common = {
    method,
    path: call.vendorPath,
    hasQuery: url.search.length > 1,
    ...trace,
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
  };

  if (result.kind === "refused") {
    const event: ProxyEvent = {
      ...common,
      outcome: result.reason,
      status: result.status,
      upstreamStatus: result.upstreamStatus ?? null,
      requestBytes: result.requestBytes ?? null,
      responseBytes: null,
      redirectHops: 0,
      failure: describeFailure(result.failure),
    };
    deps.log(event);
    return c.json(refusalBody(result.status, result.reason, result.message), result.status);
  }

  if (result.kind === "intercepted") {
    // Not a refusal and not a vendor answer: its own outcome word, and no upstream status, because
    // no vendor was asked. `responseBytes` is the preview the caller received.
    deps.log({
      ...common,
      outcome: "dry_run_intercepted",
      status: result.response.status,
      upstreamStatus: null,
      requestBytes: result.requestBytes,
      responseBytes: result.responseBytes,
      redirectHops: 0,
      failure: null,
    });
    return result.response;
  }

  deps.log({
    ...common,
    outcome: result.outcome,
    status: result.response.status,
    upstreamStatus: result.upstreamStatus,
    requestBytes: result.requestBytes,
    responseBytes: result.responseBytes,
    redirectHops: result.redirectHops,
    failure: null,
  });
  return result.response;
}

/**
 * The ladder. Each rung either refuses with a category or hands what it learned to the next; the
 * order is the order in which a refusal costs the least — a token is checked before a row is read,
 * a row before a body is buffered, a body before a credential is decrypted.
 */
async function decide(
  request: Request,
  call: Call,
  trace: Trace,
  deps: ProxyDeps,
  options: ProxyOptions,
  shared: Shared,
): Promise<Refused | Answered | Intercepted> {
  // One deadline for the whole call, started before anything is read: the caller's body and the
  // vendor's answer share it, so neither a caller that never finishes sending nor a vendor that
  // never finishes answering can hold a connection and a buffer past it.
  const signal = AbortSignal.timeout(options.upstreamTimeoutMs);

  if (!CONNECTION_ID.test(call.connectionId)) {
    return refuse(400, "bad_connection_id", "The connection id in the path is malformed");
  }

  const token = extractToken(request.headers);
  if (!token) {
    return refuse(
      401,
      "token_missing",
      "Send the capability token as Authorization: Bearer, x-api-key or x-graft-token",
    );
  }

  const verdict = await deps.verifyToken(token);
  if (!verdict.ok) {
    switch (verdict.reason) {
      case "unconfigured":
        return refuse(
          503,
          "proxy_unconfigured",
          "This deployment has no capability token key pair",
        );
      case "expired":
        return refuse(
          401,
          "token_expired",
          "The capability token has expired; run the tool again for a fresh one",
        );
      default:
        return refuse(401, "token_invalid", "The capability token could not be verified");
    }
  }
  const claims = verdict.claims;
  trace.agentId = claims.agent;
  trace.personId = claims.person;
  trace.tool = claims.tool;
  trace.dryRun = claims.dryRun;

  const connection = await deps.connections.get(call.connectionId);
  if (!connection) return refuse(404, "connection_unknown", "No connection has that id");
  trace.connectionId = connection.id;

  // The token *is* the scope decision (ADR 0007); the proxy checks only that it fits this row — the
  // connection is the token's person's, and among the connections the token names.
  if (connection.personId !== claims.person) {
    return refuse(403, "person_mismatch", "The connection belongs to another person");
  }
  if (!claims.connections.includes(connection.id)) {
    return refuse(403, "connection_not_in_token", "The token does not name this connection");
  }

  const source = credentialSource(connection, deps);
  if (source.kind === "refused") return source;
  const plugin = SCHEMES[source.authScheme];

  const target = resolveTarget(source, call);
  if (target.kind === "refused") return target;
  trace.host = target.url.hostname;
  // The literal check — an IP literal, `localhost`, an internal name. The resolver inside the
  // upstream fetch judges what the name resolves to (`upstream.ts`).
  if (!isPublicHost(target.base.hostname)) {
    return refuse(403, "host_not_public", "The vendor host is not a public address");
  }

  let body: Uint8Array | null = null;
  if (!isSafeMethod(call.method)) {
    const declared = declaredLength(request.headers);
    if (declared !== null && declared > options.maxBodyBytes) {
      return refuse(
        413,
        "request_too_large",
        `Request bodies are capped at ${options.maxBodyBytes} bytes`,
      );
    }
    const read = await readCapped(request.body, options.maxBodyBytes, signal);
    if (!read.ok) {
      return read.reason === "aborted"
        ? refuse(
            408,
            "request_timeout",
            `The request body did not arrive within ${options.upstreamTimeoutMs} ms`,
          )
        : refuse(
            413,
            "request_too_large",
            `Request bodies are capped at ${options.maxBodyBytes} bytes`,
          );
    }
    body = read.bytes;
  }
  const requestBytes = body?.byteLength ?? 0;

  // The outgoing headers, once: the caller's minus every credential-shaped one (`headers.ts`),
  // then minus any other header or query parameter that carried the token itself (`token.ts`) —
  // an SDK constructed with the token as its key may have put it anywhere.
  const headers = forwardableRequestHeaders(request.headers);
  scrubToken(headers, target.url, token);

  /**
   * The dry-run rung (CONTEXT.md, *Dry run*). After every check above, and *before* the credential
   * is obtained: a write in a dry run costs the vendor nothing, not even a token exchange, and the
   * proxy never decrypts a credential it is not about to send. A `GET` or `HEAD` under the same
   * claim falls through to `forward` exactly as an ordinary call does.
   */
  if (claims.dryRun && !isSafeMethod(call.method)) {
    const named = schemeHeaderNames(headers, plugin, source.schemeConfig);
    if (!named.ok) return refuse(409, named.reason, named.message, { requestBytes });
    trace.dryRunOutcome = "intercepted";
    return intercept(call.method, target.url, named.headerNames, body, requestBytes);
  }

  let credential: CredentialFields;
  try {
    credential = await source.obtain();
  } catch (error) {
    return source.unavailable(error, requestBytes);
  }

  // The host keeps what a scheme rotates on the way to the vendor, under the scope it decrypts with
  // (ADR 0005); a host that bound neither seam gets the refreshed token for this call alone.
  const scope: CredentialScope = { personId: connection.personId, connectionId: connection.id };
  const { storeCredential, credentialRefreshFailed } = deps;
  return forward(
    {
      headers,
      options,
      shared,
      plugin,
      config: source.schemeConfig,
      credential,
      connectionId: connection.id,
      hosts: source.hosts,
      signal,
      trace,
      rotation: {
        store: storeCredential ? (fields) => storeCredential(scope, fields) : async () => undefined,
        failed: credentialRefreshFailed
          ? (detail) => credentialRefreshFailed(scope, detail)
          : async () => undefined,
      },
    },
    { method: call.method, url: target.url, body },
    requestBytes,
  );
}

/**
 * The preview an intercepted write answers (`dry-run.ts` has the shape and the status). Header
 * names only, and the caller's own body back to it; nothing here was ever sent to a vendor.
 */
function intercept(
  method: string,
  url: URL,
  headerNames: readonly string[],
  body: Uint8Array | null,
  requestBytes: number,
): Intercepted {
  const preview = buildDryRunPreview({ method, url, headerNames, body });
  const bytes = new TextEncoder().encode(JSON.stringify(preview));
  return {
    kind: "intercepted",
    response: new Response(bytes, {
      status: DRY_RUN_PREVIEW_STATUS,
      headers: { "content-type": "application/json", [DRY_RUN_HEADER]: "intercepted" },
    }),
    requestBytes,
    responseBytes: bytes.byteLength,
  };
}

type Target = { kind: "target"; base: URL; url: URL };

/**
 * The vendor URL, in one of two forms. Plain: the primary host's origin and path prefix, then the
 * caller's path and query. Explicit: `https://` plus the named host — refused unless it is in the
 * connection's set (ADR 0010) — and the caller's path from the root, because an SDK pointed at
 * `ctx.proxyBase(host)` knows its own paths and a base path would be prepended to them twice.
 * Either way the URL is built by assigning `pathname` and `search` on a copy of the base — the one
 * construction under which nothing in the caller's path can move the host — and checked afterwards
 * anyway, because host pinning is the property everything else here rests on.
 */
function resolveTarget(source: CredentialSource, call: Call): Target | Refused {
  let base: URL | null;
  if (call.host === null) {
    base = tryUrl(source.primaryHost);
    if (!base) return refuse(400, "bad_target", "The connection's primary host is not a URL");
  } else {
    if (call.host === "") {
      return refuse(
        403,
        "host_not_in_set",
        `The path names no host after the ${HOST_SEGMENT_MARKER} segment`,
      );
    }
    if (!HOSTNAME.test(call.host) || !source.hosts.has(call.host)) {
      return refuse(
        403,
        "host_not_in_set",
        "The host in the path is not one the connection declares",
      );
    }
    base = new URL(`https://${call.host}`);
  }
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/, "")}${call.vendorPath}`;
  url.search = call.url.search;
  url.hash = "";
  if (url.protocol !== base.protocol || url.host !== base.host) {
    return refuse(400, "bad_target", "The request does not resolve within the vendor host");
  }
  return { kind: "target", base, url };
}

type Forwarding = {
  /** The caller's headers after the outgoing policy and the token sweep — the base of every hop. */
  headers: Headers;
  options: ProxyOptions;
  shared: Shared;
  plugin: SchemePlugin;
  config: SchemeConfig;
  credential: CredentialFields;
  connectionId: string;
  /** The connection's host set — what a followed redirect must stay inside (`redirects.ts`). */
  hosts: ReadonlySet<string>;
  /** The call's one deadline, already running since before the caller's body was read. */
  signal: AbortSignal;
  /** The event's running record; `forward` marks the moment a dry-run read leaves. */
  trace: Trace;
  /** The host's two seams for a credential the scheme rotates, bound to this connection's scope. */
  rotation: {
    store: (fields: CredentialFields) => Promise<void>;
    failed: (detail: { reason: string; upstreamStatus: number | null }) => Promise<void>;
  };
};

/**
 * The vendor leg, as the steps it is made of: the wire credential is derived once; then, per hop,
 * the scheme is applied to a fresh copy of the caller's headers, the request is sent, a 401 against
 * a derived credential buys a fresh one and resends the same hop once, a redirect the policy allows
 * becomes the next hop, and otherwise the body is read under the cap and the vendor's answer goes
 * back. Each step answers either what the next needs or a `Refused`, and the loop returns the first
 * refusal it meets.
 *
 * One credential is allowed to go out **stale**: an authorization-code token the scheme tried and
 * failed to refresh (ADR 0005). The stored token is sent as it is and whatever the vendor answers —
 * its 401, in the usual case — goes back untouched, so the agent's code reads the vendor's own
 * refusal rather than the proxy's; the host is told the refresh failed, which is what turns the
 * console's button into Reconnect, and the event says `oauth: refresh_failed`.
 */
async function forward(
  forwarding: Forwarding,
  first: Hop,
  requestBytes: number,
): Promise<Refused | Answered> {
  const { headers, options, shared, plugin, config, credential, hosts, signal, trace } = forwarding;
  // The same deadline covers every hop and the token exchange — thirty seconds is the ceiling on
  // how long a vendor may hold the agent's call, not a per-hop allowance. `storeCredential` is
  // reached only by the call that made the refresh — under single-flight the others await its
  // result — so the event records the refresh on that one call.
  const runtime: SchemeRuntime = {
    connectionId: forwarding.connectionId,
    upstreamFetch: shared.upstream,
    signal,
    cache: shared.cache,
    now: shared.now,
    once: shared.once,
    storeCredential: async (fields) => {
      trace.oauth = "refreshed";
      await forwarding.rotation.store(fields);
    },
  };
  // The two words the host may have, and never the stale record beside them on the same object.
  const refreshFailed = async (stale: { reason: string; upstreamStatus: number | null }) => {
    trace.oauth = "refresh_failed";
    await forwarding.rotation.failed({
      reason: stale.reason,
      upstreamStatus: stale.upstreamStatus,
    });
  };

  const deriveWire = (refresh: boolean) =>
    wireCredential(plugin, credential, config, runtime, { refresh }, requestBytes);

  const derived = await deriveWire(false);
  if (derived.kind === "refused") return derived;
  let wire = derived.credential;
  // A token that could not be refreshed before the call is not refreshed again after it either.
  let refreshed = derived.kind === "stale";
  if (derived.kind === "stale") await refreshFailed(derived);

  let hop = first;
  let hops = 0;
  while (true) {
    const outgoing = applyScheme(hop, headers, plugin, wire, config, requestBytes);
    if (outgoing.kind === "refused") return outgoing;

    // Set as the request leaves, not when it answers: a dry-run read that then times out was still
    // forwarded, and the audit trail says so.
    if (trace.dryRun) trace.dryRunOutcome = "forwarded";
    const sent = await sendHop(shared.upstream, hop, outgoing.target, signal, requestBytes);
    if (sent.kind === "refused") return sent;
    const { response } = sent;

    /**
     * A 401 against a derived credential is read as "the token died early" exactly once: the
     * scheme makes a fresh one and the same hop is sent again. A second 401 is the vendor's answer
     * and passes through like any other — the agent's code sees it, verbatim. So does the first,
     * when the scheme could not make a fresh one: the vendor's 401 is kept and returned below.
     */
    if (response.status === 401 && plugin.derive && !refreshed) {
      refreshed = true;
      const fresh = await deriveWire(true);
      if (fresh.kind === "refused") {
        await discard(response);
        return fresh;
      }
      if (fresh.kind === "wire") {
        await discard(response);
        wire = fresh.credential;
        continue;
      }
      await refreshFailed(fresh);
    }

    const next = nextHop(response, hop, hosts, options, hops);
    if (next) {
      await discard(response);
      hops += 1;
      hop = next;
      continue;
    }

    const read = await readResponse(response, hop.method, options, signal, requestBytes);
    if (read.kind === "refused") return read;

    return answer(forwarding, {
      response,
      bytes: read.bytes,
      hop,
      sentTo: outgoing.target.url,
      wire,
      hops,
      requestBytes,
    });
  }
}

/** The outgoing request for one hop, once the scheme has attached the credential. */
type Applied = { kind: "applied"; target: SchemeTarget };

/**
 * The scheme applied to a fresh copy of the caller's headers and this hop's URL — after the
 * stripping pass, so the plugin's header is the only credential present, and once per hop, because
 * a followed redirect is a new request to the vendor. A misconfigured scheme is the connection's
 * refusal; any other error the plugin throws is the proxy's own and propagates.
 */
function applyScheme(
  hop: Hop,
  baseHeaders: Headers,
  plugin: SchemePlugin,
  wire: CredentialFields,
  config: SchemeConfig,
  requestBytes: number,
): Applied | Refused {
  const target: SchemeTarget = { url: new URL(hop.url.href), headers: new Headers(baseHeaders) };
  try {
    plugin.apply(target, wire, config);
  } catch (error) {
    const incomplete = refuseIncomplete(error, requestBytes);
    if (incomplete) return incomplete;
    throw error;
  }
  return { kind: "applied", target };
}

type Sent = { kind: "sent"; response: UpstreamResponse };

/**
 * One request to the vendor. A fetch that throws is classified by `refuseUpstreamFailure`; a status
 * outside 200–599 is not one the `Response` constructor accepts nor one a vendor means, so it is
 * refused as unreachable rather than handed back.
 */
async function sendHop(
  upstream: UpstreamFetch,
  hop: Hop,
  target: SchemeTarget,
  signal: AbortSignal,
  requestBytes: number,
): Promise<Sent | Refused> {
  let response: UpstreamResponse;
  try {
    response = await upstream(
      { url: target.url.href, method: hop.method, headers: target.headers, body: hop.body },
      { signal },
    );
  } catch (error) {
    return refuseUpstreamFailure(error, requestBytes);
  }
  if (response.status < 200 || response.status > 599) {
    await discard(response);
    return refuse(502, "upstream_unreachable", "The vendor answered an unusable status", {
      requestBytes,
      upstreamStatus: response.status,
    });
  }
  return { kind: "sent", response };
}

/** Drop a vendor body the caller will never see, so the connection is not left holding it. */
async function discard(response: UpstreamResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

type Read = { kind: "read"; bytes: Uint8Array<ArrayBuffer> };

/**
 * The vendor's body under the cap and the deadline. A declared length over the cap is refused
 * before a byte is read — except on a `HEAD`, whose `content-length` describes a body that is not
 * coming; the read itself enforces the cap and the deadline for everything else.
 */
async function readResponse(
  response: UpstreamResponse,
  method: string,
  options: ProxyOptions,
  signal: AbortSignal,
  requestBytes: number,
): Promise<Read | Refused> {
  const detail = { requestBytes, upstreamStatus: response.status };
  if (method !== "HEAD") {
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > options.maxBodyBytes) {
      await discard(response);
      return refuseResponseTooLarge(options, detail);
    }
  }
  try {
    const read = await readCapped(response.body, options.maxBodyBytes, signal);
    if (!read.ok) {
      return read.reason === "aborted"
        ? refuseResponseTimeout(detail)
        : refuseResponseTooLarge(options, detail);
    }
    return { kind: "read", bytes: read.bytes };
  } catch (error) {
    if (isTimeoutFailure(error)) return refuseResponseTimeout(detail);
    return refuseResponseUnreadable(error, detail);
  }
}

type Delivery = {
  response: UpstreamResponse;
  bytes: Uint8Array<ArrayBuffer>;
  /** The hop that was answered — its method decides whether a body goes back. */
  hop: Hop;
  /**
   * The URL the request actually went to, scheme applied — what a relative `Location` resolves
   * against.
   */
  sentTo: URL;
  /** The wire credential, which a vendor may echo alongside the stored one. */
  wire: CredentialFields;
  hops: number;
  requestBytes: number;
};

/**
 * The vendor's answer, verbatim minus what is not the caller's to have: hop-by-hop and framing
 * headers (`headers.ts`), what the scheme put on a returned redirect's URL (`redirects.ts`), and
 * any credential value the vendor reflected into a header. The one header the proxy adds is the
 * dry-run marker, and only under the claim: it tells the runner this response is real, as against
 * the preview an intercepted write gets.
 */
function answer(forwarding: Forwarding, delivery: Delivery): Answered {
  const { plugin, config, credential, trace } = forwarding;
  const { response, bytes, hop, sentTo, wire, hops, requestBytes } = delivery;

  const returned = passthroughResponseHeaders(response.headers);
  if (isRedirect(response.status)) scrubReturnedRedirect(returned, sentTo, plugin, config);
  // Both the stored and the derived values: a vendor may echo either.
  redactCredentialEchoes(returned, { ...credential, ...wire });
  if (trace.dryRun) returned.set(DRY_RUN_HEADER, "forwarded");

  const nullBody = hop.method === "HEAD" || NULL_BODY_STATUSES.has(response.status);
  return {
    kind: "answered",
    response: new Response(nullBody ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: returned,
    }),
    outcome: isRedirect(response.status) ? "redirect_returned" : "forwarded",
    upstreamStatus: response.status,
    requestBytes,
    responseBytes: nullBody ? 0 : bytes.byteLength,
    redirectHops: hops,
  };
}

/** Shorter credential values would match header text by accident; a real key is far longer. */
const MIN_REDACTABLE_LENGTH = 8;

/**
 * A credential value the vendor reflected into a response header comes back as `<redacted>` —
 * the other half of the reflection case above, for vendors that echo an `Authorization` or a key
 * header they were sent. Header values only: a body is the vendor's answer and passes through
 * verbatim, so a vendor that echoes a key in a body is the vendor's doing, not the proxy's.
 * `set-cookie` is handled through `getSetCookie` because it is the one header that may
 * legitimately appear more than once.
 */
function redactCredentialEchoes(headers: Headers, credential: CredentialFields): void {
  const secrets = Object.values(credential).filter((v) => v.length >= MIN_REDACTABLE_LENGTH);
  if (secrets.length === 0) return;
  const redact = (value: string) =>
    secrets.reduce((text, secret) => text.split(secret).join("<redacted>"), value);

  const cookies = headers.getSetCookie();
  for (const [name, value] of [...headers.entries()]) {
    if (name === "set-cookie") continue;
    const clean = redact(value);
    if (clean !== value) headers.set(name, clean);
  }
  if (cookies.some((cookie) => redact(cookie) !== cookie)) {
    headers.delete("set-cookie");
    for (const cookie of cookies) headers.append("set-cookie", redact(cookie));
  }
}

/**
 * Everything after `/c/<id>` in the raw path, read as one of the two forms. Raw, so
 * percent-encoding reaches the vendor as the caller wrote it; the one segment that is decoded is
 * the host, which is compared against the set and never forwarded as text. The connection id has
 * already matched `CONNECTION_ID` by the time this is used for anything, so its raw and decoded
 * spellings are the same string.
 */
function routeOf(url: URL, connectionId: string): Pick<Call, "host" | "vendorPath"> {
  const marker = `/c/${connectionId}`;
  const index = connectionId ? url.pathname.indexOf(marker) : -1;
  const rest = index < 0 ? "" : url.pathname.slice(index + marker.length);

  const hostMarker = `/${HOST_SEGMENT_MARKER}`;
  if (rest !== hostMarker && !rest.startsWith(`${hostMarker}/`)) {
    return { host: null, vendorPath: pathOrRoot(rest) };
  }
  const afterMarker = rest.slice(hostMarker.length);
  const slash = afterMarker.indexOf("/", 1);
  const segment = slash < 0 ? afterMarker.slice(1) : afterMarker.slice(1, slash);
  const remainder = slash < 0 ? "" : afterMarker.slice(slash);
  return { host: decodeHostSegment(segment), vendorPath: pathOrRoot(remainder) };
}

function pathOrRoot(rest: string): string {
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** Lower-cased and percent-decoded; a segment that does not decode is compared as it was spelled. */
function decodeHostSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).trim().toLowerCase();
  } catch {
    return segment.trim().toLowerCase();
  }
}
