import {
  CONNECT_TOKEN_TTL_SECONDS,
  connectLinkUrlFor,
  type PipedreamAccount,
  type PipedreamClient,
  type PipedreamEnvironment,
  PipedreamError,
} from "./client";

/**
 * The client over in-memory maps — what a suite that calls the provider binds, so the provider's
 * rules (which account is claimed, what a revoke releases, what the relay is handed) are asserted
 * without a network. `connect()` plays the person completing the link: it adds an account under
 * the external user id and app, as Pipedream would once the vendor's consent lands. Every call is
 * recorded so a test can assert that `include_credentials` was never asked for — there is no such
 * method here to call.
 */

export type FakePipedreamClient = PipedreamClient & {
  accounts: PipedreamAccount[];
  /** Every connect token minted, with the redirect URIs the caller handed over. */
  tokens: { token: string; externalUserId: string; app: string; success: string; error: string }[];
  deleted: string[];
  /** The person connected an account: the vendor's consent landed at Pipedream. */
  connect(args: {
    externalUserId: string;
    app: string;
    id?: string;
    name?: string | null;
    healthy?: boolean;
  }): PipedreamAccount;
  /** Make the next call fail as Pipedream refusing or unreachable. */
  failNext(error?: PipedreamError): void;
};

export function createFakePipedreamClient(
  options: {
    projectId?: string;
    environment?: PipedreamEnvironment;
    apiOrigin?: string;
    accessToken?: string;
    now?: () => Date;
  } = {},
): FakePipedreamClient {
  const projectId = options.projectId ?? "proj_fake";
  const environment = options.environment ?? "development";
  const apiOrigin = options.apiOrigin ?? "https://pipedream.fake";
  const accessToken = options.accessToken ?? "fake-connect-access-token";
  const now = options.now ?? (() => new Date());
  let counter = 0;
  let failure: PipedreamError | null = null;
  const fail = () => {
    if (!failure) return;
    const error = failure;
    failure = null;
    throw error;
  };

  const client: FakePipedreamClient = {
    apiOrigin,
    projectId,
    environment,
    accounts: [],
    tokens: [],
    deleted: [],
    connect(args) {
      const at = now().toISOString();
      const account: PipedreamAccount = {
        id: args.id ?? `apn_fake_${++counter}`,
        name: args.name ?? null,
        externalUserId: args.externalUserId,
        healthy: args.healthy ?? true,
        dead: false,
        app: { name: args.app, slug: args.app },
        createdAt: at,
        updatedAt: at,
      };
      client.accounts.push(account);
      return account;
    },
    failNext(error) {
      failure = error ?? new PipedreamError("Pipedream is down (fake)", 503);
    },
    async createConnectToken(args) {
      fail();
      const token = `ctok_${(++counter).toString(16).padStart(32, "0")}`;
      client.tokens.push({
        token,
        externalUserId: args.externalUserId,
        app: args.app,
        success: args.successRedirectUri,
        error: args.errorRedirectUri,
      });
      return {
        token,
        connectLinkUrl: connectLinkUrlFor(
          `${apiOrigin}/_static/connect.html?token=${token}&connectLink=true`,
          args.app,
        ),
        expiresAt: new Date(now().getTime() + CONNECT_TOKEN_TTL_SECONDS * 1000).toISOString(),
      };
    },
    async listAccounts(args) {
      fail();
      return client.accounts.filter(
        (account) =>
          account.externalUserId === args.externalUserId && account.app.slug === args.app,
      );
    },
    async relayFields(args) {
      fail();
      return {
        accessToken,
        projectId,
        environment,
        externalUserId: args.externalUserId,
        accountId: args.accountId,
        apiOrigin,
      };
    },
    async deleteAccount(accountId) {
      fail();
      const index = client.accounts.findIndex((account) => account.id === accountId);
      if (index === -1) throw new PipedreamError("Pipedream DELETE account answered 404", 404);
      client.accounts.splice(index, 1);
      client.deleted.push(accountId);
    },
  };
  return client;
}
