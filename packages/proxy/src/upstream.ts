import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { hasCauseNamed } from "./cause-chain";
import { isPublicAddress } from "./public-host";
import type { UpstreamFetch } from "./types";

/**
 * The default way out — "refuses private, link-local and cloud-metadata ranges at registration
 * and at resolution" (GRA-1, "The proxy and the capability token"), done where the address is
 * actually chosen.
 *
 * A hostname is judged twice. Its *text* is judged by `isPublicHost` before the fetch (an IP
 * literal, `localhost`, an `.internal` name). What it *resolves to* can only be judged by the code
 * about to open the socket, so the check lives inside the resolver the connector calls: the
 * address checked is the address connected to, with no window between the two for a DNS answer
 * to change. A resolver that answers with even one private address refuses the whole lookup — an
 * attacker who controls a name cannot smuggle `169.254.169.254` in among public addresses.
 *
 * TLS is unaffected: undici still passes the hostname as `servername`, so certificate validation
 * is against the vendor's name while the socket goes to the address this resolver vouched for.
 *
 * One exemption, by exact hostname (`unguardedHosts`): an upstream the *operator* configured in the
 * environment — a company's API gateway a relay leg goes to (ADR 0019, GRA-58), which commonly sits
 * on a private network. The guard exists because a vendor host is *proposed* by an agent's model
 * and could be pointed at the metadata service; a URL the operator set beside the database URL
 * carries the operator's own trust, and refusing it would make every private gateway unusable.
 * A fetch built with the exemption is the **relay leg's own** (`ProxyRelay.upstreamFetch`), never
 * the proxy's shared one: a vendor host may spell the gateway's name — a keyring connection an
 * agent proposed at `gateway.corp.example` passes the literal check — and must still be judged on
 * the address it resolves to. One thing the guard cannot see for either leg: an IP literal, which
 * Node connects to without resolving — the vendor's is refused by the ladder's literal check, and
 * a relay URL's is the operator's to write.
 */

/** The vendor name resolved to an address a credential must not be sent to. */
export class PrivateAddressError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly address: string,
  ) {
    super(`${hostname} resolves to ${address}, which is not a public address`);
    this.name = "PrivateAddressError";
  }
}

/** The subset of `dns.lookup` this needs — injectable so the guard is testable without DNS. */
export type ResolveAll = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const defaultResolveAll: ResolveAll = (hostname, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, callback);
};

/**
 * The `lookup` `net.connect` and `tls.connect` accept. Node passes `all: true` when it is going to
 * race address families itself (the default since Node 20) and expects an array back; otherwise it
 * expects one address and its family. Both are honoured.
 */
export function guardedLookup(
  resolveAll: ResolveAll = defaultResolveAll,
  unguardedHosts: readonly string[] = [],
): LookupFunction {
  const unguarded = new Set(unguardedHosts.map((host) => host.trim().toLowerCase()));
  return (hostname, options, callback) => {
    resolveAll(hostname, (error, addresses) => {
      if (error) return callback(error, []);
      // `isPublicAddress` and not `isPublicHost`: what a resolver answers with is an address, so
      // anything else here is an error rather than a name to judge as one — and the name form
      // would wave a hostname-shaped answer through as public (GRA-176).
      const offender = unguarded.has(hostname.toLowerCase())
        ? undefined
        : addresses.find((entry) => !isPublicAddress(entry.address));
      if (offender) return callback(new PrivateAddressError(hostname, offender.address), []);
      const first = addresses[0];
      if (!first) return callback(new PrivateAddressError(hostname, "(no address)"), []);
      if (options.all) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}

export type UpstreamFetchOptions = {
  /** The DNS the guard reads; a test scripts one. */
  resolveAll?: ResolveAll;
  /**
   * Hostnames the address guard does not apply to — the operator-configured upstream a relay leg
   * goes to. Only ever set on a fetch a provider hands the proxy for its relay (`ProxyRelay.
   * upstreamFetch`); the header of this file says why the shared fetch takes none. Exact, lower-case.
   */
  unguardedHosts?: readonly string[];
};

/**
 * undici's fetch over an `Agent` whose connector resolves through `guardedLookup`. undici's own
 * fetch rather than the global one, with a plain init rather than a `Request` instance, because
 * the two are different copies of the same library and a `Request` from one is an opaque object
 * to the other. `redirect: "manual"` always — the proxy decides about redirects, never the fetch.
 */
export function createUpstreamFetch(options: UpstreamFetchOptions = {}): UpstreamFetch {
  const agent = new Agent({
    connect: { lookup: guardedLookup(options.resolveAll, options.unguardedHosts) },
  });

  return async (request, { signal }) => {
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body,
      dispatcher: agent,
      signal,
      redirect: "manual",
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers([...response.headers]),
      body: response.body as ReadableStream<Uint8Array> | null,
    };
  };
}

/** Whether a failure anywhere in a `cause` chain is the resolver's refusal. */
export function isPrivateAddressFailure(error: unknown): boolean {
  return hasCauseNamed(error, ["PrivateAddressError"]);
}

/** Whether a failure anywhere in a `cause` chain is the abort the proxy's own timeout raised. */
export function isTimeoutFailure(error: unknown): boolean {
  return hasCauseNamed(error, ["TimeoutError", "AbortError"]);
}
