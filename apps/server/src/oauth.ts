import {
  answerPendingAction,
  type ConnectionDeps,
  completeOAuthConsent,
  isOAuthAuthorizationCode,
  type OAuthCallbackOutcome,
  oauthCallbackRedirect,
  oauthRedirectUri,
  type PendingActionDeps,
  type Principal,
  readOAuthState,
  requirePerson,
  type ServiceContext,
  ServiceError,
  type StartedOAuthConsent,
  startOAuthConsent,
  verifyOAuthState,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import {
  type HandoffConfig,
  notifyAgentsReachingConnection,
  type ToolListChangedNotifier,
} from "@graft/mcp";
import {
  clientAuthOf,
  createUpstreamFetch,
  DerivedCredentialError,
  requestToken,
  tokenEndpointOf,
  tokenExpiresAt,
  type UpstreamFetch,
} from "@graft/proxy";
import type { CredentialVault } from "@graft/vault";
import { Hono } from "hono";

/**
 * The consent's two HTTP ends (ADR 0005). `GET /api/oauth/redirect-uri` tells the console the one
 * URI the person pastes into the client they register — computed here from `GRAFT_AUTH_URL` with the
 * same function the callback is mounted under, so the form cannot show a URI the server does not
 * serve. `GET /api/oauth/callback` is where every vendor sends the browser back, **with no session**:
 * the browser arrives from the vendor, possibly in a popup whose cookies a strict vendor redirect
 * has dropped, so the signed state is the whole authority — it names the connection, the person and
 * the ask, under `GRAFT_HANDOFF_SECRET`. The callback verifies it, reads the PKCE verifier the
 * consent's start wrote, **decrypts the client secret**, exchanges the code at the connection's
 * token URL through the proxy's own guarded fetch, writes the tokens beside the secret as one
 * encrypted record (`completeOAuthConsent`), records `{ connectionId }` on the ask so the waiting
 * `request_connection` says connected exactly as GRA-28's key-shaped path does, and **redirects the
 * browser to the console's `/oauth/callback` route** under `GRAFT_CONSOLE_URL` with the outcome in
 * the query. That route — `apps/web/src/routes/oauth.callback.tsx` — is what the person sees and
 * what tells the waiting console (`postMessage` to the opener, the `OAUTH_CONSENT_CHANNEL`
 * announcement); this server renders no page of its own, so the popup ends on a screen drawn with
 * the console's design system (ADR 0017) rather than a stylesheet of this file's (GRA-48). The
 * redirect URI the person registers with the vendor is unchanged: this route is still where every
 * vendor sends the browser, and the console route is where this route sends it on.
 *
 * **This is the second place in `apps/server` a stored credential becomes plaintext.** The first is
 * the proxy binding in `app.ts`, for the vendor call; this one is for the code exchange, which needs
 * the client secret and cannot go through the proxy — the vendor's token endpoint is not a
 * connection host and the exchange is not a tool's call. Both live in this app and nowhere else;
 * `@graft/core` still takes the vault's encrypt half only. A token never reaches the browser: the
 * redirect's query carries the connection id, a status word and one sentence — never the vendor's
 * code, the state or anything the token endpoint answered (`oauthCallbackRedirect` in `@graft/core`
 * is the one writer, and the console's `readOAuthCallbackSearch` the one reader).
 */

export type OAuthOptions = {
  /** `GRAFT_AUTH_URL` — the redirect URI is `oauthRedirectUri(authUrl)`, on the server's own origin. */
  authUrl: string;
  /** The vault's decrypt half — the callback reads the client secret to exchange the code with. */
  decrypt: CredentialVault["decrypt"];
  /** The exchange's way out; the proxy's guarded fetch by default, a test's fake otherwise. */
  upstreamFetch?: UpstreamFetch;
  /** One deadline for the exchange. */
  timeoutMs?: number;
};

export const DEFAULT_OAUTH_EXCHANGE_TIMEOUT_MS = 30_000;

/** What the routes are handed: the API's deps and handoff, plus the OAuth options. */
export type OAuthRouteOptions = {
  db: DbOrTx;
  connection: ConnectionDeps;
  pendingAction: PendingActionDeps;
  getSession: (headers: Headers) => Promise<Parameters<typeof requirePerson>[0]>;
  handoff: Pick<HandoffConfig, "consoleUrl" | "secret">;
  oauth: OAuthOptions;
  /**
   * The process's `tools/list_changed` notifier: the callback announces the row to every session
   * whose scope reaches it when the consent it completes is the row's **reconnection** — the row
   * was revoked and `completeOAuthConsent` clears `revoked_at` with the record — as `api.ts`'s
   * connection routes and `provider-link.ts` announce theirs (`@graft/mcp`'s `connected.ts`). A
   * first consent announces nothing: the row entered every reaching list when the submit made it,
   * and the submit told those sessions then; the tokens change no list.
   */
  notifier?: Pick<ToolListChangedNotifier, "changed">;
};

/**
 * Start a consent for a connection the person owns — what the three connection-writing routes call
 * after the client secret is stored (`api.ts`), and what Reconnect calls on its own. The redirect
 * URI and the signing secret come from the environment through the options, so every authorize URL
 * this server builds names the callback it serves.
 */
export function beginConsent(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  pendingActionId: string | null,
  options: Pick<OAuthRouteOptions, "connection" | "handoff" | "oauth">,
): Promise<StartedOAuthConsent> {
  return startOAuthConsent(
    ctx,
    principal,
    connectionId,
    {
      redirectUri: oauthRedirectUri(options.oauth.authUrl),
      secret: options.handoff.secret,
      pendingActionId,
    },
    options.connection,
  );
}

export function createOAuthRoutes(options: OAuthRouteOptions): Hono {
  const routes = new Hono();
  const ctx: ServiceContext = { db: options.db };
  const upstream = options.oauth.upstreamFetch ?? createUpstreamFetch();
  const timeoutMs = options.oauth.timeoutMs ?? DEFAULT_OAUTH_EXCHANGE_TIMEOUT_MS;
  const redirectUri = oauthRedirectUri(options.oauth.authUrl);

  /** The one value the person pastes into the vendor's client registration (ADR 0005). */
  routes.get("/redirect-uri", async (c) => {
    requirePerson(await options.getSession(c.req.raw.headers));
    return c.json({ redirectUri });
  });

  /**
   * Where the vendor sends the browser back. Every answer — the success and each refusal — is the
   * same redirect to the console's callback route, with the outcome and one sentence for the person
   * in its query; a person is reading it, so a refusal says what to do next, and none carries a
   * token, the code or the vendor's body. One redirect status for every outcome, because the
   * browser follows it whatever it says and the console route is what the person sees; the
   * distinction a 400 or a 410 would have drawn is the `status` word and the sentence beside it.
   */
  routes.get("/callback", async (c) => {
    const query = c.req.query();
    const land = (outcome: OAuthCallbackOutcome) =>
      c.redirect(oauthCallbackRedirect(options.handoff.consoleUrl, outcome), 302);
    const failed = (message: string, connectionId: string | null = null) =>
      land({ status: "failed", connectionId, message });

    const verdict = verifyOAuthState(
      query.state,
      options.handoff.secret,
      options.pendingAction.now(),
    );
    if (!verdict.ok) return failed(verdict.message);
    const { connectionId, personId, pendingActionId } = verdict.payload;
    const principal: Principal = { personId };

    const row = await options.connection.findConnection(options.db, personId, connectionId);
    if (!row) return failed("The connection this consent was for no longer exists.");
    if (!isOAuthAuthorizationCode(row.scheme)) {
      return failed(`${row.displayName} is not an OAuth connection.`, row.id);
    }

    // The vendor's own refusal: the person declined, or the client is misconfigured at the vendor.
    // The ask stays open — the person may decline it in the console, or try again.
    if (typeof query.error === "string" && query.error.length > 0) {
      const declined = query.error === "access_denied";
      return land({
        status: declined ? "declined" : "failed",
        connectionId: row.id,
        message: declined
          ? `You declined to connect ${row.displayName} — nothing was stored.`
          : `The vendor refused to start the consent for ${row.displayName} (${sanitiseErrorCode(query.error)}). Check the client id, the redirect URI and the scopes at the vendor, then connect again from the console.`,
      });
    }

    const state = readOAuthState(row.oauthRefreshState);
    if (!state.pkce) {
      return failed(
        `No consent is in progress for ${row.displayName} — start it again from the console.`,
        row.id,
      );
    }
    const code = query.code;
    if (typeof code !== "string" || code.length === 0) {
      return failed("The vendor sent the browser back without a code.", row.id);
    }
    if (!row.credentialCiphertext) {
      return failed(
        `${row.displayName} has no client secret — enter it in the console before connecting.`,
        row.id,
      );
    }

    let stored: Readonly<Record<string, string>>;
    try {
      stored = await options.oauth.decrypt(row.credentialCiphertext, {
        personId,
        connectionId: row.id,
      });
    } catch {
      return failed("The stored client secret could not be read.", row.id);
    }
    const clientSecret = stored.clientSecret;
    const clientId = row.schemeConfig.clientId;
    if (!clientSecret || !clientId) {
      return failed(`${row.displayName} is missing its client id or secret.`, row.id);
    }

    let token: Awaited<ReturnType<typeof requestToken>>;
    try {
      token = await requestToken(
        {
          endpoint: tokenEndpointOf(row.schemeConfig.tokenUrl),
          clientId,
          clientSecret,
          clientAuth: clientAuthOf(row.schemeConfig, "body"),
          grant: {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: state.pkce.verifier,
          },
        },
        upstream,
        AbortSignal.timeout(timeoutMs),
      );
    } catch (error) {
      // The exchange's own words and never the endpoint's body, which echoes the client id.
      const detail =
        error instanceof DerivedCredentialError ? error.message : "the exchange failed";
      return failed(
        `The vendor did not hand over a token for ${row.displayName}: ${detail}. Connect again from the console.`,
        row.id,
      );
    }

    const now = options.pendingAction.now();
    const expiresAt = tokenExpiresAt(token, now.getTime());
    const record: Record<string, string> = {
      clientSecret,
      accessToken: token.accessToken,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };

    // Whether this consent brings a revoked row back (the options' note on `notifier`) is decided
    // from the row **locked, inside the transaction** (`findConnectionForUpdate`, the lock a revoke
    // takes first): read from the unlocked `row` above, a revoke committing between that read and
    // the write would be cleared by the write with nobody told (Greptile on #88). The flag comes
    // out of the transaction for the announcement after the commit.
    const completed = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const locked = await options.connection.findConnectionForUpdate(tx, personId, row.id);
      if (!locked) return null;
      const reconnection = locked.revokedAt !== null;
      await completeOAuthConsent(scoped, principal, row.id, record, options.connection);
      // The waiting `request_connection` or `request_credential` takes `{ connectionId }` as the
      // answer (GRA-28). An ask answered, expired or closed meanwhile does not undo the consent —
      // the connection is connected either way — so those refusals are read and let go.
      const askId = pendingActionId ?? state.pkce?.pendingActionId ?? null;
      if (askId) {
        try {
          await answerPendingAction(
            scoped,
            principal,
            askId,
            { connectionId: row.id },
            options.pendingAction,
          );
        } catch (error) {
          if (
            !(error instanceof ServiceError) ||
            !["CONFLICT", "GONE", "NOT_FOUND"].includes(error.code)
          ) {
            throw error;
          }
        }
      }
      return { reconnection };
    });
    if (!completed) return failed("The connection this consent was for no longer exists.");

    // Committed: a row brought back from revoked re-enters every list whose scope reaches it, and
    // those sessions are told; a first consent or a re-consent of a live row changes no list.
    if (completed.reconnection) {
      await notifyAgentsReachingConnection(
        ctx,
        principal,
        row.id,
        { connection: options.connection },
        options.notifier,
      );
    }
    return land({
      status: "connected",
      connectionId: row.id,
      message: `${row.displayName} is connected — the console updates on its own.`,
    });
  });

  return routes;
}

/** An OAuth error code as the console may show it: the RFC's token characters only, bounded. */
function sanitiseErrorCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "error";
}
