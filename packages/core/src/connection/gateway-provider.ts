import {
  GATEWAY_PREFIX_PASS_THROUGH,
  GATEWAY_RELAY_FIELDS,
  GATEWAY_RELAY_SCHEME,
  gatewayRelay,
} from "@graft/proxy/gateway-relay";
import type { ProxyRelay, UpstreamFetch } from "@graft/proxy/types";

import type { ConnectionProvider } from "./provider";

/**
 * The **gateway** provider (ADR 0019, GRA-58): a company runs Graft against its own API gateway,
 * which fronts the vendors it covers and holds their credentials. The operator configures it once,
 * at deployment (`GRAFT_GATEWAY_*` in `@graft/env`): which vendor hosts it covers, where it answers,
 * and the one header the deployment identifies itself with. From then on a vendor whose hosts are
 * all covered connects with **no person step** — `request_connection` makes the row and answers
 * `connected` — and every call for it relays through the gateway with that header attached, the
 * vendor's URL carried in the path (`@graft/proxy`'s `gateway-relay.ts`), the dry run still
 * stopping writes at Graft's proxy. A vendor the gateway does not cover falls to the keyring.
 *
 * The provider holds nothing per connection: the row carries the provider's name and the `gateway`
 * scheme, no credential, and a null `provider_ref` — the route is the deployment's configuration,
 * and a row that recorded the upstream would go stale the day the operator moved the gateway. So
 * `revoke` releases nothing, and `resolve` hands the proxy the same three fields for every row.
 *
 * **Browser-safe**, like `provider.ts`: the console reads `GATEWAY_PROVIDER` to name the card, so
 * this file imports the proxy's import-free plugin and types and nothing that reaches a socket.
 */

/** The name a gateway connection's `provider` column carries. */
export const GATEWAY_PROVIDER = "gateway";

/** The deployment's gateway, as `@graft/env` validated it (`GRAFT_GATEWAY_*`). */
export type GatewayProviderConfig = {
  /**
   * The vendor hosts the gateway covers, lower-case: an exact hostname (`api.vendor.example`) or a
   * wildcard suffix (`*.googleapis.com`, matching any host at least one label under it and never
   * the suffix itself). A proposal is covered when *every* host it declares matches one of these.
   */
  hosts: readonly string[];
  /** The gateway's base URL — origin and an optional path, no query. */
  upstreamUrl: string;
  /** The deployment identity header the gateway authenticates: its name and its secret value. */
  headerName: string;
  headerValue: string;
  /**
   * The prefix the gateway wants on caller headers, or null when it forwards them under their own
   * names (the default; ADR 0019's header rules as data).
   */
  headerPrefix?: string | null;
  /**
   * How the relay leg reaches the gateway: the host binds `@graft/proxy`'s `createUpstreamFetch`
   * with the gateway's hostname exempt from the address guard, since a company gateway commonly
   * sits on a private network (`apps/server/src/backings.ts`). On the relay alone — the proxy's own
   * fetch keeps the full guard for every vendor host, the gateway's name included. Absent, the relay
   * goes out the proxy's way, fully guarded; a test with an injected fetch needs none.
   */
  upstreamFetch?: UpstreamFetch;
};

/** Whether one vendor host matches one covered-host pattern, both lower-case. */
export function gatewayCoversHost(pattern: string, host: string): boolean {
  const candidate = host.trim().toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return candidate.length > suffix.length && candidate.endsWith(suffix);
  }
  return candidate === rule;
}

/**
 * Whether the gateway covers a proposal: every host in it matches a pattern, and there is at least
 * one host. All rather than any, because a connection's calls may go to every host it declares
 * (ADR 0010), and a gateway that fronts only some of them would relay the rest into a route it has
 * no credential for.
 */
export function gatewayCovers(patterns: readonly string[], hosts: readonly string[]): boolean {
  if (hosts.length === 0) return false;
  return hosts.every((host) => patterns.some((pattern) => gatewayCoversHost(pattern, host)));
}

export function createGatewayProvider(config: GatewayProviderConfig): ConnectionProvider {
  const patterns = config.hosts.map((host) => host.trim().toLowerCase());
  const headerName = config.headerName.trim();
  const prefix = config.headerPrefix ?? null;
  // Assembled once: the same for every row, never persisted by the proxy (ADR 0019).
  const fields = {
    [GATEWAY_RELAY_FIELDS.upstreamUrl]: config.upstreamUrl,
    [GATEWAY_RELAY_FIELDS.headerName]: headerName,
    [GATEWAY_RELAY_FIELDS.headerValue]: config.headerValue,
  };
  const relay: ProxyRelay = {
    plugin: gatewayRelay,
    obtain: async () => fields,
    // The identity header, named for the dry run's preview; the plugin knows it only as a field.
    headerNames: [headerName.toLowerCase()],
    ...(prefix === null ? {} : { rules: { prefix, passThrough: GATEWAY_PREFIX_PASS_THROUGH } }),
    ...(config.upstreamFetch ? { upstreamFetch: config.upstreamFetch } : {}),
  };
  return {
    name: GATEWAY_PROVIDER,
    connect: { kind: "none", scheme: GATEWAY_RELAY_SCHEME },
    covers: async (_vendor, hosts) => gatewayCovers(patterns, hosts),
    resolve: () => ({ mode: "relay", relay }),
    revoke: async () => undefined,
  };
}
