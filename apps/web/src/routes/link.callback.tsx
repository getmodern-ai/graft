import { openedFromCard } from "@graft/core/connection/card.rules";
import {
  LINK_CHANNEL,
  linkCallbackMessage,
  readLinkCallbackSearch,
} from "@graft/core/connection/link.rules";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  CallbackOutcomePage,
  callbackOutcomeTitle,
} from "@/components/connection/callback-outcome-page";
import { announceConsent, OAUTH_CALLBACK_CLOSE_MS } from "@/lib/oauth-consent";

/**
 * Where a provider's link ends (ADR 0019; GRA-59) — the OAuth consent's callback route
 * (`oauth.callback.tsx`, GRA-48) for the one-click connect. The server's return route — where the
 * provider's page sends the browser back — verifies the signed state, asks the provider what the
 * person connected, makes the connection and answers the ask, then sends the browser here with the
 * outcome in the query (`apps/server/src/provider-link.ts`; `linkCallbackRedirect` writes it,
 * `readLinkCallbackSearch` reads it). On landing it tells the waiting console what happened — the
 * opener at this origin, and the same-origin channel for the page that severed the opener
 * (`lib/oauth-consent.ts`, `announceConsent`) — and on a success closes itself after a moment.
 * Public, outside `_auth` and the shell, on purpose, for the reasons the consent's route gives.
 *
 * A link the ask card minted arrives with `from=card` (GRA-117; `card.rules.ts`): nothing in the
 * console is waiting, the card polls Graft for the outcome itself, so the page says so. A success
 * closes itself after the same moment; a failure stays, because the ask is still open and the
 * card, which reads `open` from Graft, has no sentence for it — this page is the one that says
 * what went wrong, and the card's button is where the person tries again (Greptile on #94).
 *
 * Nothing here is trusted beyond what it is: the query is read into five fields and no more, the
 * message is posted to this page's own origin alone, and the waiting card takes it only for the ask
 * it is waiting on.
 */
export const Route = createFileRoute("/link/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...readLinkCallbackSearch(search),
    ...(openedFromCard(search) ? { fromCard: true as const } : {}),
  }),
  head: ({ match }) => ({
    meta: [
      { title: `Graft — ${callbackOutcomeTitle(match.search.status)}` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LinkCallbackRoute,
});

function LinkCallbackRoute() {
  const { status, pendingActionId, connectionId, message, fromCard = false } = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    announceConsent(linkCallbackMessage({ status, pendingActionId, connectionId, message }), {
      opener: window.opener,
      origin: window.location.origin,
      channel: "BroadcastChannel" in window ? new BroadcastChannel(LINK_CHANNEL) : null,
    });
    if (status !== "connected") return;
    const timer = setTimeout(() => window.close(), OAUTH_CALLBACK_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [status, pendingActionId, connectionId, message]);

  const close = () => {
    window.close();
    setTimeout(() => {
      if (!window.closed) void navigate({ to: "/pending" });
    }, 200);
  };

  return (
    <CallbackOutcomePage status={status} message={message} onClose={close} fromCard={fromCard} />
  );
}
