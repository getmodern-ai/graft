import { INBOUND_AUTH_HEADERS } from "./token";

/**
 * Header hygiene on both legs — RFC 9110 §7.6.1's hop-by-hop set, what a proxy that buffers and
 * re-frames must own itself, and what infrastructure stamps on a request on its way in: the
 * sandbox runtime's instrumentation and an edge's forwarding headers. The outgoing policy is
 * `forwardableRequestHeaders`, and nowhere else.
 */

/** Hop-by-hop headers describe one connection and never cross a proxy. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/**
 * Framing the proxy re-derives: it buffers the body and sends it with its own length, so an
 * inbound `content-length` or `expect` describes a message that no longer exists. `host` is the
 * target's, set by the fetch from the URL — an inbound value would be the caller naming a host,
 * which is exactly what pinning forbids. `accept-encoding` is replaced with `identity` so the
 * vendor's bytes come back as they are and the byte count on the wide event is the byte count
 * the caller receives.
 */
const REQUEST_FRAMING = ["host", "content-length", "expect", "accept-encoding"] as const;

/**
 * Instrumentation that describes our infrastructure, not the caller's request. A sandbox's Node
 * runtime stamps W3C Trace Context (`traceparent`, with `tracestate` and `baggage` beside it) on
 * every outbound call, so forwarding it would hand a vendor a trace id from inside our estate on
 * every request — Cando found it arriving at a vendor's echo endpoint in production (ADR 0011).
 * What leaves for the vendor is ours to decide, and the vendor-facing headers the caller and the
 * scheme plugin set are the only ones that should.
 */
const INSTRUMENTATION = ["traceparent", "tracestate", "baggage"] as const;

/**
 * What an edge stamps on a request between the sandbox and this process: a CDN's request id and
 * `via` line, a load balancer's trace id, and the `x-forwarded-*` chain naming the caller's
 * address, scheme, port and our own hostname. Forwarding them hands a vendor a map of our ingress
 * on every call. The CloudFront and ALB names are here because the hosted form deploys on the AWS
 * shapes Cando uses (GRA-1, "Distribution and the skill"); the `x-forwarded-*` set is universal.
 */
const EDGE = [
  "x-amz-cf-id",
  "x-amzn-trace-id",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-host",
  "via",
] as const;

/**
 * Prefixes dropped wholesale, because each is a family whose members are not ours to enumerate.
 * `proxy-*` is addressed to a proxy and never to an origin — the three named in the lists above
 * are the common ones, the prefix is the rest. `x-blaxel-*` is the hosted sandbox provider's own
 * request instrumentation (`x-blaxel-request-id` on every call) and grows at their pace; a vendor
 * learning which provider hosts our sandboxes is the same leak as `traceparent`. `cloudfront-*` is
 * the viewer-attribute family CloudFront adds when a policy asks for it (`cloudfront-viewer-country`,
 * `cloudfront-is-mobile-viewer`, ...); which ones appear is a distribution setting, not something
 * this list should have to track.
 */
const STRIPPED_PREFIXES = ["proxy-", "x-blaxel-", "cloudfront-"] as const;

/**
 * The headers forwarded to the vendor: the caller's, minus every credential-shaped one
 * (`INBOUND_AUTH_HEADERS`), minus hop-by-hop, minus framing, minus instrumentation, minus the
 * edge's stamps, minus every `STRIPPED_PREFIXES` family. Also drops any header named in the
 * caller's own `Connection` header, which is how a client nominates extra hop-by-hop headers. This
 * is the whole outgoing policy by name; `scrubToken` in `token.ts` is the sweep by value that runs
 * after it, and the scheme plugin sets its own header after both.
 */
export function forwardableRequestHeaders(inbound: Headers): Headers {
  const headers = new Headers(inbound);
  for (const nominated of nominatedHopByHop(inbound)) headers.delete(nominated);
  for (const name of [
    ...INBOUND_AUTH_HEADERS,
    ...HOP_BY_HOP,
    ...REQUEST_FRAMING,
    ...INSTRUMENTATION,
    ...EDGE,
  ]) {
    headers.delete(name);
  }
  // `Headers` lower-cases every name, so a prefix match here is case-insensitive by construction.
  for (const name of [...headers.keys()]) {
    if (STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) headers.delete(name);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * The response-header namespace that is the proxy's alone. Every `x-graft-*` header the caller
 * reads off an answer — `x-graft-dry-run`, `x-graft-redacted`, `x-graft-refusal` — is a statement
 * *by the proxy* about what it did, and the runner and the acquire job act on those statements
 * (a dry-run preview, a job ended as `vendor_unreachable`). A vendor's response carrying one is
 * therefore dropped before anything of the proxy's is set: a vendor may not speak in the proxy's
 * voice, whether by accident or to end a job it would rather not be built against (GRA-79,
 * Greptile on #59). The relays run through the same return path, so a gateway's or a broker's
 * answer is held to it too. Family-wide by prefix, for the reason `STRIPPED_PREFIXES` gives.
 */
export const PROXY_RESPONSE_HEADER_PREFIX = "x-graft-";

/**
 * The vendor's headers, handed back minus hop-by-hop and minus framing: the proxy buffers the
 * body, so `content-length` is re-derived from the bytes actually sent, and a `content-encoding`
 * the fetch already decoded must not be repeated — the caller would try to decode plain bytes.
 * Minus, too, anything in the proxy's own response namespace (`PROXY_RESPONSE_HEADER_PREFIX`) —
 * the proxy sets its own after this. Everything else — content type, rate-limit hints, request
 * ids, `set-cookie`, `location` — is the vendor's answer and passes through verbatim.
 */
export function passthroughResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const nominated of nominatedHopByHop(upstream)) headers.delete(nominated);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.delete("content-length");
  headers.delete("content-encoding");
  // `Headers` lower-cases every name, so the prefix match is case-insensitive by construction.
  for (const name of [...headers.keys()]) {
    if (name.startsWith(PROXY_RESPONSE_HEADER_PREFIX)) headers.delete(name);
  }
  return headers;
}

const TOKEN = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

function nominatedHopByHop(headers: Headers): string[] {
  const connection = headers.get("connection");
  if (!connection) return [];
  return connection
    .split(",")
    .map((name) => name.trim())
    .filter((name) => TOKEN.test(name));
}
