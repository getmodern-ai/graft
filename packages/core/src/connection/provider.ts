import type { ConnectionRow } from "@graft/db/repo/connection";
import {
  AUTH_SCHEMES,
  type AuthScheme,
  isAuthScheme,
  type ProxyRelay,
  type RelayScheme,
  type SchemeConfig,
} from "@graft/proxy/types";

/**
 * A connection comes from a **provider** (ADR 0019): the seam that decides two things Graft used to
 * hard-wire — how the person connects the vendor, and what happens to a vendor request at call
 * time. The keyring provider below is today's behaviour, whole: a secret entered in the console,
 * held in the vault, injected by the proxy under the scheme the connection names. A relay provider
 * — a company's API gateway (GRA-58), Pipedream's Connect proxy (GRA-59) — connects the vendor its
 * own way and hands the proxy a relay instead of a credential, and nothing above the credential
 * rung changes for it: not the tool, the sandbox, the capability token, the dry run or the host
 * rules.
 *
 * Providers are the fourth seam beside the sandbox, the keyring and the toolbox store (ADR 0002),
 * selected by the same backings mechanism (`apps/server/src/backings.ts`): the open form enables
 * the keyring alone, and the hosted form may enable more, in an order, with the keyring always
 * present and last. A provider's *code* is open — every plugin lives in this repository — while its
 * *configuration* may be hosted, which is what "hidden by absence" means for a provider.
 *
 * **Browser-safe on purpose**, like `connection.rules.ts`: the console reads a provider's `connect`
 * shape to decide what a card shows, so this file imports the proxy's import-free `types.ts` and
 * type-only names, and nothing that reaches `node:crypto` or drizzle. `apps/web`'s `vite build` is
 * what fails if that stops being true.
 */

/** The provider every deployment has, and the one every existing row belongs to. */
export const KEYRING_PROVIDER = "keyring";

/**
 * How a person connects a vendor through the provider — what the console's cards and the
 * `request_connection` meta-tool read to decide what to show and what to answer (ADR 0006: the
 * handoff carries everything that is not secret, and this says what the person then does).
 */
export type ProviderConnect =
  /**
   * The person enters a secret in the console: the scheme picker over `schemes`, the scheme's
   * parameters and its secret fields, from the two tables in `@graft/proxy` — today's form.
   */
  | { kind: "form"; schemes: readonly AuthScheme[] }
  /** The person opens a link the provider mints and consents there; nothing is typed in the console (GRA-59). */
  | { kind: "link" }
  /**
   * No person step: the deployment holds the identity the upstream wants (GRA-58). `scheme` is the
   * relay scheme every row the provider makes records in the `scheme` column (ADR 0019) — fixed for
   * the provider where the form's is the person's choice — so `registerProviderConnection` writes it
   * without asking the provider to resolve a row that does not exist yet.
   */
  | { kind: "none"; scheme: RelayScheme };

/**
 * What the proxy needs to make a call through a connection of this provider — the two modes
 * ADR 0019 names. `inject`: the row's credential, decrypted by the proxy's binding and attached by
 * the scheme plugin; the provider hands over the columns and never the plaintext. `relay`: no
 * credential here at all — the call is rewritten into a request to the upstream proxy the relay
 * addresses, which holds it.
 */
export type ProviderResolution =
  | {
      mode: "inject";
      scheme: AuthScheme | null;
      schemeConfig: SchemeConfig;
      credentialCiphertext: Uint8Array | null;
    }
  | { mode: "relay"; relay: ProxyRelay };

/**
 * The columns a provider reads off a row. The ciphertext is among them because the keyring provider
 * hands it on to the proxy — as bytes it cannot read; the vault's decrypt is the proxy binding's
 * alone (`apps/server/src/app.ts`).
 */
export type ProviderConnectionRow = Pick<
  ConnectionRow,
  | "id"
  | "personId"
  | "vendor"
  | "scheme"
  | "schemeConfig"
  | "primaryHost"
  | "hosts"
  | "credentialCiphertext"
  | "provider"
  | "providerRef"
>;

export type ConnectionProvider = {
  /** The name a row's `provider` column carries; kebab-case, and never another provider's. */
  readonly name: string;
  readonly connect: ProviderConnect;
  /**
   * Whether this provider can connect the vendor at these hosts. A proposal is routed to the first
   * provider in the deployment's order that covers it, so a provider that covers everything — the
   * keyring — goes last (`providerFor`).
   */
  covers(vendor: string, hosts: readonly string[]): boolean;
  /**
   * What the proxy needs at call time for one of this provider's connections. Synchronous and
   * cheap: it runs inside the proxy's connection read, before the token is compared against the
   * row. Anything late or expensive — a broker token to mint — goes behind `ProxyRelay.obtain`,
   * which the proxy calls only once the request is about to leave.
   */
  resolve(row: ProviderConnectionRow): ProviderResolution;
  /**
   * The connection was revoked: release whatever the provider holds for it — a broker's account,
   * a gateway's registration. Runs after the row is revoked and the approvals swept, outside that
   * transaction; the revoke stands whatever this does.
   */
  revoke(row: ProviderConnectionRow): Promise<void>;
};

/**
 * Today's behaviour as a provider. It covers every vendor, connects through the console's form over
 * every scheme the proxy signs with, resolves to the row's own columns for the proxy to decrypt and
 * inject, and holds nothing outside the row to release on revoke.
 */
export const keyringProvider: ConnectionProvider = {
  name: KEYRING_PROVIDER,
  connect: { kind: "form", schemes: AUTH_SCHEMES },
  covers: () => true,
  resolve: (row) => ({
    mode: "inject",
    // A row carrying a relay scheme's name is not one the keyring can sign for; the proxy reads a
    // null scheme as `connection_not_ready` rather than guessing.
    scheme: isAuthScheme(row.scheme) ? row.scheme : null,
    schemeConfig: row.schemeConfig,
    credentialCiphertext: row.credentialCiphertext,
  }),
  revoke: async () => undefined,
};

/** The deployment's providers when nothing has been selected: the keyring alone. */
export const DEFAULT_PROVIDERS: readonly ConnectionProvider[] = [keyringProvider];

/** The provider a row names, or null when the deployment has not enabled it. */
export function providerNamed(
  providers: readonly ConnectionProvider[],
  name: string,
): ConnectionProvider | null {
  return providers.find((provider) => provider.name === name) ?? null;
}

/**
 * The provider a proposal is routed to: the first in the deployment's order that covers the vendor
 * at these hosts. Never null in a well-formed deployment, because the keyring covers everything and
 * is last; the throw is for a list assembled some other way.
 */
export function providerFor(
  providers: readonly ConnectionProvider[],
  vendor: string,
  hosts: readonly string[],
): ConnectionProvider {
  const found = providers.find((provider) => provider.covers(vendor, hosts));
  if (!found) {
    throw new Error(`No connection provider covers ${vendor}: the keyring should always be last`);
  }
  return found;
}

/**
 * What the deployment's provider list must be to be one: every name distinct, and the keyring
 * present and last. Returns the problem as a sentence, or null. The selector applies it at boot so
 * a hosted package that answered a provider named `keyring`, or forgot to leave the keyring last,
 * refuses the start rather than shadowing today's behaviour.
 */
export function providerListProblem(providers: readonly ConnectionProvider[]): string | null {
  const names = providers.map((provider) => provider.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) return `two connection providers are named ${duplicate}`;
  const last = providers[providers.length - 1];
  if (!last || last.name !== KEYRING_PROVIDER) {
    return `the ${KEYRING_PROVIDER} provider must be present and last; got [${names.join(", ")}]`;
  }
  return null;
}

/** A provider as the API describes it to the console: its name and how it connects, nothing else. */
export type ProviderDescription = { name: string; connect: ProviderConnect };

export function describeProviders(providers: readonly ConnectionProvider[]): ProviderDescription[] {
  return providers.map(({ name, connect }) => ({ name, connect }));
}
