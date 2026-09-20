import { MissingCredentialFieldError } from "@graft/proxy/scheme-errors";
import type { CredentialFields, RelayPlugin, SchemeTarget } from "@graft/proxy/types";
import { RELAY_SCHEME } from "@graft/proxy/types";

import type {
  ConnectionProvider,
  ProviderConnectionRow,
  ProviderLinkComplete,
  ProviderLinkStart,
  ProviderResolution,
} from "../provider";

/**
 * A **link provider with nothing behind it**, for the open suites (GRA-103). The hosted form's
 * broker — the provider whose page a person signs in on and whose proxy relays every call — lives
 * in the private package (ADR 0002 as amended 2026-09-19; ADR 0019), so the suites here that
 * exercise a link's two ends, the card, the relay rung and the revoke's release drive this fake
 * instead: a `ConnectionProvider` of `connect.kind: "link"` whose rows carry the generic `relay`
 * scheme, whose `start` mints a link on a fake origin and remembers what it was asked for, whose
 * `complete` answers the next account the test connected that no row of the person's claims yet,
 * whose `resolve` hands the proxy a relay plugin rewriting the vendor request into a request to an
 * in-process upstream (the shape `@graft/proxy`'s `relay.test.ts` drives), and whose `revoke`
 * forgets the account. Everything it does is on its records, so a test asserts what a provider was
 * asked without a network.
 *
 * What it deliberately does not know is any vendor's name: coverage is the test's function, the
 * link's target defaults to the vendor slug, and the copy the card and the console draw names the
 * provider by its `name`.
 */

/** An account the fake holds for a person at a vendor — what a link connects and a revoke releases. */
export type FakeLinkAccount = {
  /** What a connection stores as its `provider_ref`. */
  id: string;
  personId: string;
  /** The provider's name for the vendor, as `target` answered it. */
  target: string;
  /** The account's own label at the provider, for the card, or null. */
  label: string | null;
  healthy: boolean;
  createdAt: string;
};

/** A link the fake minted, with what the caller handed over. */
export type FakeLinkMinted = {
  token: string;
  personId: string;
  target: string;
  success: string;
  error: string;
};

/** Thrown by the fake when a test asks it to fail the next call, as a broker refusing or unreachable would. */
export class FakeLinkProviderError extends Error {
  constructor(message = "the fake link provider is down") {
    super(message);
    this.name = "FakeLinkProviderError";
  }
}

export type FakeLinkProvider = ConnectionProvider & {
  readonly accounts: FakeLinkAccount[];
  readonly minted: FakeLinkMinted[];
  readonly deleted: string[];
  /** The upstream every relayed call is rewritten to; the vendor URL rides base64url in its path. */
  readonly upstreamUrl: string;
  /** The person finished the sign-in on the provider's page: the provider now holds an account. */
  connectAccount(args: {
    personId: string;
    target: string;
    id?: string;
    label?: string | null;
    healthy?: boolean;
  }): FakeLinkAccount;
  /** Make the next `start`, `complete`, `revoke` or relay `obtain` fail. */
  failNext(error?: Error): void;
};

export type FakeLinkProviderOptions = {
  /** The name a row's `provider` column carries and the card shows; kebab-case. */
  name?: string;
  /** Which proposals the provider covers — the test's rule. Default: every vendor at any host. */
  covers?: (vendor: string, hosts: readonly string[]) => boolean;
  /** The provider's own name for a covered vendor; default the vendor slug. */
  target?: (vendor: string, hosts: readonly string[]) => string;
  /** Where the fake's sign-in page lives — what `start` answers. */
  linkOrigin?: string;
  /** Where the relay plugin sends a relayed call. */
  upstreamUrl?: string;
  /** The token the plugin authenticates to the upstream with — what the echo redaction must catch. */
  upstreamToken?: string;
  now?: () => Date;
};

/** The header rules the fake's upstream imposes: a prefix, the framing pair through, `user-agent` dropped. */
export const FAKE_RELAY_RULES = {
  prefix: "x-up-",
  passThrough: ["content-type", "accept"],
  refuse: ["user-agent", "cookie", "host"],
  refusePrefixes: ["sec-"],
} as const;

/** The two headers the fake's plugin sets of its own, lower-cased, for the dry run's preview. */
export const FAKE_RELAY_HEADER_NAMES = ["authorization", "x-up-account"] as const;

/**
 * The upstream URL for one vendor request: `<upstream>/relay/<base64url of the vendor URL>` with
 * the account id in the query — the shape `relay.test.ts` drives. Exported so a suite decodes what
 * left the proxy with the same rule the plugin wrote it under.
 */
export function fakeRelayUrl(
  vendorUrl: URL,
  fields: { upstreamUrl: string; accountId: string },
): URL {
  const relay = new URL(
    `${fields.upstreamUrl.replace(/\/+$/, "")}/relay/${Buffer.from(vendorUrl.href, "utf8").toString("base64url")}`,
  );
  relay.searchParams.set("account", fields.accountId);
  return relay;
}

/** The vendor URL a relayed request's path segment carries, or null for a segment that is not one. */
export function decodeFakeRelaySegment(segment: string): URL | null {
  try {
    return new URL(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function field(fields: CredentialFields, name: string): string {
  const value = fields[name];
  if (value === undefined || value === "") throw new MissingCredentialFieldError(name);
  return value;
}

/** The fake's relay plugin: named for the generic scheme, since that is what its rows carry. */
export const fakeRelayPlugin: RelayPlugin = {
  kind: "relay",
  scheme: RELAY_SCHEME,
  rules: FAKE_RELAY_RULES,
  relay(target: SchemeTarget, fields: CredentialFields) {
    const upstreamUrl = field(fields, "upstreamUrl");
    const token = field(fields, "token");
    const accountId = field(fields, "accountId");
    const relay = fakeRelayUrl(target.url, { upstreamUrl, accountId });
    target.headers.set("authorization", `Bearer ${token}`);
    target.headers.set("x-up-account", accountId);
    target.url.href = relay.href;
  },
  headerNames: () => [...FAKE_RELAY_HEADER_NAMES],
};

export function createFakeLinkProvider(options: FakeLinkProviderOptions = {}): FakeLinkProvider {
  const name = options.name ?? "fake-broker";
  const covers = options.covers ?? (() => true);
  const targetOf = options.target ?? ((vendor: string) => vendor.trim().toLowerCase());
  const linkOrigin = (options.linkOrigin ?? `https://${name}.fake`).replace(/\/+$/, "");
  const upstreamUrl = (options.upstreamUrl ?? `https://${name}.fake/proxy`).replace(/\/+$/, "");
  const upstreamToken = options.upstreamToken ?? `${name}-upstream-token`;
  const now = options.now ?? (() => new Date());
  const accounts: FakeLinkAccount[] = [];
  const minted: FakeLinkMinted[] = [];
  const deleted: string[] = [];
  let counter = 0;
  let failure: Error | null = null;
  const fail = () => {
    if (!failure) return;
    const error = failure;
    failure = null;
    throw error;
  };

  /** Nothing the proxy can use; it reads the null scheme as `connection_not_ready`. */
  const notReady: ProviderResolution = {
    mode: "inject",
    scheme: null,
    schemeConfig: {},
    credentialCiphertext: null,
  };

  const provider: FakeLinkProvider = {
    name,
    accounts,
    minted,
    deleted,
    upstreamUrl,
    connectAccount(args) {
      const account: FakeLinkAccount = {
        id: args.id ?? `acct_${name}_${++counter}`,
        personId: args.personId,
        target: args.target,
        label: args.label ?? null,
        healthy: args.healthy ?? true,
        createdAt: now().toISOString(),
      };
      accounts.push(account);
      return account;
    },
    failNext(error) {
      failure = error ?? new FakeLinkProviderError();
    },
    connect: {
      kind: "link",
      scheme: RELAY_SCHEME,
      target: async (vendor, hosts) => (covers(vendor, hosts) ? targetOf(vendor, hosts) : null),
      async start(input: ProviderLinkStart) {
        fail();
        if (!covers(input.vendor, input.hosts)) {
          throw new Error(`The ${name} provider does not cover ${input.vendor} at these hosts`);
        }
        const token = `ltok_${(++counter).toString(16).padStart(8, "0")}`;
        const target = targetOf(input.vendor, input.hosts);
        minted.push({
          token,
          personId: input.personId,
          target,
          success: input.returnTo.success,
          error: input.returnTo.error,
        });
        const url = new URL(`${linkOrigin}/link`);
        url.searchParams.set("token", token);
        url.searchParams.set("app", target);
        return { url: url.toString(), expiresAt: new Date(now().getTime() + 15 * 60_000) };
      },
      async complete(input: ProviderLinkComplete) {
        fail();
        if (!covers(input.vendor, input.hosts)) {
          return { ok: false, message: `${name} does not cover ${input.vendor} at these hosts.` };
        }
        // Never the redirect's word for it: the account is whatever the provider now holds for
        // this person at this target that no connection of theirs already names.
        const target = targetOf(input.vendor, input.hosts);
        const taken = new Set(input.takenRefs);
        const account = accounts
          .filter(
            (candidate) =>
              candidate.personId === input.personId &&
              candidate.target === target &&
              candidate.healthy &&
              !taken.has(candidate.id),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!account) {
          return {
            ok: false,
            message: `No new ${input.vendor} account was connected at ${name} — the sign-in may have been closed or refused. Connect again from the ask.`,
          };
        }
        return { ok: true, ref: account.id, label: account.label };
      },
    },
    covers: async (vendor, hosts) => covers(vendor, hosts),
    resolve(row: ProviderConnectionRow) {
      if (row.revokedAt) return notReady;
      if (!row.providerRef) return { mode: "pending" };
      const accountId = row.providerRef;
      return {
        mode: "relay",
        relay: {
          plugin: fakeRelayPlugin,
          obtain: async () => {
            fail();
            return { upstreamUrl, token: upstreamToken, accountId };
          },
        },
      };
    },
    async revoke(row) {
      fail();
      if (!row.providerRef) return;
      const index = accounts.findIndex((account) => account.id === row.providerRef);
      if (index === -1)
        throw new FakeLinkProviderError(`${name} holds no account ${row.providerRef}`);
      accounts.splice(index, 1);
      deleted.push(row.providerRef);
    },
  };
  return provider;
}
