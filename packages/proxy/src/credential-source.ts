import { deriveRefusal, fromHost, type Refused, refuse } from "./failure";
import { relayHeaders, relayRulesOf } from "./relay";
import { CredentialRefreshError, type SchemePlugin } from "./schemes";
import type {
  AuthScheme,
  CredentialFields,
  ProxyConnection,
  ProxyDeps,
  RelayHeaderRules,
  RelayPlugin,
  SchemeConfig,
  SchemeRuntime,
  UpstreamFetch,
} from "./types";

/**
 * Where a call's credential comes from, kept out of the ladder so `app.ts` reads the same whatever
 * the scheme. Two sources, one shape (ADR 0019). **Inject**: the connection carries its scheme, its
 * host set and its envelope-encrypted credential on the row, and the host's vault decrypts — the
 * keyring, every row until another provider is enabled. **Relay**: the connection's provider holds
 * the credential at an upstream proxy, and what the ladder obtains is the fields that address that
 * upstream; the request is rewritten to go there instead of to the vendor (`relay.ts`). Cando's
 * broker branch was deleted on the way in (ADR 0011) and this is what came back in its place —
 * narrower, because it relays and never fetches a raw credential. Then, for an injected credential,
 * **stored** against **derived**: what the row holds is what goes on the wire, unless the scheme
 * derives something from it first — the access token an OAuth2 exchange buys, the JWT the Snowflake
 * scheme signs — cached per connection in `SchemeRuntime.cache` and made again on a vendor 401
 * (`schemes.ts`). A relay derives nothing: the upstream owns the vendor's token and its refresh.
 */

/**
 * What the ladder needs of a connection once it has decided the row is usable. `obtain` is the
 * late, expensive step — a decrypt — and `unavailable` the refusal its failure earns.
 */
export type CredentialSource = {
  kind: "source";
  mode: "inject";
  authScheme: AuthScheme;
  primaryHost: string;
  /** The declared hostnames, lower-case, the primary's among them — see `hostSetOf`. */
  hosts: ReadonlySet<string>;
  schemeConfig: SchemeConfig;
  obtain: () => Promise<CredentialFields>;
  unavailable: (error: unknown, requestBytes: number) => Refused;
};

/**
 * The relay's counterpart: the plugin and the rules one call runs under, the vendor host set — the
 * relay still declares where the request is *for*, and the ladder judges that host, not the
 * upstream's — and `obtain` for the fields that address the upstream, held to the host boundary
 * (`fromHost`) since the function is the host's.
 */
export type RelaySource = {
  kind: "source";
  mode: "relay";
  plugin: RelayPlugin;
  rules: RelayHeaderRules;
  /** The headers this connection's relay sets beyond the plugin's own (`ProxyRelay.headerNames`). */
  headerNames: readonly string[];
  /** The relay leg's own way out, when the provider brought one (`ProxyRelay.upstreamFetch`). */
  upstreamFetch: UpstreamFetch | null;
  primaryHost: string;
  hosts: ReadonlySet<string>;
  obtain: () => Promise<CredentialFields>;
  unavailable: (error: unknown, requestBytes: number) => Refused;
};

export type CallSource = CredentialSource | RelaySource;

export function credentialSource(
  connection: ProxyConnection,
  deps: Pick<ProxyDeps, "decryptCredential">,
): CallSource | Refused {
  // The person's revoke, before anything else of the row (GRA-68): a revoked row keeps its scheme
  // and its hosts and lacks a credential or a reference, and a refusal read off those columns would
  // send the agent to repair the wrong thing. The host resolves such a row to no scheme, no
  // ciphertext and no relay as well (`toProxyConnection`), so a connection that does not say it is
  // revoked is still refused below, only less precisely.
  if (connection.revokedAt) {
    return refuse(
      409,
      "connection_revoked",
      "The person revoked this connection; ask them to reconnect it in the console",
    );
  }
  const relay = connection.relay;
  if (relay) {
    if (!connection.primaryHost) {
      return refuse(409, "connection_not_ready", "The connection has no primary host");
    }
    return {
      kind: "source",
      mode: "relay",
      plugin: relay.plugin,
      rules: relayRulesOf(relay.plugin, relay.rules),
      headerNames: relay.headerNames ?? [],
      upstreamFetch: relay.upstreamFetch ?? null,
      primaryHost: connection.primaryHost,
      hosts: hostSetOf(connection),
      obtain: () => fromHost("relay.obtain", relay.obtain),
      unavailable: (error, requestBytes) =>
        refuse(
          502,
          "relay_unavailable",
          "The upstream proxy the connection relays through could not be addressed",
          {
            requestBytes,
            failure: error,
          },
        ),
    };
  }
  // A provider that holds the credential elsewhere and nothing for this row yet: the link the person
  // opened never completed. Named, because the row has its scheme and its primary host and the check
  // below would say otherwise (GRA-68).
  if (connection.pendingProvider) {
    return refuse(
      409,
      "connection_not_ready",
      `The ${connection.pendingProvider} provider holds no account for this connection yet; the person has not finished connecting it`,
    );
  }
  if (!connection.authScheme || !connection.primaryHost) {
    return refuse(409, "connection_not_ready", "The connection has no scheme or primary host");
  }
  const ciphertext = connection.credentialCiphertext;
  // `none` stores no credential and its plugin reads none (GRA-66); every other scheme's row is not
  // ready until the person has entered one.
  if (!ciphertext && connection.authScheme !== "none") {
    return refuse(409, "connection_not_ready", "The connection has no credential yet");
  }
  return {
    kind: "source",
    mode: "inject",
    authScheme: connection.authScheme,
    primaryHost: connection.primaryHost,
    hosts: hostSetOf(connection),
    schemeConfig: connection.schemeConfig ?? {},
    obtain: ciphertext
      ? () =>
          deps.decryptCredential(ciphertext, {
            personId: connection.personId,
            connectionId: connection.id,
          })
      : async () => ({}),
    unavailable: (error, requestBytes) =>
      refuse(500, "credential_unreadable", "The stored credential could not be decrypted", {
        requestBytes,
        failure: error,
      }),
  };
}

/**
 * A relay as the vendor leg sees it — the `SchemePlugin` shape `forward` already runs, so the loop
 * over hops, the 401 retry, the redirect policy and the echo redaction are one code path for both
 * modes. `apply` is the relay: the caller's headers under the rules, then the plugin's own rewrite
 * of URL and authentication. No `derive` — the upstream owns the vendor token and its refresh, so a
 * vendor 401 passes through as the vendor's answer — and no `scrubRedirect`, because the relay puts
 * nothing on the *vendor's* URL for a `Location` to carry back. `headerNames` is the plugin's for
 * every connection plus this connection's own (a gateway's configured identity header), which is
 * what a dry run previews without assembling the fields.
 */
export function relaySchemePlugin(source: RelaySource): SchemePlugin {
  return {
    apply(target, fields) {
      relayHeaders(target.headers, source.rules);
      source.plugin.relay(target, fields, source.rules);
    },
    headerNames: () => [...source.plugin.headerNames(), ...source.headerNames],
  };
}

/**
 * The hosts a connection may reach, as the proxy compares them: every declared hostname, trimmed
 * and lower-cased, plus the primary's own — the row is expected to list it (ADR 0010, "a
 * connection declares the set of hosts it may reach"), and adding it here means a row that did not
 * still follows a redirect back to the host it was entered for. A primary that is not a URL adds
 * nothing; `resolveTarget` in `app.ts` refuses it.
 */
export function hostSetOf(
  connection: Pick<ProxyConnection, "primaryHost" | "hosts">,
): ReadonlySet<string> {
  const hosts = new Set(connection.hosts.map((host) => host.trim().toLowerCase()));
  const primary = connection.primaryHost === null ? null : tryUrl(connection.primaryHost);
  if (primary) hosts.add(primary.hostname);
  return hosts;
}

/** `new URL` as a value or null, for the two places a row's URL text is read. */
export function tryUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * The credential as it goes on the wire, or the refusal deriving it earned — or, third, the stored
 * credential sent **stale**: an authorization-code token the scheme could not refresh, sent as it is
 * so the vendor's own answer reaches the caller, with why the refresh failed for the host to record
 * (ADR 0005; `schemes.ts`, `CredentialRefreshError`).
 */
export type WireCredential =
  | { kind: "wire"; credential: CredentialFields }
  | { kind: "stale"; credential: CredentialFields; reason: string; upstreamStatus: number | null }
  | Refused;

/**
 * The wire credential: what the row holds, or what the scheme derives from it. A scheme with no
 * `derive` sends what it holds. One with a `derive` is handed the cache through `runtime` and
 * answers from it while the entry lives; `refresh: true` is the 401 retry, where the plugin must
 * not answer from the cache because the vendor just refused what the cache held (`schemes.ts` has
 * the contract). A failed derive is the refusal `deriveRefusal` names — except a refresh the vendor
 * refused, which is not a refusal at all but the stored credential going out stale; anything else it
 * throws is the proxy's own bug and propagates.
 */
export async function wireCredential(
  plugin: SchemePlugin,
  credential: CredentialFields,
  config: SchemeConfig,
  runtime: SchemeRuntime,
  options: { refresh: boolean },
  requestBytes: number,
): Promise<WireCredential> {
  if (!plugin.derive) return { kind: "wire", credential };
  try {
    return { kind: "wire", credential: await plugin.derive(credential, config, runtime, options) };
  } catch (error) {
    if (error instanceof CredentialRefreshError && error.reason === "refresh_failed") {
      return {
        kind: "stale",
        credential,
        reason: error.message,
        upstreamStatus: error.upstreamStatus,
      };
    }
    return deriveRefusal(error, requestBytes);
  }
}
