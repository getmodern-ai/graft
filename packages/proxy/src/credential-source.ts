import { deriveRefusal, type Refused, refuse } from "./failure";
import type { SchemePlugin } from "./schemes";
import type {
  AuthScheme,
  CredentialFields,
  ProxyConnection,
  ProxyDeps,
  SchemeConfig,
  SchemeRuntime,
} from "./types";

/**
 * Where a call's credential comes from, kept out of the ladder so `app.ts` reads the same whatever
 * the scheme. A connection carries its scheme, its host set and its envelope-encrypted credential
 * on the row, and the host's vault decrypts — Graft holds every credential itself, so there is one
 * source and no broker (ADR 0001; Cando's second branch was deleted on the way in, ADR 0011). Then,
 * **stored** against **derived**: what the row holds is what goes on the wire, unless the scheme
 * derives something from it first — the access token an OAuth2 exchange buys, the JWT the Snowflake
 * scheme signs — cached per connection in `SchemeRuntime.cache` and made again on a vendor 401
 * (`schemes.ts`).
 */

/**
 * What the ladder needs of a connection once it has decided the row is usable. `obtain` is the
 * late, expensive step — a decrypt — and `unavailable` the refusal its failure earns.
 */
export type CredentialSource = {
  kind: "source";
  authScheme: AuthScheme;
  primaryHost: string;
  /** The declared hostnames, lower-case, the primary's among them — see `hostSetOf`. */
  hosts: ReadonlySet<string>;
  schemeConfig: SchemeConfig;
  obtain: () => Promise<CredentialFields>;
  unavailable: (error: unknown, requestBytes: number) => Refused;
};

export function credentialSource(
  connection: ProxyConnection,
  deps: Pick<ProxyDeps, "decryptCredential">,
): CredentialSource | Refused {
  if (!connection.authScheme || !connection.primaryHost) {
    return refuse(409, "connection_not_ready", "The connection has no scheme or primary host");
  }
  const ciphertext = connection.credentialCiphertext;
  if (!ciphertext) {
    return refuse(409, "connection_not_ready", "The connection has no credential yet");
  }
  return {
    kind: "source",
    authScheme: connection.authScheme,
    primaryHost: connection.primaryHost,
    hosts: hostSetOf(connection),
    schemeConfig: connection.schemeConfig ?? {},
    obtain: () =>
      deps.decryptCredential(ciphertext, {
        personId: connection.personId,
        connectionId: connection.id,
      }),
    unavailable: (error, requestBytes) =>
      refuse(500, "credential_unreadable", "The stored credential could not be decrypted", {
        requestBytes,
        failure: error,
      }),
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

/** The credential as it goes on the wire, or the refusal deriving it earned. */
export type WireCredential = { kind: "wire"; credential: CredentialFields } | Refused;

/**
 * The wire credential: what the row holds, or what the scheme derives from it. A scheme with no
 * `derive` sends what it holds. One with a `derive` is handed the cache through `runtime` and
 * answers from it while the entry lives; `refresh: true` is the 401 retry, where the plugin must
 * not answer from the cache because the vendor just refused what the cache held (`schemes.ts` has
 * the contract). A failed derive is the refusal `deriveRefusal` names; anything else it throws is
 * the proxy's own bug and propagates.
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
    return deriveRefusal(error, requestBytes);
  }
}
