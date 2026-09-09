import { OAUTH_CONSENT_CHANNEL, OAUTH_STATE_TTL_MS } from "@graft/core/connection/oauth.rules";
import type { OAuthCallbackMessage } from "@graft/server/oauth";
import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";
import type { Connection } from "./connection-queries";

/**
 * The consent as the console runs it (ADR 0005): the redirect URI the person pastes into the client
 * they register — fetched from the server, never computed here, so the form can only ever show the
 * URI the callback route serves — the popup the authorize URL opens, and how the console learns the
 * consent finished. Three signals, any one enough, and the poll is the one that always works: the
 * connection is read every second until it says connected; the callback page (`apps/server/src/oauth.ts`)
 * `postMessage`s the opener and announces itself on a same-origin `BroadcastChannel`; and the person
 * can stop waiting. **The popup's `closed` flag is deliberately not a signal.** A vendor whose
 * consent page sends `Cross-Origin-Opener-Policy: same-origin` — Google does, verified against
 * `accounts.google.com` on 9 September 2026 — swaps the popup's browsing context group, after which
 * the opener's handle reports it closed while the consent is still running and `window.opener` is
 * null on the callback page, so neither the flag nor the message can be relied on for such a vendor.
 * Nothing here ever sees a token: the message carries a status word and the connection id.
 */

export const oauthKeys = {
  redirectUri: ["oauth", "redirect-uri"] as const,
};

export const redirectUriQuery = queryOptions({
  queryKey: oauthKeys.redirectUri,
  queryFn: () => api<{ redirectUri: string }>("/oauth/redirect-uri"),
  staleTime: Number.POSITIVE_INFINITY,
});

/** Start — or restart — a connection's consent; with an ask's id, the consent answers that ask. */
export function startOAuthConsent(connectionId: string, pendingActionId?: string) {
  return api<{ authorizeUrl: string; expiresAt: string; connection: Connection }>(
    `/connections/${encodeURIComponent(connectionId)}/oauth/authorize-url`,
    { method: "POST", body: pendingActionId ? { pendingActionId } : {} },
  );
}

/** How the wait ended: the callback's word, the person stopped it, or the consent's lifetime passed. */
export type ConsentOutcome = OAuthCallbackMessage["status"] | "stopped" | "expired";

/**
 * The callback page's message, when `event` is one — from an origin the page may be served on (the
 * server's for `postMessage`; the console's own for the channel, which is same-origin by
 * construction), of the shape the page sends, and about the connection in question. Pure, so the
 * filter has a test; anything else is null.
 */
export function readConsentMessage(
  event: { origin: string; data: unknown },
  allowedOrigin: string | readonly string[],
  connectionId: string,
): OAuthCallbackMessage | null {
  const origins = typeof allowedOrigin === "string" ? [allowedOrigin] : allowedOrigin;
  if (!origins.includes(event.origin)) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const message = data as Partial<OAuthCallbackMessage>;
  if (message.type !== "graft:oauth") return null;
  if (!["connected", "declined", "failed"].includes(String(message.status))) return null;
  if (message.connectionId !== connectionId) return null;
  return {
    type: "graft:oauth",
    status: message.status as OAuthCallbackMessage["status"],
    connectionId,
    message: typeof message.message === "string" ? message.message : "",
  };
}

/** The server's origin, from the redirect URI it handed out — where the callback page lives. */
export function serverOriginOf(redirectUri: string): string {
  return new URL(redirectUri).origin;
}

/** A centred popup for the vendor's consent page; null when the browser refused to open one. */
export function openConsentPopup(authorizeUrl: string): Window | null {
  const width = 600;
  const height = 720;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  return window.open(
    authorizeUrl,
    "graft-oauth-consent",
    `popup,width=${width},height=${height},left=${left},top=${top}`,
  );
}

/** How often the connection is read while the consent runs. */
export const CONSENT_POLL_MS = 1000;

/**
 * Wait for the consent to end: the callback's message (opener or channel), the connection reading
 * as connected on a poll, the person stopping the wait (`signal`), or the consent's own lifetime
 * passing — never the popup's `closed` flag, for the reason the module header gives. `isConnected`
 * is the caller's read of the connection. The popup is closed by this side once the wait ends, when
 * the browser still lets it be.
 */
export function awaitConsent(args: {
  popup: Window;
  serverOrigin: string;
  connectionId: string;
  isConnected: () => Promise<boolean>;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<{ outcome: ConsentOutcome; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const channel =
      "BroadcastChannel" in window ? new BroadcastChannel(OAUTH_CONSENT_CHANNEL) : null;
    const settle = (outcome: ConsentOutcome, message = "") => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      channel?.close();
      clearInterval(poll);
      clearTimeout(deadline);
      args.signal?.removeEventListener("abort", onAbort);
      try {
        args.popup.close();
      } catch {
        // A swapped or already-closed popup; nothing to do.
      }
      resolve({ outcome, message });
    };
    const onMessage = (event: MessageEvent) => {
      const message = readConsentMessage(event, args.serverOrigin, args.connectionId);
      if (message) settle(message.status, message.message);
    };
    const onChannel = (event: MessageEvent) => {
      const message = readConsentMessage(
        { origin: event.origin || window.location.origin, data: event.data },
        window.location.origin,
        args.connectionId,
      );
      if (message) settle(message.status, message.message);
    };
    const onAbort = () => settle("stopped");
    const poll = setInterval(async () => {
      if (settled) return;
      if (await args.isConnected().catch(() => false)) settle("connected");
    }, CONSENT_POLL_MS);
    const deadline = setTimeout(
      () => settle("expired", "The consent took too long; press Connect to start it again."),
      args.deadlineMs ?? OAUTH_STATE_TTL_MS,
    );
    window.addEventListener("message", onMessage);
    channel?.addEventListener("message", onChannel);
    args.signal?.addEventListener("abort", onAbort);
  });
}
