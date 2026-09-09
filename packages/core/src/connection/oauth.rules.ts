import type { ConnectionScheme } from "@graft/db/schema/connection";

/**
 * What the console, the meta-tool and the server all say about an authorization-code connection
 * (ADR 0005), as pure functions: where the vendor sends the person back, which vendor hosts are
 * Google's, what the console shows for a connection between the person clicking Connect and the
 * tokens arriving. **Browser-safe, and the console depends on that** — this file imports one type
 * and nothing else, like `connection.rules.ts`; the PKCE and state code that needs `node:crypto` is
 * `oauth-consent.ts`, which the console never reaches.
 */

export const OAUTH_AUTHORIZATION_CODE = "oauth_authorization_code" satisfies ConnectionScheme;

export function isOAuthAuthorizationCode(scheme: string): boolean {
  return scheme === OAUTH_AUTHORIZATION_CODE;
}

/**
 * Where every vendor sends the browser back after the consent: one route, for every vendor, on the
 * server's own origin (ADR 0005). The console shows the person this URI to paste into the vendor's
 * client registration, fetched from the server rather than computed in the browser, so the URI the
 * form shows and the one the callback route serves are one value (`apps/server/src/oauth.ts`).
 */
export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

/**
 * How long a consent may take from Connect to the callback before its state is refused — and how
 * long the console waits for it. Here rather than in `oauth-consent.ts` because the console reads
 * it too, and that file imports `node:crypto`.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * The same-origin channel the callback page announces itself on beside `postMessage` (ADR 0005;
 * `apps/server/src/oauth.ts`). A vendor whose consent page sends `Cross-Origin-Opener-Policy:
 * same-origin` — Google does — severs the popup from its opener, so `window.opener` is null on the
 * callback page and the opener's handle reports the popup closed; in production the console and the
 * callback share an origin, so a `BroadcastChannel` still reaches it. In development, where they
 * do not, the console's poll of the connection is what notices.
 */
export const OAUTH_CONSENT_CHANNEL = "graft:oauth";

/** `GRAFT_AUTH_URL` plus the callback path — a trailing slash on the origin is not doubled. */
export function oauthRedirectUri(authUrl: string): string {
  return `${authUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Google's hosts, as the notice and the authorize URL's extra parameters recognise them: the API
 * hosts (`gmail.googleapis.com`, `www.googleapis.com`), the account host the consent runs on, and
 * `google.com` itself. Compared lower-case against a hostname, with or without a port.
 */
export function isGoogleHost(host: string): boolean {
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "");
  return (
    hostname === "google.com" ||
    hostname.endsWith(".google.com") ||
    hostname === "googleapis.com" ||
    hostname.endsWith(".googleapis.com")
  );
}

/** Whether any host the connection reaches — or its authorize endpoint — is Google's. */
export function hasGoogleHost(hosts: readonly string[], authorizeUrl?: string): boolean {
  if (hosts.some(isGoogleHost)) return true;
  if (!authorizeUrl) return false;
  try {
    return isGoogleHost(new URL(authorizeUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The wart ADR 0005 names: a Google Cloud project in Testing mode issues refresh tokens that expire
 * after seven days, so a person's own Gmail connection re-consents weekly until the project is
 * published — and publishing an app that reads Gmail means Google's verification and a CASA
 * assessment. Shown on the form whenever a host is Google's, and nowhere else.
 */
export const GOOGLE_TESTING_MODE_NOTICE =
  "A Google Cloud project in Testing mode issues refresh tokens that expire after seven days, so this connection will ask you to reconnect weekly; publishing the app removes that, but a published app that reads Gmail needs Google's verification and a CASA assessment.";

/**
 * The non-secret state `connection.oauth_refresh_state` holds for an authorization-code connection.
 * Written by the consent's start and end and by the refresh; read by the console. `pkce` exists
 * only between the person clicking Connect and the vendor calling back — the verifier the callback
 * exchanges the code with, which never leaves the server (`oauth-consent.ts`).
 */
export type OAuthState = {
  /** When the person last completed the consent; absent until they have. */
  consentedAt?: string;
  /** When the stored access token dies, as the token endpoint said; null when it said nothing. */
  expiresAt?: string | null;
  /** When the proxy last bought a fresh access token with the refresh token. */
  refreshedAt?: string;
  /** Set when a refresh was refused: the person has to consent again (the console's Reconnect). */
  consentRequired?: { at: string; reason: string };
  /** The consent in flight: its PKCE verifier, when it started, and the ask it answers, if any. */
  pkce?: { verifier: string; issuedAt: string; pendingActionId: string | null };
};

/** The column's JSON as an `OAuthState`, reading only the fields with the shapes they promise. */
export function readOAuthState(raw: Record<string, unknown> | null | undefined): OAuthState {
  if (!raw) return {};
  const state: OAuthState = {};
  if (typeof raw.consentedAt === "string") state.consentedAt = raw.consentedAt;
  if (typeof raw.expiresAt === "string" || raw.expiresAt === null) state.expiresAt = raw.expiresAt;
  if (typeof raw.refreshedAt === "string") state.refreshedAt = raw.refreshedAt;
  const required = raw.consentRequired;
  if (
    typeof required === "object" &&
    required !== null &&
    typeof (required as { at?: unknown }).at === "string" &&
    typeof (required as { reason?: unknown }).reason === "string"
  ) {
    const { at, reason } = required as { at: string; reason: string };
    state.consentRequired = { at, reason };
  }
  const pkce = raw.pkce;
  if (
    typeof pkce === "object" &&
    pkce !== null &&
    typeof (pkce as { verifier?: unknown }).verifier === "string" &&
    typeof (pkce as { issuedAt?: unknown }).issuedAt === "string"
  ) {
    const { verifier, issuedAt, pendingActionId } = pkce as {
      verifier: string;
      issuedAt: string;
      pendingActionId?: unknown;
    };
    state.pkce = {
      verifier,
      issuedAt,
      pendingActionId: typeof pendingActionId === "string" ? pendingActionId : null,
    };
  }
  return state;
}

/**
 * Where an authorization-code connection stands, for the console's badge and button: the client
 * secret is entered and the person has not yet consented; the tokens are there; or a refresh was
 * refused and the person has to consent again. Whether a client secret is entered at all is
 * `credentialSetAt`, as for every scheme.
 */
export type OAuthStatus = "awaiting_consent" | "connected" | "consent_required";

/** What the row's public shape says about the consent — everything in the state but the verifier. */
export type OAuthPublicState = {
  status: OAuthStatus;
  consentedAt: string | null;
  expiresAt: string | null;
  refreshedAt: string | null;
  consentRequired: { at: string; reason: string } | null;
};

export function oauthPublicState(state: OAuthState): OAuthPublicState {
  const status: OAuthStatus = state.consentRequired
    ? "consent_required"
    : state.consentedAt
      ? "connected"
      : "awaiting_consent";
  return {
    status,
    consentedAt: state.consentedAt ?? null,
    expiresAt: state.expiresAt ?? null,
    refreshedAt: state.refreshedAt ?? null,
    consentRequired: state.consentRequired ?? null,
  };
}
