import {
  answerPendingAction,
  type ConnectionDeps,
  completeOAuthConsent,
  isOAuthAuthorizationCode,
  OAUTH_CONSENT_CHANNEL,
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
import type { HandoffConfig } from "@graft/mcp";
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
 * `request_connection` says connected exactly as GRA-28's key-shaped path does, and renders a page
 * that tells the person to close the window and `postMessage`s the opener.
 *
 * **This is the second place in `apps/server` a stored credential becomes plaintext.** The first is
 * the proxy binding in `app.ts`, for the vendor call; this one is for the code exchange, which needs
 * the client secret and cannot go through the proxy — the vendor's token endpoint is not a
 * connection host and the exchange is not a tool's call. Both live in this app and nowhere else;
 * `@graft/core` still takes the vault's encrypt half only. A token never reaches the browser: the
 * page carries the connection id and a status word, and nothing the vendor answered.
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

/** What the callback page tells the opener — a status word and the connection, never a token. */
export type OAuthCallbackMessage = {
  type: "graft:oauth";
  status: "connected" | "declined" | "failed";
  connectionId: string | null;
  message: string;
};

export function createOAuthRoutes(options: OAuthRouteOptions): Hono {
  const routes = new Hono();
  const ctx: ServiceContext = { db: options.db };
  const upstream = options.oauth.upstreamFetch ?? createUpstreamFetch();
  const timeoutMs = options.oauth.timeoutMs ?? DEFAULT_OAUTH_EXCHANGE_TIMEOUT_MS;
  const consoleOrigin = new URL(options.handoff.consoleUrl).origin;
  const redirectUri = oauthRedirectUri(options.oauth.authUrl);

  /** The one value the person pastes into the vendor's client registration (ADR 0005). */
  routes.get("/redirect-uri", async (c) => {
    requirePerson(await options.getSession(c.req.raw.headers));
    return c.json({ redirectUri });
  });

  /**
   * Where the vendor sends the browser back. Every refusal is a page, not JSON — a person is
   * reading it — and says what to do next; none carries a token, a code or the vendor's body.
   */
  routes.get("/callback", async (c) => {
    const query = c.req.query();
    const page = (status: number, message: OAuthCallbackMessage) =>
      c.html(callbackPage(message, consoleOrigin), status as 200);
    const failed = (status: number, message: string, connectionId: string | null = null) =>
      page(status, { type: "graft:oauth", status: "failed", connectionId, message });

    const verdict = verifyOAuthState(
      query.state,
      options.handoff.secret,
      options.pendingAction.now(),
    );
    if (!verdict.ok) return failed(verdict.reason === "expired" ? 410 : 400, verdict.message);
    const { connectionId, personId, pendingActionId } = verdict.payload;
    const principal: Principal = { personId };

    const row = await options.connection.findConnection(options.db, personId, connectionId);
    if (!row) return failed(404, "The connection this consent was for no longer exists.");
    if (!isOAuthAuthorizationCode(row.scheme)) {
      return failed(400, `${row.displayName} is not an OAuth connection.`, row.id);
    }

    // The vendor's own refusal: the person declined, or the client is misconfigured at the vendor.
    // The ask stays open — the person may decline it in the console, or try again.
    if (typeof query.error === "string" && query.error.length > 0) {
      const declined = query.error === "access_denied";
      return page(200, {
        type: "graft:oauth",
        status: declined ? "declined" : "failed",
        connectionId: row.id,
        message: declined
          ? `You declined to connect ${row.displayName}. Nothing was stored; close this window.`
          : `The vendor refused to start the consent for ${row.displayName} (${sanitiseErrorCode(query.error)}). Check the client id, the redirect URI and the scopes at the vendor, then connect again from the console.`,
      });
    }

    const state = readOAuthState(row.oauthRefreshState);
    if (!state.pkce) {
      return failed(
        409,
        `No consent is in progress for ${row.displayName} — start it again from the console.`,
        row.id,
      );
    }
    const code = query.code;
    if (typeof code !== "string" || code.length === 0) {
      return failed(400, "The vendor sent the browser back without a code.", row.id);
    }
    if (!row.credentialCiphertext) {
      return failed(
        409,
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
      return failed(500, "The stored client secret could not be read.", row.id);
    }
    const clientSecret = stored.clientSecret;
    const clientId = row.schemeConfig.clientId;
    if (!clientSecret || !clientId) {
      return failed(409, `${row.displayName} is missing its client id or secret.`, row.id);
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
        502,
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

    await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
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
    });

    return page(200, {
      type: "graft:oauth",
      status: "connected",
      connectionId: row.id,
      message: `${row.displayName} is connected. You can close this window.`,
    });
  });

  return routes;
}

/** An OAuth error code as the page may show it: the RFC's token characters only, bounded. */
function sanitiseErrorCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "error";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The page the popup ends on: one sentence, and a script that tells the console what happened and
 * for which connection — to the opener, at the console's origin alone, so no other page that opened
 * this window hears it; and on a same-origin `BroadcastChannel`, because a vendor whose consent page
 * sends `Cross-Origin-Opener-Policy: same-origin` (Google) has severed this window from its opener
 * by the time it lands here (`@graft/core`'s `OAUTH_CONSENT_CHANNEL`). The message is JSON with `<`
 * escaped, so nothing in a display name can close the script; the text is HTML-escaped. Everything
 * on it is already the person's to know.
 */
export function callbackPage(message: OAuthCallbackMessage, consoleOrigin: string): string {
  const title =
    message.status === "connected"
      ? "Connected"
      : message.status === "declined"
        ? "Not connected"
        : "Something went wrong";
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  const origin = JSON.stringify(consoleOrigin).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Graft — ${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; color: #111; background: #fafafa; }
  main { max-width: 28rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #444; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message.message)}</p>
</main>
<script>
(function () {
  var message = ${payload};
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(message, ${origin});
  } catch (error) {}
  try {
    if ("BroadcastChannel" in window) {
      var channel = new BroadcastChannel(${JSON.stringify(OAUTH_CONSENT_CHANNEL)});
      channel.postMessage(message);
      channel.close();
    }
  } catch (error) {}
  if (message.status === "connected") setTimeout(function () { window.close(); }, 1500);
})();
</script>
</body>
</html>
`;
}
