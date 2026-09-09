import type { OAuthCallbackMessage } from "@graft/server/oauth";
import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";
import type { Connection } from "./connection-queries";

/**
 * The consent as the console runs it (ADR 0005): the redirect URI the person pastes into the client
 * they register — fetched from the server, never computed here, so the form can only ever show the
 * URI the callback route serves — the popup the authorize URL opens, and how the console learns the
 * consent finished. Two signals, either enough: the callback page `postMessage`s the opener with an
 * `OAuthCallbackMessage` (`apps/server/src/oauth.ts`), and, should the popup have lost its opener
 * or the message its way, the connection is polled while the popup is open until it says connected.
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

export type ConsentOutcome = OAuthCallbackMessage["status"] | "closed";

/**
 * The callback page's message, when `event` is one — from the server's origin (the page is served
 * there, which in development is not the console's own origin), of the shape the page sends, and
 * about the connection in question. Pure, so the filter has a test; anything else is null.
 */
export function readConsentMessage(
  event: { origin: string; data: unknown },
  serverOrigin: string,
  connectionId: string,
): OAuthCallbackMessage | null {
  if (event.origin !== serverOrigin) return null;
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

/**
 * Wait for the consent in `popup` to end: the callback's message, the connection reading as
 * connected on a poll, or the popup closing. `isConnected` is the poll — the caller's refetch of the
 * connection — asked every second while the popup is open and once more after it closes, because a
 * popup that closes itself right after posting may beat the message to the listener.
 */
export function awaitConsent(args: {
  popup: Window;
  serverOrigin: string;
  connectionId: string;
  isConnected: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{ outcome: ConsentOutcome; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: ConsentOutcome, message = "") => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(poll);
      args.signal?.removeEventListener("abort", onAbort);
      resolve({ outcome, message });
    };
    const onMessage = (event: MessageEvent) => {
      const message = readConsentMessage(event, args.serverOrigin, args.connectionId);
      if (message) settle(message.status, message.message);
    };
    const onAbort = () => settle("closed");
    const poll = setInterval(async () => {
      if (settled) return;
      if (await args.isConnected().catch(() => false)) return settle("connected");
      if (args.popup.closed) {
        // One last look: the callback may have written the tokens as the window closed.
        if (await args.isConnected().catch(() => false)) return settle("connected");
        settle("closed");
      }
    }, 1000);
    window.addEventListener("message", onMessage);
    args.signal?.addEventListener("abort", onAbort);
  });
}
