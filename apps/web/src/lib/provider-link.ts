import {
  LINK_CALLBACK_MESSAGE_TYPE,
  LINK_CHANNEL,
  LINK_STATE_TTL_MS,
  type LinkCallbackMessage,
} from "@graft/core/connection/link.rules";

import { api } from "./api";

/**
 * A provider's **link** as the console runs it (ADR 0019; GRA-59) — the one-click connect of a
 * vendor a provider such as Pipedream covers. The shape is the OAuth consent's (`oauth-consent.ts`,
 * GRA-30/48), with the thing waited on changed: a link answers a **pending action**, and the
 * connection exists only once the server's return route has confirmed the account, so the wait is
 * on the ask rather than on a connection. Three signals, any one enough, and the poll is the one
 * that always works: the ask is read every second until it says answered; the console's own
 * `/link/callback` route, where the server's return route sends the popup, `postMessage`s the
 * opener and announces itself on a same-origin channel; and the person can stop waiting. The
 * popup's `closed` flag is never read, for the reason `oauth-consent.ts` gives: a vendor's sign-in
 * page may swap the popup's browsing context group and sever it from this page.
 *
 * Nothing here ever sees a token or a secret: the link is the provider's page, the message carries
 * a status word and two ids, and what Graft stores of the account is its id at the provider.
 */

/** The server mints the provider's link for the ask (`POST /api/pending-actions/:id/link`). */
export function startProviderLink(actionId: string) {
  return api<{ url: string; expiresAt: string; provider: string }>(
    `/pending-actions/${encodeURIComponent(actionId)}/link`,
    { method: "POST" },
  );
}

/** How the wait ended: the return route's word, the person stopped it, or the link's lifetime passed. */
export type LinkOutcome = LinkCallbackMessage["status"] | "stopped" | "expired";

/**
 * The callback route's message, when `event` is one — from the console's own origin, of the shape
 * the route posts, and about the ask in question. Pure, so the filter has a test; anything else is
 * null.
 */
export function readLinkMessage(
  event: { origin: string; data: unknown },
  allowedOrigin: string,
  pendingActionId: string,
): LinkCallbackMessage | null {
  if (event.origin !== allowedOrigin) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const message = data as Partial<LinkCallbackMessage>;
  if (message.type !== LINK_CALLBACK_MESSAGE_TYPE) return null;
  if (!["connected", "declined", "failed"].includes(String(message.status))) return null;
  if (message.pendingActionId !== pendingActionId) return null;
  return {
    type: LINK_CALLBACK_MESSAGE_TYPE,
    status: message.status as LinkCallbackMessage["status"],
    pendingActionId,
    connectionId: typeof message.connectionId === "string" ? message.connectionId : null,
    message: typeof message.message === "string" ? message.message : "",
  };
}

/** How often the ask is read while the link runs. */
export const LINK_POLL_MS = 1000;

/** What the caller's read of the ask answers: settled or not, and the connection when it is. */
export type LinkSettled = { settled: false } | { settled: true; connectionId: string | null };

/**
 * Wait for the link to end: the callback route's message (opener or channel), the ask reading as
 * answered on a poll, the person stopping the wait (`signal`), or the link's own lifetime passing.
 * `isSettled` is the caller's read of the ask. The popup is closed by this side once the wait ends,
 * when the browser still lets it be.
 */
export function awaitLink(args: {
  popup: Window;
  pendingActionId: string;
  isSettled: () => Promise<LinkSettled>;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<{ outcome: LinkOutcome; message: string; connectionId: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const origin = window.location.origin;
    const channel = "BroadcastChannel" in window ? new BroadcastChannel(LINK_CHANNEL) : null;
    const settle = (outcome: LinkOutcome, message = "", connectionId: string | null = null) => {
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
      resolve({ outcome, message, connectionId });
    };
    const onMessage = (event: MessageEvent) => {
      const message = readLinkMessage(event, origin, args.pendingActionId);
      if (message) settle(message.status, message.message, message.connectionId);
    };
    const onChannel = (event: MessageEvent) => {
      const message = readLinkMessage(
        { origin: event.origin || origin, data: event.data },
        origin,
        args.pendingActionId,
      );
      if (message) settle(message.status, message.message, message.connectionId);
    };
    const onAbort = () => settle("stopped");
    const poll = setInterval(async () => {
      if (settled) return;
      const read = await args.isSettled().catch((): LinkSettled => ({ settled: false }));
      if (read.settled) settle("connected", "", read.connectionId);
    }, LINK_POLL_MS);
    const deadline = setTimeout(
      () => settle("expired", "The link took too long; press Connect to start it again."),
      args.deadlineMs ?? LINK_STATE_TTL_MS,
    );
    window.addEventListener("message", onMessage);
    channel?.addEventListener("message", onChannel);
    args.signal?.addEventListener("abort", onAbort);
  });
}
