import { MissingCredentialFieldError } from "./scheme-errors";
import type { CredentialFields, RelayHeaderRules, RelayPlugin, SchemeTarget } from "./types";

/**
 * The `gateway` relay (ADR 0019, GRA-58): a company's API gateway fronts the vendors it covers and
 * holds their credentials, and a Graft deployment authenticates to it once, with a header the
 * operator configured. Nothing here is per connection: which vendors the gateway covers, where it
 * answers and how the deployment identifies itself are the deployment's configuration
 * (`GRAFT_GATEWAY_*` in `@graft/env`), read by the gateway *provider* in `@graft/core` and handed
 * to this plugin as the relay's fields on every call — a connection row under the gateway carries
 * no credential and no address.
 *
 * **The vendor URL travels in the path**: `<upstream>/<vendor host>/<vendor path>?<vendor query>`.
 * Chosen over a header naming the vendor host because it is how API gateways route — one route per
 * covered vendor, `/api.vendor.example/*` forwarded to `https://api.vendor.example/*`, so the
 * gateway's route table *is* the list of covered hosts and needs no header to be read before the
 * route is chosen — and because Modern's forward proxy, which ADR 0010 inherits from, already spoke
 * `/forward/<host>/<path>`. The vendor's scheme is not carried: every host a connection declares is
 * an https host (`@graft/core`'s host rule), so the segment is the host alone, with its port when
 * the vendor's URL has one. The gateway's own base path, when it has one, is kept in front.
 *
 * **The caller's headers travel unchanged**, minus what the outgoing policy already stripped
 * (`headers.ts`: `authorization`, `cookie`, the token in any position): a gateway fronting the
 * vendor forwards what it receives. An operator whose gateway forwards caller headers only under a
 * prefix sets one (`GRAFT_GATEWAY_HEADER_PREFIX`), which the provider hands the proxy as this
 * connection's rule override (`ProxyRelay.rules`); the plugin's own rules below stay the defaults.
 *
 * **What this file does not know**: the identity header's name. It is a field like the value, so
 * `headerNames()` — what a dry run asks a plugin — names nothing here, and the provider puts the
 * configured name on `ProxyRelay.headerNames`, which the dry run reads beside the plugin's
 * (`credential-source.ts`). One consequence of the three travelling as fields: the echo redaction
 * treats every field value as a secret (`echo.ts`), so a gateway that quotes the header name it
 * missed in a refusal comes back with the name redacted — the price of one shape for every relay's
 * fields, and the wide event still says `relay: gateway` with the gateway's status.
 */

/** The scheme name a gateway connection's row carries and the wide event's `relay` records. */
export const GATEWAY_RELAY_SCHEME = "gateway";

/** The relay's fields, assembled by the gateway provider per call from the deployment's configuration. */
export const GATEWAY_RELAY_FIELDS = {
  /** The gateway's base URL — origin and an optional path, no query. */
  upstreamUrl: "upstreamUrl",
  /** The deployment identity header's name, as the gateway expects it. */
  headerName: "headerName",
  /** Its value — the secret; the one field the echo redaction has to catch. */
  headerValue: "headerValue",
} as const;

/** A gateway fronting the vendor forwards every caller header under its own name and drops nothing. */
export const GATEWAY_RELAY_RULES: RelayHeaderRules = {
  prefix: null,
  passThrough: [],
  refuse: [],
  refusePrefixes: [],
};

/**
 * Under a prefix (`GRAFT_GATEWAY_HEADER_PREFIX`), the request's framing still travels under its own
 * name: a gateway that forwards `x-graft-content-type` to the vendor has forwarded nothing the
 * vendor reads, and the outgoing policy pins `accept-encoding` to `identity` for the byte count the
 * wide event promises.
 */
export const GATEWAY_PREFIX_PASS_THROUGH: readonly string[] = [
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
];

/**
 * The gateway's URL for one vendor request: the upstream's origin and base path, then the vendor's
 * host as one segment, then the vendor's path and query as they resolved. Pure, so the form a
 * gateway has to route is stated — and tested — in one place.
 */
export function gatewayRelayUrl(upstream: URL, vendor: URL): URL {
  const relay = new URL(upstream.origin);
  const base = upstream.pathname.replace(/\/+$/, "");
  relay.pathname = `${base}/${vendor.host}${vendor.pathname}`;
  relay.search = vendor.search;
  return relay;
}

/** A field the relay cannot leave without — the same refusal a signing scheme earns, `credential_incomplete`. */
function required(fields: CredentialFields, name: string): string {
  const value = fields[name];
  if (!value) throw new MissingCredentialFieldError(name);
  return value;
}

export const gatewayRelay: RelayPlugin = {
  kind: "relay",
  scheme: GATEWAY_RELAY_SCHEME,
  rules: GATEWAY_RELAY_RULES,
  relay(target: SchemeTarget, fields: CredentialFields): void {
    const upstreamUrl = required(fields, GATEWAY_RELAY_FIELDS.upstreamUrl);
    const headerName = required(fields, GATEWAY_RELAY_FIELDS.headerName);
    const headerValue = required(fields, GATEWAY_RELAY_FIELDS.headerValue);
    let upstream: URL;
    try {
      upstream = new URL(upstreamUrl);
    } catch {
      throw new MissingCredentialFieldError(GATEWAY_RELAY_FIELDS.upstreamUrl);
    }
    const relay = gatewayRelayUrl(upstream, target.url);
    // After the caller's headers, so a caller header of the same name is overwritten, never kept.
    target.headers.set(headerName, headerValue);
    target.url.href = relay.href;
  },
  // The identity header's name is the deployment's, not the scheme's: `ProxyRelay.headerNames`.
  headerNames: () => [],
};
