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
 * — a company's API gateway (GRA-58), a broker's Connect proxy in the hosted form — connects the
 * vendor its own way and hands the proxy a relay instead of a credential, and nothing above the
 * credential rung changes for it: not the tool, the sandbox, the capability token, the dry run or
 * the host rules.
 *
 * Providers are the fourth seam beside the sandbox, the keyring and the toolbox store (ADR 0002),
 * selected by the same backings mechanism (`apps/server/src/backings.ts`): the open form enables
 * the keyring and, when configured, the gateway; the hosted form's private package answers the
 * rest, in an order, with the keyring always present and last. A hosted provider's code lives
 * beside its configuration in that package (ADR 0002 as amended 2026-09-19; GRA-103) — this
 * repository carries the seam, the keyring and the gateway, and no vendor's.
 *
 * **Coverage is a question the provider answers, and it may have to ask** (GRA-126): a broker's
 * catalogue says which vendors it connects and at which hosts, so `covers` and a link's `target`
 * are async — a provider that answers from configuration resolves at once, one that answers from
 * a catalogue reads it (and caches). `providerFor` awaits each provider in order.
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
   * parameters and its secret fields, from the two tables in `@graft/proxy` — today's form. At
   * least one scheme, because a form is that picker and a picker over nothing connects nothing;
   * `assertCloudBackings` holds a hosted provider to the same (GRA-62).
   */
  | { kind: "form"; schemes: readonly [AuthScheme, ...AuthScheme[]] }
  /**
   * The person opens a link the provider mints and consents there; nothing is typed in the console
   * (GRA-59; the hosted form's broker). The three functions are the link's flow as the server runs it (`apps/server`'s
   * `provider-link.ts`): `target` names the vendor on the provider's side for the card, `start`
   * mints the link the console opens, `complete` confirms what the person connected once the
   * provider sends the browser back. `scheme` is the relay scheme such a connection's row records.
   */
  | ({ kind: "link" } & ProviderLink)
  /**
   * No person step: the deployment holds the identity the upstream wants (GRA-58). `scheme` is the
   * relay scheme every row the provider makes records in the `scheme` column (ADR 0019) — fixed for
   * the provider where the form's is the person's choice — so `registerProviderConnection` writes it
   * without asking the provider to resolve a row that does not exist yet.
   */
  | { kind: "none"; scheme: RelayScheme };

/**
 * What a provider that connects with a link offers beyond the word (ADR 0019; GRA-59). The
 * functions are async and may reach the provider — a connect token minted, an account list read —
 * which is why they sit here, on the server's side of the seam, and not in a rule the console
 * runs; the console reads the `kind` and the ask's payload alone (`describeProviders`).
 */
export type ProviderLink = {
  /** The relay scheme this provider's rows record — a `RELAY_SCHEMES` entry; the generic `relay` for a hosted provider. */
  readonly scheme: RelayScheme;
  /**
   * The provider's own name for the vendor — a broker's app slug — or null when the provider does
   * not cover the vendor at these hosts. What the ask's card shows beside the vendor, and what the
   * link preselects, so `request_connection` records it on the payload at proposal time. Async for
   * the reason `covers` is: the answer may come from the provider's catalogue.
   */
  target(vendor: string, hosts: readonly string[]): Promise<string | null>;
  /**
   * Mint the link the person opens. `returnTo` is where the provider sends the browser afterwards
   * — Graft's return route with its signed state already in the query, one URI for a success and
   * one for the provider's own failure — and `personId` is whose account the link may connect.
   */
  start(input: ProviderLinkStart): Promise<ProviderLinkStarted>;
  /**
   * The browser is back: confirm what the person connected and answer the provider's reference for
   * it — a broker's account id — or why nothing was. `takenRefs` are the references the person's
   * other connections of this provider already hold, so a second account at the same vendor is the
   * new one and never one already claimed. Never trusts the provider's redirect alone: the
   * reference comes from asking the provider what it now holds.
   */
  complete(input: ProviderLinkComplete): Promise<ProviderLinkOutcome>;
};

export type ProviderLinkStart = {
  personId: string;
  vendor: string;
  hosts: readonly string[];
  returnTo: { success: string; error: string };
};

export type ProviderLinkStarted = {
  /** What the console opens in a popup. */
  url: string;
  /** Until when the provider honours the link. */
  expiresAt: Date;
};

export type ProviderLinkComplete = {
  personId: string;
  vendor: string;
  hosts: readonly string[];
  takenRefs: readonly string[];
};

export type ProviderLinkOutcome =
  /** `ref` goes on the row's `provider_ref`; `label` is the account's own name at the provider, for the card. */
  | { ok: true; ref: string; label: string | null }
  /** One sentence for the person; the ask stays open for another try. */
  | { ok: false; message: string };

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
  | { mode: "relay"; relay: ProxyRelay }
  /**
   * The provider holds nothing for this row yet: a link the person opened and did not finish, so
   * there is neither a credential to inject nor an upstream to relay to. The proxy says so, naming
   * the provider (`connection_not_ready`, GRA-68), where a null `inject` scheme would have it name
   * the columns the row happens to lack.
   */
  | { mode: "pending" };

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
  | "revokedAt"
>;

export type ConnectionProvider = {
  /** The name a row's `provider` column carries; kebab-case, and never another provider's. */
  readonly name: string;
  readonly connect: ProviderConnect;
  /**
   * Whether this provider can connect the vendor at these hosts. A proposal is routed to the first
   * provider in the deployment's order that covers it, so a provider that covers everything — the
   * keyring — goes last (`providerFor`). Async because the answer may be the provider's catalogue's
   * (GRA-126); the keyring and the gateway answer from what they hold.
   */
  covers(vendor: string, hosts: readonly string[]): Promise<boolean>;
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
  covers: async () => true,
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
 * at these hosts, each asked in turn and awaited — a later provider is never asked once an earlier
 * one has said yes. Never null in a well-formed deployment, because the keyring covers everything
 * and is last; the throw is for a list assembled some other way.
 */
export async function providerFor(
  providers: readonly ConnectionProvider[],
  vendor: string,
  hosts: readonly string[],
): Promise<ConnectionProvider> {
  for (const provider of providers) {
    if (await provider.covers(vendor, hosts)) return provider;
  }
  throw new Error(`No connection provider covers ${vendor}: the keyring should always be last`);
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

/**
 * How a provider connects, as the wire carries it: the kind, and for the form its schemes. A link's
 * functions and its scheme stay on the server — they are code, and the console reads the ask's
 * payload for the target (`ConnectionProposalPayload.providerTarget` in `@graft/mcp`).
 */
export type ProviderConnectDescription =
  | { kind: "form"; schemes: readonly AuthScheme[] }
  | { kind: "link" }
  | { kind: "none" };

/** A provider as the API describes it to the console: its name and how it connects, nothing else. */
export type ProviderDescription = { name: string; connect: ProviderConnectDescription };

export function describeProviders(providers: readonly ConnectionProvider[]): ProviderDescription[] {
  return providers.map(({ name, connect }) => ({
    name,
    connect:
      connect.kind === "form" ? { kind: "form", schemes: connect.schemes } : { kind: connect.kind },
  }));
}

/** The link half of a provider, when it connects with one — the server's read for the two link routes. */
export function providerLinkOf(provider: ConnectionProvider): ProviderLink | null {
  return provider.connect.kind === "link" ? provider.connect : null;
}
