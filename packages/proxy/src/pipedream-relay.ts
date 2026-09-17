import { MissingCredentialFieldError } from "./scheme-errors";
import type { CredentialFields, RelayHeaderRules, RelayPlugin, SchemeTarget } from "./types";

/**
 * **Relay through Pipedream's Connect API proxy** — the first `RELAY_SCHEMES` entry (ADR 0019;
 * GRA-59), ported from Cando's `pipedream_connect_proxy` (its CAN-563 to CAN-567) with the header
 * discipline taken out into `relay.ts`'s rule table. Pipedream's proxy takes the vendor URL as a
 * URL-safe base64 path segment, the account and the end user as query parameters, and injects the
 * OAuth token it holds for that account before calling the vendor
 * (https://pipedream.com/docs/connect/api-proxy/: "`POST https://api.pipedream.com/v1/connect/
 * {project_id}/proxy/{url_safe_base64_encoded_url}`", with `external_user_id` and `account_id`
 * required in the query, `Authorization: Bearer {access_token}` and `x-pd-environment` required as
 * headers). So this plugin presents nothing to the vendor: it rewrites the request the ladder
 * resolved into the request Pipedream takes, and the vendor sees Pipedream's request with the
 * person's token on it. Graft never sees that token — the whole point of the relay.
 *
 * The fields come from the provider's `obtain` (`@graft/core`'s `pipedream-provider.ts`, which asks
 * `@graft/pipedream`'s client): Graft's own Connect access token, the project and environment the
 * account lives in, and the two ids that name it. None is the person's, and none is persisted here.
 * `apiOrigin` is the one optional field: the client's configured Connect API origin, so a test or a
 * laptop pointed at a fake Pipedream relays to the fake; absent, the real one.
 */

export const PIPEDREAM_CONNECT_PROXY_SCHEME = "pipedream_connect_proxy";

/** Where a relayed request goes instead of the vendor, unless the fields name another origin. */
export const PIPEDREAM_API_ORIGIN = "https://api.pipedream.com";

/** Pipedream forwards a caller's header to the vendor only under this prefix (their proxy docs). */
export const PIPEDREAM_RELAY_HEADER_PREFIX = "x-pd-proxy-";

/**
 * The header rules Pipedream's proxy imposes, as `relay.ts` applies them. `passThrough`: the framing
 * pair describes the body and answer *we* send Pipedream and is forwarded as itself. `refuse`: the
 * documented restricted list (https://pipedream.com/docs/connect/api-proxy/ — Accept-Encoding,
 * Access-Control-Request-*, Connection, Content-Length, Cookie, Date, DNT, Expect, Host, Keep-Alive,
 * Origin, Permissions-Policy, Referer, TE, Trailer, Transfer-Encoding, Upgrade, Via, and the
 * `Proxy-` and `Sec-` families) plus `user-agent`, which the list does not name and the proxy refuses
 * all the same — Cando measured it on 2026-09-15 (prefixed `user-agent` → `400 Unsupported header`)
 * after its first relayed production call failed on it (CAN-566). Most are already gone by the time
 * a relay runs (`headers.ts` strips framing, hop-by-hop and edge headers); `user-agent` and the
 * `sec-*` family were the two that were not. Dropped rather than prefixed: the vendor loses nothing
 * it needed.
 */
export const PIPEDREAM_RELAY_RULES: RelayHeaderRules = {
  prefix: PIPEDREAM_RELAY_HEADER_PREFIX,
  passThrough: ["content-type", "accept"],
  refuse: [
    "user-agent",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "permissions-policy",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ],
  refusePrefixes: ["sec-", "proxy-"],
};

/** The fields `relay` cannot run without, in the order a reader would fix them. */
export const PIPEDREAM_RELAY_FIELDS = [
  "accessToken",
  "projectId",
  "environment",
  "externalUserId",
  "accountId",
] as const;

/** The one optional field: the Connect API origin, for a fake; the real one when absent. */
export const PIPEDREAM_RELAY_ORIGIN_FIELD = "apiOrigin";

function field(fields: CredentialFields, name: string): string {
  const value = fields[name];
  if (value === undefined || value === "") throw new MissingCredentialFieldError(name);
  return value;
}

/**
 * The URL Pipedream's proxy takes for one vendor request: the vendor URL — host, path and query,
 * exactly as the ladder resolved it — URL-safe-base64'd into the path, the two ids in the query.
 * Exported so the fake Pipedream in a test and the plugin agree on the encoding.
 */
export function pipedreamProxyUrl(
  vendorUrl: URL,
  fields: { apiOrigin: string; projectId: string; externalUserId: string; accountId: string },
): URL {
  const relay = new URL(
    `${fields.apiOrigin.replace(/\/+$/, "")}/v1/connect/${encodeURIComponent(fields.projectId)}/proxy/${Buffer.from(vendorUrl.href, "utf8").toString("base64url")}`,
  );
  relay.searchParams.set("external_user_id", fields.externalUserId);
  relay.searchParams.set("account_id", fields.accountId);
  return relay;
}

/** The vendor URL a proxy path segment carries — the fake's read of what the plugin wrote. */
export function decodePipedreamProxySegment(segment: string): URL | null {
  try {
    return new URL(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The plugin. `relay.ts` has already rewritten the caller's headers under `PIPEDREAM_RELAY_RULES`
 * when this runs (`credential-source.ts`'s `relaySchemePlugin`), so what is left here is the
 * rewrite of the URL and the two headers that authenticate *Graft* to Pipedream — set after the
 * caller's, so a caller header cannot collide with them.
 */
export const pipedreamConnectProxyRelay: RelayPlugin = {
  kind: "relay",
  scheme: PIPEDREAM_CONNECT_PROXY_SCHEME,
  rules: PIPEDREAM_RELAY_RULES,
  relay(target: SchemeTarget, fields: CredentialFields) {
    const accessToken = field(fields, "accessToken");
    const projectId = field(fields, "projectId");
    const environment = field(fields, "environment");
    const externalUserId = field(fields, "externalUserId");
    const accountId = field(fields, "accountId");
    const apiOrigin = fields[PIPEDREAM_RELAY_ORIGIN_FIELD] || PIPEDREAM_API_ORIGIN;

    const relay = pipedreamProxyUrl(target.url, {
      apiOrigin,
      projectId,
      externalUserId,
      accountId,
    });
    target.headers.set("authorization", `Bearer ${accessToken}`);
    target.headers.set("x-pd-environment", environment);
    target.url.href = relay.href;
  },
  // Both go to Pipedream, not the vendor; a dry run's preview names them because they are what a
  // request that left would carry, and the vendor receives an `authorization` header either way.
  headerNames: () => ["authorization", "x-pd-environment"],
};
