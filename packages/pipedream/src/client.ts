import type { CredentialFields } from "@graft/proxy/types";

/**
 * The Pipedream Connect client (GRA-59; the README says why it is hand-rolled and why it lives
 * here). Four calls and a token cache, against the endpoints Pipedream documents under
 * https://pipedream.com/docs/connect/api-reference/. What it never does is read a credential:
 * `include_credentials` is set on no call, because a connected account is only ever *relayed*
 * through Pipedream's proxy (ADR 0019, "relay everything for a brokered provider").
 */

export type PipedreamEnvironment = "development" | "production";

export type PipedreamConfig = {
  /** The Connect project, `proj_…` — the environment's accounts live under it. */
  projectId: string;
  /** `development` or `production`: which of the project's two account stores every call addresses. */
  environment: PipedreamEnvironment;
  /** The project's OAuth client, which buys the access token every call carries. */
  clientId: string;
  clientSecret: string;
  /** The Connect API's origin; the real one unless a test or a laptop points at a fake. */
  apiOrigin?: string;
};

export const PIPEDREAM_API_ORIGIN = "https://api.pipedream.com";

/**
 * Refresh this far before the hour is up — flight time, the same minute Cando's client and the
 * proxy's OAuth2 scheme allow: a token fetched at T+3599 is valid when it is read and expired by the
 * time the relayed request lands.
 */
export const TOKEN_SKEW_MS = 60_000;

/**
 * How long a connect token is asked to live. Pipedream's default is four hours; the link is opened
 * by a person who is at the console already, and the signed state the return carries lives fifteen
 * minutes (`@graft/core`'s `link-state.ts`), so the token is held to the same window — a link that
 * outlived its state would connect an account no return could claim.
 */
export const CONNECT_TOKEN_TTL_SECONDS = 15 * 60;

/** A connected account as Pipedream lists it — the fields Graft reads and no credential. */
export type PipedreamAccount = {
  /** `apn_…`, what a connection stores as its `provider_ref`. */
  id: string;
  /** The account's own label at Pipedream — the signed-in address for Gmail — or null. */
  name: string | null;
  externalUserId: string;
  healthy: boolean;
  dead: boolean;
  app: { name: string; slug: string };
  createdAt: string;
  updatedAt: string;
};

export type ConnectToken = {
  token: string;
  /** Pipedream's hosted page, with the app preselected — what the console opens. */
  connectLinkUrl: string;
  expiresAt: string;
};

/**
 * What the proxy's relay needs to address Pipedream's Connect proxy (`@graft/proxy`'s
 * `pipedream-relay.ts`, `PIPEDREAM_RELAY_FIELDS`): Graft's access token, the project and
 * environment, the two ids that name the account, and the API origin so a fake is relayed to as a
 * fake. Nothing here is the person's.
 */
export type PipedreamRelayFields = CredentialFields & {
  accessToken: string;
  projectId: string;
  environment: PipedreamEnvironment;
  externalUserId: string;
  accountId: string;
  apiOrigin: string;
};

/**
 * Pipedream answered outside 2xx, or could not be reached. `status` is theirs; the message never
 * carries their body — a rejected client-credentials exchange echoes the client id, and the message
 * reaches logs and, by class name, the revoke's answer.
 */
export class PipedreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PipedreamError";
  }
}

export type PipedreamClient = {
  /**
   * A short-lived token for one person to connect one account through Connect Link
   * (https://pipedream.com/docs/connect/api-reference/create-connect-token). `externalUserId` is the
   * tenancy boundary: the token can connect an account under that user and no other. The two
   * redirect URIs are where Pipedream sends the browser afterwards — Graft's return route with its
   * signed state already in the query.
   */
  createConnectToken(args: {
    externalUserId: string;
    app: string;
    successRedirectUri: string;
    errorRedirectUri: string;
  }): Promise<ConnectToken>;
  /**
   * The accounts Pipedream holds for one person under one app
   * (https://pipedream.com/docs/connect/api-reference/list-accounts). Never with credentials.
   */
  listAccounts(args: { externalUserId: string; app: string }): Promise<PipedreamAccount[]>;
  /** What a relayed call needs; a network call only when the cached access token has expired. */
  relayFields(args: { externalUserId: string; accountId: string }): Promise<PipedreamRelayFields>;
  /** Forget the account at Pipedream (https://pipedream.com/docs/connect/api-reference/delete-account). */
  deleteAccount(accountId: string): Promise<void>;
  /** The origin every call addresses — what the relay's fields carry. */
  readonly apiOrigin: string;
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The Connect Link URL with the app preselected — Pipedream's page otherwise shows a picker. */
export function connectLinkUrlFor(connectLinkUrl: string, app: string): string {
  const url = new URL(connectLinkUrl);
  url.searchParams.set("app", app);
  return url.toString();
}

export function createPipedreamClient(
  config: PipedreamConfig,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): PipedreamClient {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const apiOrigin = (config.apiOrigin ?? PIPEDREAM_API_ORIGIN).replace(/\/+$/, "");
  const project = encodeURIComponent(config.projectId);

  /**
   * One access token for the process, shared across every person: it authenticates *Graft* to
   * Pipedream and carries no user identity — the person is chosen per call by `external_user_id`.
   * Nothing user-scoped may ever be cached here. `pending` is the single flight: a burst after a
   * cold start buys one token, not one per caller.
   */
  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchAccessToken(): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(`${apiOrigin}/v1/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
      });
    } catch (error) {
      throw new PipedreamError("Pipedream's token endpoint could not be reached", null, {
        cause: error,
      });
    }
    if (!response.ok) {
      // Never the body: a refused client-credentials exchange echoes the client id back.
      throw new PipedreamError(
        `Pipedream refused Graft's client credentials (${response.status})`,
        response.status,
      );
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new PipedreamError("Pipedream's token endpoint answered without an access token", 200);
    }
    const lifetimeMs =
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
        ? body.expires_in * 1000
        : 3600_000;
    cached = { token: body.access_token, expiresAtMs: now() + lifetimeMs - TOKEN_SKEW_MS };
    return body.access_token;
  }

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAtMs > now()) return cached.token;
    if (pending) return pending;
    pending = fetchAccessToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${apiOrigin}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const token = await accessToken();
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-pd-environment": config.environment,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new PipedreamError(`Pipedream could not be reached for ${method} ${path}`, null, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new PipedreamError(
        `Pipedream ${method} ${path} answered ${response.status}`,
        response.status,
      );
    }
    // 204 on delete; `.json()` would throw on an empty body.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    apiOrigin,
    projectId: config.projectId,
    environment: config.environment,

    async createConnectToken(args) {
      const body = await request<{
        token?: unknown;
        connect_link_url?: unknown;
        expires_at?: unknown;
      }>("POST", `/v1/connect/${project}/tokens`, {
        body: {
          external_user_id: args.externalUserId,
          success_redirect_uri: args.successRedirectUri,
          error_redirect_uri: args.errorRedirectUri,
          expires_in: CONNECT_TOKEN_TTL_SECONDS,
        },
      });
      if (typeof body.token !== "string" || typeof body.connect_link_url !== "string") {
        throw new PipedreamError(
          "Pipedream answered a connect token without a token or a link",
          200,
        );
      }
      return {
        token: body.token,
        connectLinkUrl: connectLinkUrlFor(body.connect_link_url, args.app),
        expiresAt: typeof body.expires_at === "string" ? body.expires_at : "",
      };
    },

    async listAccounts(args) {
      const body = await request<{ data?: unknown }>("GET", `/v1/connect/${project}/accounts`, {
        query: { external_user_id: args.externalUserId, app: args.app },
      });
      if (!Array.isArray(body.data)) return [];
      return body.data.flatMap((entry) => {
        const account = readAccount(entry);
        return account ? [account] : [];
      });
    },

    async relayFields(args) {
      return {
        accessToken: await accessToken(),
        projectId: config.projectId,
        environment: config.environment,
        externalUserId: args.externalUserId,
        accountId: args.accountId,
        apiOrigin,
      };
    },

    async deleteAccount(accountId) {
      await request<void>(
        "DELETE",
        `/v1/connect/${project}/accounts/${encodeURIComponent(accountId)}`,
      );
    },
  };
}

/** An account as Pipedream lists it, reduced to what Graft reads; null for a shape it does not know. */
function readAccount(entry: unknown): PipedreamAccount | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const app = (typeof raw.app === "object" && raw.app !== null ? raw.app : {}) as Record<
    string,
    unknown
  >;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null,
    externalUserId: typeof raw.external_id === "string" ? raw.external_id : "",
    healthy: raw.healthy !== false,
    dead: raw.dead === true,
    app: {
      name: typeof app.name === "string" ? app.name : "",
      slug: typeof app.name_slug === "string" ? app.name_slug : "",
    },
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}
