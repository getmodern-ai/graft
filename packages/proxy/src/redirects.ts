import { isSafeMethod } from "./dry-run";
import { isPublicHost } from "./public-host";
import type { SchemePlugin } from "./schemes";
import type { ProxyOptions, SchemeConfig, UpstreamResponse } from "./types";

/**
 * Redirects — not followed (CONTEXT.md, *Proxy*). A vendor 3xx goes back to the caller with its
 * `Location`, because following one is the classic way a credential leaves the host it was entered
 * for. `ProxyOptions.followRedirects` is the break glass, and even under it a hop stays inside the
 * connection's host set, on a public address, and is capped. This file is the whole policy — which
 * statuses are redirects, when one may be followed and as what, and what a returned `Location` must
 * lose — so `app.ts` asks one question of each vendor response, `nextHop`, and hands the response
 * back when the answer is null.
 */

/** How many redirects the break-glass flag may follow before the last one is returned. */
export const MAX_REDIRECT_HOPS = 3;

/**
 * One request to the vendor: the first is the caller's, each next one a redirect the policy
 * allowed.
 */
export type Hop = { method: string; url: URL; body: Uint8Array | null };

export function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * The hop a vendor response leads to, or null to hand the response back to the caller. Null unless
 * the status is a redirect, the break-glass flag is on, `hops` is still under the cap and
 * `followable` agrees — so an ordinary call, the default, never gets past the first test.
 */
export function nextHop(
  response: UpstreamResponse,
  hop: Hop,
  hosts: ReadonlySet<string>,
  options: Pick<ProxyOptions, "followRedirects">,
  hops: number,
): Hop | null {
  if (!isRedirect(response.status) || !options.followRedirects || hops >= MAX_REDIRECT_HOPS) {
    return null;
  }
  return followable(response, hop, hosts);
}

/**
 * Whether a redirect may be followed under the break-glass flag, and as what. A hostname in the
 * connection's declared set (ADR 0010: one connection may span a vendor's several hosts, and the
 * set is what the person agreed to), on the same port, not downgraded from https, and a public
 * address — or nothing: a `Location` elsewhere is exactly the exfiltration the proxy refuses to
 * follow. The method changes as a browser's would: 303 becomes GET, 301/302 become GET for
 * anything but GET/HEAD, 307/308 keep the method — and so keep the body, which was already sent
 * once, so those two are followed only when there was no body to resend.
 */
export function followable(
  response: UpstreamResponse,
  hop: Hop,
  hosts: ReadonlySet<string>,
): Hop | null {
  const location = response.headers.get("location");
  if (!location) return null;
  let next: URL;
  try {
    next = new URL(location, hop.url);
  } catch {
    return null;
  }
  if (!hosts.has(next.hostname)) return null;
  if (next.protocol !== hop.url.protocol && next.protocol !== "https:") return null;
  if (next.port !== hop.url.port) return null;
  if (!isPublicHost(next.hostname)) return null;

  const status = response.status;
  if ((status === 307 || status === 308) && hop.body !== null) return null;
  const method =
    status === 303 || ((status === 301 || status === 302) && !isSafeMethod(hop.method))
      ? "GET"
      : hop.method;
  next.hash = "";
  return { method, url: next, body: null };
}

/**
 * A returned redirect loses what the scheme put on the URL — `SchemePlugin.scrubRedirect` has the
 * argument. Resolved against the vendor URL that answered, and written back only when something
 * was removed, so a relative `Location` with nothing of ours in it stays exactly as the vendor
 * sent it.
 */
export function scrubReturnedRedirect(
  headers: Headers,
  from: URL,
  plugin: SchemePlugin,
  config: SchemeConfig,
): void {
  const location = headers.get("location");
  if (!location || !plugin.scrubRedirect) return;
  let url: URL;
  try {
    url = new URL(location, from);
  } catch {
    return;
  }
  const before = url.href;
  plugin.scrubRedirect(url, config);
  if (url.href !== before) headers.set("location", url.href);
}
