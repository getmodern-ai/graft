import { askAnsweredMessage } from "@graft/core/connection/card.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { AuthHeader } from "@/components/auth/auth-header";
import { CheckCircleIcon, DangerousIcon, InfoIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { PendingActionCard } from "@/components/pending/pending-action-card";
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
import {
  afterAnswer,
  HANDOFF_ANSWERED,
  HANDOFF_CLOSE_CHECK_MS,
  HANDOFF_CLOSE_MS,
  handoffTitle,
} from "@/lib/handoff-page";
import { announceConsent } from "@/lib/oauth-consent";
import { pendingActionQuery, pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * Where a handoff URL lands (ADR 0006): `/pending/<id>?t=<token>`, the shape `@graft/mcp`'s
 * `handoff.ts` builds. The server verifies the token against the row and the session against the
 * owner; a tampered, expired or already-used link is a refusal page that answers nothing, and the
 * action is shown only when the link is the one Graft issued for it. Without a token — a deep link
 * followed by hand — the action is read from the person's open list instead.
 *
 * **A focused page, not the console** (GRA-144; ADR 0006 as amended 2026-09-21). This route sits
 * under the guard (`_auth`, so a signed-out visit signs in and comes back) but outside the shell
 * (`_auth/_shell`): a person who was in a terminal or a chat a moment ago sees one ask under the
 * mark, with the console one link away, and nothing else. The console's own inbox is the list at
 * `/pending`, which renders every open ask inline with the chrome and never navigates here.
 *
 * Once answered, a link visit closes itself (`lib/handoff-page.ts` decides): the card popup tells
 * its opener first, at this origin, under `from=card` (GRA-118; `card.rules.ts`); a tab the person
 * opened by hand cannot be closed by script, so a page still up a moment later shows the answered
 * state instead. A console visit goes back to the list, as it always did.
 */
export const Route = createFileRoute("/_auth/pending/$id")({
  validateSearch: (search: Record<string, unknown>): { t?: string; from?: "card" } => ({
    ...(typeof search.t === "string" && search.t.length > 0 ? { t: search.t } : {}),
    ...(search.from === "card" ? { from: "card" as const } : {}),
  }),
  head: () => ({
    meta: [{ title: handoffTitle() }, { name: "robots", content: "noindex" }],
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
  const search = Route.useSearch();
  const { t, from } = search;
  const fromCard = from === "card";
  const navigate = useNavigate();
  const [closeRefused, setCloseRefused] = React.useState(false);

  const byLink = useQuery({ ...pendingActionQuery(id, t ?? ""), enabled: t !== undefined });
  const fromList = useQuery({ ...pendingActionsQuery, enabled: t === undefined });

  const action =
    t !== undefined
      ? byLink.data?.pendingAction
      : fromList.data?.pendingActions.find((candidate) => candidate.id === id);

  // The tab's title names the agent once the ask is read; the route's `head` set the plain one.
  React.useEffect(() => {
    document.title = handoffTitle(action?.agent?.name);
  }, [action?.agent?.name]);

  // The card stays on screen and re-reads as settled, so the person sees the sentence before the
  // page goes; a browser that refuses to close a hand-opened tab leaves the answered state instead.
  const onAnswered = () => {
    const next = afterAnswer(search);
    if (next.kind === "back-to-list") {
      void navigate({ to: "/pending" });
      return;
    }
    if (next.announce) {
      announceConsent(askAnsweredMessage(id), {
        opener: window.opener,
        origin: window.location.origin,
        channel: null,
      });
    }
    setTimeout(() => {
      window.close();
      setTimeout(() => {
        if (!window.closed) setCloseRefused(true);
      }, HANDOFF_CLOSE_CHECK_MS);
    }, HANDOFF_CLOSE_MS);
  };

  let content: React.ReactNode;
  if (closeRefused) {
    content = <Answered />;
  } else if (t !== undefined) {
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
    <main className="flex min-h-svh flex-col">
      <AuthHeader />
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
        {fromCard && action && !closeRefused ? (
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
        {!closeRefused ? (
          <p className="text-center text-muted-foreground text-sm">
            <Link to="/pending" className="underline underline-offset-4">
              Every pending action, in the console
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}

/** The link visit's end when the browser would not close the tab: done, and where the record is. */
function Answered() {
  return (
    <Empty className="mx-auto h-full max-w-md px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircleIcon />
        </EmptyMedia>
        <EmptyTitle>{HANDOFF_ANSWERED.title}</EmptyTitle>
        <EmptyDescription>{HANDOFF_ANSWERED.message}</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" nativeButton={false} render={<Link to="/pending" />}>
        Open Pending actions
      </Button>
    </Empty>
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
