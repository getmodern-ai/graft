import type { PipedreamAccount, PipedreamClient } from "@graft/pipedream";
import { externalUserIdFor } from "@graft/pipedream";
import { PIPEDREAM_CONNECT_PROXY_SCHEME } from "@graft/proxy/pipedream-relay";
import { RELAYS } from "@graft/proxy/relay";

import type { ConnectionProvider, ProviderConnectionRow, ProviderResolution } from "./provider";

/**
 * The **Pipedream provider** (ADR 0019; GRA-59): a vendor Pipedream's Connect catalogue offers
 * connects with one click — the person opens Pipedream's Connect Link, signs in at the vendor
 * there, and comes back — and every call for the connection relays through Pipedream's Connect
 * proxy, which holds the vendor's token (`@graft/proxy`'s `pipedream-relay.ts`). Graft stores
 * exactly one fact about such a connection, the Pipedream account id, on the row's `provider_ref`;
 * the vendor's token is never read, cached or stored here (the project's decision, "relay
 * everything"). The code is open and the configuration is hosted: the client this provider is
 * handed is built from `GRAFT_PIPEDREAM_*` (`apps/server/src/backings.ts`), and the provider is on
 * the list only when the group is set.
 *
 * **The vendor table is the one thing here that grows.** `PIPEDREAM_APPS` maps a Graft vendor slug
 * and the hosts its calls go to onto Pipedream's app slug. It is deliberately not a catalogue
 * (ADR 0001, and the project's "nothing first-party per vendor"): Pipedream's catalogue is the
 * source, and an entry here says only which Graft vendor is one of their apps and which hosts a
 * relayed call for it may address. `covers` demands every proposed host be in the entry's set,
 * because the relay injects the account's token into whatever vendor URL it is handed — a proposal
 * naming a host outside the vendor's own would have Pipedream send that token there. Adding a
 * vendor is one row and Pipedream's app slug, which their catalogue lists (`gmail`, `slack_v2`, …).
 */

export const PIPEDREAM_PROVIDER = "pipedream";

export type PipedreamApp = {
  /** The Graft vendor slug an agent proposes and a tool binds to (CONTEXT.md, *Authored tool*). */
  vendor: string;
  /** Pipedream's own slug for the app — their catalogue's `name_slug`, what `?app=` on the link takes. */
  app: string;
  /** Every host a relayed call for this vendor may address, lower-case; a proposal outside it is not covered. */
  hosts: readonly string[];
};

export const PIPEDREAM_APPS: readonly PipedreamApp[] = [
  {
    vendor: "gmail",
    app: "gmail",
    hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  },
];

/** The entry for a vendor at these hosts, or null when no entry covers it. */
export function pipedreamAppFor(
  vendor: string,
  hosts: readonly string[],
  apps: readonly PipedreamApp[] = PIPEDREAM_APPS,
): PipedreamApp | null {
  const entry = apps.find((app) => app.vendor === vendor.trim().toLowerCase());
  if (!entry) return null;
  const allowed = new Set(entry.hosts.map((host) => host.toLowerCase()));
  const covered = hosts.every((host) =>
    allowed.has(host.trim().toLowerCase().replace(/:\d+$/, "")),
  );
  return covered ? entry : null;
}

/** The account the person just connected: the newest healthy one under the app that no row holds yet. */
export function newestUnclaimedAccount(
  accounts: readonly PipedreamAccount[],
  takenRefs: readonly string[],
): PipedreamAccount | null {
  const taken = new Set(takenRefs);
  const candidates = accounts
    .filter((account) => !taken.has(account.id) && !account.dead && account.healthy)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return candidates[0] ?? null;
}

export type PipedreamProviderDeps = {
  client: PipedreamClient;
  /** The vendor table; the default is `PIPEDREAM_APPS`, a test hands its own. */
  apps?: readonly PipedreamApp[];
};

export function createPipedreamProvider(deps: PipedreamProviderDeps): ConnectionProvider {
  const apps = deps.apps ?? PIPEDREAM_APPS;
  const { client } = deps;

  /** Nothing the proxy can use; it reads the null scheme as `connection_not_ready`. */
  const notReady: ProviderResolution = {
    mode: "inject",
    scheme: null,
    schemeConfig: {},
    credentialCiphertext: null,
  };

  return {
    name: PIPEDREAM_PROVIDER,
    connect: {
      kind: "link",
      scheme: PIPEDREAM_CONNECT_PROXY_SCHEME,
      target: (vendor, hosts) => pipedreamAppFor(vendor, hosts, apps)?.app ?? null,
      async start(input) {
        const entry = pipedreamAppFor(input.vendor, input.hosts, apps);
        if (!entry) {
          throw new Error(`The pipedream provider does not cover ${input.vendor} at these hosts`);
        }
        const token = await client.createConnectToken({
          externalUserId: externalUserIdFor(input.personId),
          app: entry.app,
          successRedirectUri: input.returnTo.success,
          errorRedirectUri: input.returnTo.error,
        });
        return { url: token.connectLinkUrl, expiresAt: new Date(token.expiresAt) };
      },
      async complete(input) {
        const entry = pipedreamAppFor(input.vendor, input.hosts, apps);
        if (!entry) {
          return { ok: false, message: `Pipedream does not cover ${input.vendor} at these hosts.` };
        }
        // Never the redirect's word for it: the account is whatever Pipedream now holds for this
        // person under this app that no connection of theirs already names.
        const accounts = await client.listAccounts({
          externalUserId: externalUserIdFor(input.personId),
          app: entry.app,
        });
        const account = newestUnclaimedAccount(accounts, input.takenRefs);
        if (!account) {
          return {
            ok: false,
            message: `No new ${input.vendor} account was connected at Pipedream — the sign-in may have been closed or refused. Connect again from the ask.`,
          };
        }
        return { ok: true, ref: account.id, label: account.name };
      },
    },
    covers: (vendor, hosts) => pipedreamAppFor(vendor, hosts, apps) !== null,
    resolve: (row: ProviderConnectionRow) => {
      // A revoked row may still carry its reference while Pipedream's release is outstanding
      // (`connection.service.ts`, `releaseFromProvider`); it is not one a call may go through.
      // `toProxyConnection` reads the revoke first and never asks; this is the provider's own guard.
      if (row.revokedAt) return notReady;
      // No account yet: the link never completed. The proxy names this provider as the one that
      // holds nothing for the row (GRA-68), where a null scheme would have it name the columns.
      if (!row.providerRef) return { mode: "pending" };
      const externalUserId = externalUserIdFor(row.personId);
      const accountId = row.providerRef;
      return {
        mode: "relay",
        relay: {
          plugin: RELAYS[PIPEDREAM_CONNECT_PROXY_SCHEME],
          // Late and per call, as the seam asks: Graft's access token comes from the client's cache
          // and is bought again only when it has expired; nothing about the account is fetched.
          obtain: () => client.relayFields({ externalUserId, accountId }),
        },
      };
    },
    /**
     * Forget the account at Pipedream too — its API offers the delete
     * (https://pipedream.com/docs/connect/api-reference/delete-account), so the vendor token
     * Pipedream held for this connection goes with the row's reference. Handed the row as it was
     * before the revoke, since the revoke has already cleared `provider_ref`; a failure is the
     * service's to report (`ProviderRelease`), and revoking again is the retry.
     */
    async revoke(row) {
      if (!row.providerRef) return;
      await client.deleteAccount(row.providerRef);
    },
  };
}
