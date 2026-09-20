import {
  askAnsweredMessage,
  FROM_CARD_CLOSE_MS,
  openedFromCard,
} from "@graft/core/connection/card.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type * as React from "react";

import { DangerousIcon, InfoIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { PageContainer } from "@/components/page/page-container";
import { PageNavBreadcrumb } from "@/components/page/page-nav-breadcrumb";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ApiError } from "@/lib/api";
import { announceConsent } from "@/lib/oauth-consent";
import { pendingActionQuery, pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * Where a handoff URL lands (ADR 0006): `/pending/<id>?t=<token>`, the shape `@graft/mcp`'s
 * `handoff.ts` builds. The server verifies the token against the row and the session against the
 * owner; a tampered, expired or already-used link is a refusal page that answers nothing, and the
 * action is shown only when the link is the one Graft issued for it. Without a token — the list
 * links here too — the action is read from the person's open list instead.
 *
 * With `from=card` (GRA-118; `card.rules.ts`) the ask card in a chat opened this page as a popup
 * for the one thing it may not take, a secret (ADR 0004). Once the submit succeeds the page tells
 * the window that opened it, at its own origin, and closes itself after a moment — the card polls
 * Graft and settles on its own — where a visit from the console goes back to the list.
 */
export const Route = createFileRoute("/_auth/_shell/pending/$id")({
  validateSearch: (search: Record<string, unknown>): { t?: string; from?: "card" } => ({
    ...(typeof search.t === "string" && search.t.length > 0 ? { t: search.t } : {}),
    ...(openedFromCard(search) ? { from: "card" as const } : {}),
  }),
  component: PendingActionRoute,
});

/** The refusal's headline by the server's `details.reason`, else by its status. */
function handoffRefusal(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError) {
    const reason =
      typeof error.details === "object" && error.details !== null && "reason" in error.details
        ? String((error.details as { reason: unknown }).reason)
        : null;
    const title =
      reason === "tampered"
        ? "This link is not one Graft issued"
        : reason === "expired"
          ? "This link has expired"
          : reason === "consumed"
            ? "This link was already used"
            : error.status === 404
              ? "There is no such pending action"
              : "This link cannot be opened";
    return { title, message: error.message };
  }
  return { title: "This link cannot be opened", message: "Could not reach the server." };
}

function PendingActionRoute() {
  const { id } = Route.useParams();
  const { t, from } = Route.useSearch();
  const fromCard = from === "card";
  const navigate = useNavigate();

  const byLink = useQuery({ ...pendingActionQuery(id, t ?? ""), enabled: t !== undefined });
  const fromList = useQuery({ ...pendingActionsQuery, enabled: t === undefined });

  const action =
    t !== undefined
      ? byLink.data?.pendingAction
      : fromList.data?.pendingActions.find((candidate) => candidate.id === id);

  // The bars name the agent whose ask this is once there is one — the card below says the rest —
  // and fall back to the list's own name while loading or on a refusal, where there is no ask.
  useScreenTitle(
    action ? (
      <PageNavBreadcrumb parentLabel="Pending actions" parentTo="/pending">
        {action.agent?.name ?? "Ask"}
      </PageNavBreadcrumb>
    ) : (
      "Pending actions"
    ),
  );

  // Answered under `from=card`: the opener is told at this origin — a console tab that opened the
  // page hears it; the card cannot, and polls — and the popup closes itself. The card stays on
  // screen meanwhile and re-reads as settled, so the person sees the sentence before it goes.
  const onAnswered = () => {
    if (!fromCard) {
      void navigate({ to: "/pending" });
      return;
    }
    announceConsent(askAnsweredMessage(id), {
      opener: window.opener,
      origin: window.location.origin,
      channel: null,
    });
    setTimeout(() => window.close(), FROM_CARD_CLOSE_MS);
  };

  let content: React.ReactNode;
  if (t !== undefined) {
    content = byLink.isPending ? (
      <Loader />
    ) : byLink.error || !action ? (
      <Refusal {...handoffRefusal(byLink.error)} />
    ) : (
      <PendingActionCard action={action} onAnswered={onAnswered} />
    );
  } else if (fromList.isPending) {
    content = <Loader />;
  } else if (!action) {
    content = (
      <Refusal
        title="This ask is no longer open"
        message="It was answered, expired, or belongs to another account."
      />
    );
  } else {
    content = <PendingActionCard action={action} onAnswered={onAnswered} />;
  }

  return (
    <PageContainer size="medium">
      {fromCard && action ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>Opened from the card in your chat</AlertTitle>
          <AlertDescription>
            Nothing typed here reaches the chat. Once you have answered, this window closes itself
            and the card updates on its own.
          </AlertDescription>
        </Alert>
      ) : null}
      {content}
    </PageContainer>
  );
}

/**
 * The refusal page: what the link was, why it does not open, and that nothing was answered. The
 * frame and voice are `RouteNotFound`'s — the server's sentence, then the reassurance after the
 * dash — with the server's own full stop lifted so the two read as one sentence.
 */
function Refusal({ title, message }: { title: string; message: string }) {
  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DangerousIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          {message.replace(/\.$/, "")} — nothing has been approved or declined.
        </EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" nativeButton={false} render={<Link to="/pending" />}>
        See every pending action
      </Button>
    </Empty>
  );
}
