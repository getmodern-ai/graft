import {
  OAUTH_CONSENT_CHANNEL,
  type OAuthCallbackStatus,
  oauthCallbackMessage,
  readOAuthCallbackSearch,
} from "@graft/core/connection/oauth.rules";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { CheckCircleIcon, DangerousIcon, type IconProps, WarningIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { announceConsent, OAUTH_CALLBACK_CLOSE_MS } from "@/lib/oauth-consent";

/**
 * Where the popup ends (ADR 0005; GRA-48). The server's callback route — the redirect URI the
 * person registered with the vendor — verifies the state, exchanges the code and stores the tokens,
 * then sends the browser here with the outcome in the query (`apps/server/src/oauth.ts`;
 * `oauthCallbackRedirect` writes it, `readOAuthCallbackSearch` below reads it), so what the person
 * sees is a console page in the console's design system rather than a page the server drew. On
 * landing it tells the waiting console what happened — the opener at this origin, and the
 * same-origin channel for the vendor that severed the opener (`lib/oauth-consent.ts`,
 * `announceConsent`) — and on a success closes itself after a moment. Public, outside `_auth` and
 * the shell, on purpose: the popup has no session read to wait on and no chrome to wear, and the
 * query already holds everything it shows.
 *
 * Nothing here is trusted beyond what it is. The query is read into three fields and no more, the
 * message is posted to this page's own origin alone, and the waiting console takes it only for the
 * connection it is waiting on — a hand-typed address settles nothing.
 */
export const Route = createFileRoute("/oauth/callback")({
  validateSearch: readOAuthCallbackSearch,
  head: ({ match }) => ({
    meta: [
      { title: `Graft — ${OUTCOMES[match.search.status].title}` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OAuthCallbackRoute,
});

/**
 * Cando's empty-state shape for each outcome: an icon, a sentence-case title with no full stop, one
 * sentence of description — the server's own when it sent one, these when the address carried none.
 * Composed rather than matched to a frame (ADR 0017): Cando's `connections.callback.tsx` is the
 * nearest screen, and its `route-not-found.tsx` the voice.
 */
const OUTCOMES: Record<
  OAuthCallbackStatus,
  { title: string; Icon: (props: IconProps) => React.JSX.Element; fallback: string }
> = {
  connected: {
    title: "Connected",
    Icon: CheckCircleIcon,
    fallback: "The connection is ready — the console updates on its own.",
  },
  declined: {
    title: "Not connected",
    Icon: WarningIcon,
    fallback: "You declined the consent — nothing was stored.",
  },
  failed: {
    title: "Something went wrong",
    Icon: DangerousIcon,
    fallback:
      "The consent did not complete — nothing was stored, and you can connect again from the console.",
  },
};

function OAuthCallbackRoute() {
  const { status, connectionId, message } = Route.useSearch();
  const navigate = useNavigate();
  const { title, Icon, fallback } = OUTCOMES[status];

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

  return (
    <main className="flex min-h-svh flex-col">
      <Empty className="mx-auto h-full max-w-md px-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{message || fallback}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={close}>Close this window</Button>
      </Empty>
    </main>
  );
}
