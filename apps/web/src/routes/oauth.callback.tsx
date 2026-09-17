import {
  OAUTH_CONSENT_CHANNEL,
  oauthCallbackMessage,
  readOAuthCallbackSearch,
} from "@graft/core/connection/oauth.rules";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  CallbackOutcomePage,
  callbackOutcomeTitle,
} from "@/components/connection/callback-outcome-page";
import { announceConsent, OAUTH_CALLBACK_CLOSE_MS } from "@/lib/oauth-consent";

/**
 * Where the popup ends (ADR 0005; GRA-48). The server's callback route — the redirect URI the
 * person registered with the vendor — verifies the state, exchanges the code and stores the tokens,
 * then sends the browser here with the outcome in the query (`apps/server/src/oauth.ts`;
 * `oauthCallbackRedirect` writes it, `readOAuthCallbackSearch` reads it), so what the person
 * sees is a console page in the console's design system rather than a page the server drew. On
 * landing it tells the waiting console what happened — the opener at this origin, and the
 * same-origin channel for the vendor that severed the opener (`lib/oauth-consent.ts`,
 * `announceConsent`) — and on a success closes itself after a moment. Public, outside `_auth` and
 * the shell, on purpose: the popup has no session read to wait on and no chrome to wear, and the
 * query already holds everything it shows. The page itself is `CallbackOutcomePage`, shared with a
 * provider's link (`link.callback.tsx`, GRA-59).
 *
 * Nothing here is trusted beyond what it is. The query is read into three fields and no more, the
 * message is posted to this page's own origin alone, and the waiting console takes it only for the
 * connection it is waiting on — a hand-typed address settles nothing.
 */
export const Route = createFileRoute("/oauth/callback")({
  validateSearch: readOAuthCallbackSearch,
  head: ({ match }) => ({
    meta: [
      { title: `Graft — ${callbackOutcomeTitle(match.search.status)}` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OAuthCallbackRoute,
});

function OAuthCallbackRoute() {
  const { status, connectionId, message } = Route.useSearch();
  const navigate = useNavigate();

  /**
   * Announce on landing, and on a success close after the same delay the server's page used. React
   * 19 runs an effect twice in development; a second announcement is harmless, because
   * `awaitConsent` settles on the first message it reads and ignores every one after.
   */
  useEffect(() => {
    announceConsent(oauthCallbackMessage({ status, connectionId, message }), {
      opener: window.opener,
      origin: window.location.origin,
      channel: "BroadcastChannel" in window ? new BroadcastChannel(OAUTH_CONSENT_CHANNEL) : null,
    });
    if (status !== "connected") return;
    const timer = setTimeout(() => window.close(), OAUTH_CALLBACK_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [status, connectionId, message]);

  /**
   * `window.close()` is honoured for the popup the console opened and refused for a tab the person
   * opened by hand — the blocked-popup path in `ConsentStatus`. When it is refused this page is
   * still up a moment later, and the connections list is the useful next place rather than a
   * button that did nothing.
   */
  const close = () => {
    window.close();
    setTimeout(() => {
      if (!window.closed) void navigate({ to: "/connections" });
    }, 200);
  };

  return <CallbackOutcomePage status={status} message={message} onClose={close} />;
}
