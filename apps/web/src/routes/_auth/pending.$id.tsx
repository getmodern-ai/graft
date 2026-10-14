import { askAnsweredMessage } from "@graft/core/connection/card.rules";
import { pendingActionIntegrationName } from "@graft/core/pending-action/pending-action.rules";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { GraftWordmark } from "@/components/graft-wordmark";
import {
  CheckIcon,
  ChevronRightIcon,
  DangerousIcon,
  HourglassIcon,
  InfoIcon,
} from "@/components/icons";
import { Loader } from "@/components/loader";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  afterAnswer,
  HANDOFF_CLOSE_CHECK_MS,
  HANDOFF_CLOSE_MS,
  type HandoffRefusal,
  handoffAnswered,
  handoffTitle,
  handoffView,
} from "@/lib/handoff-page";
import { announceConsent } from "@/lib/oauth-consent";
import {
  type PendingAction,
  pendingActionQuery,
  pendingActionsQuery,
} from "@/lib/pending-action-queries";

/**
 * Where a handoff URL lands (ADR 0006): `/pending/<id>?t=<token>`, the shape `@graft/mcp`'s
 * `handoff.ts` builds. The server verifies the token against the row and the session against the
 * owner; a tampered, expired, closed or already-used request is a refusal page that answers
 * nothing, and the action is shown only when the URL is the one Graft issued for it. Without a
 * token — a deep link followed by hand — the action is read from the person's open list instead.
 *
 * **A focused page, not the console** (GRA-144; ADR 0006 as amended 2026-09-21). This route sits
 * under the guard (`_auth`, so a signed-out visit signs in and comes back) but outside the shell
 * (`_auth/_shell`): a person who was in a terminal or a chat a moment ago sees one request under
 * the mark, with the console one button away, and nothing else. The console's own list is
 * `/pending`, which renders every open ask inline with the chrome and never navigates here. Every
 * kind draws its `focused` layout (GRA-314, frames 03c to 03e): the agent's and the integration's
 * marks, the question, *Full access / Ask me first* or how much a tool's yes allows. A secret is
 * still typed here and nowhere else (ADR 0004).
 *
 * Once answered, a handoff visit closes itself (`lib/handoff-page.ts` decides): the card popup
 * tells its opener first, at this origin, under `from=card` (GRA-118; `card.rules.ts`); a tab the
 * person opened by hand cannot be closed by script, so a page still up a moment later shows the
 * answered page instead (frame 10c, GRA-287's sixth decision). A console visit goes back to the
 * list, as it always did.
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

function PendingActionRoute() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const { t, from } = search;
  const fromCard = from === "card";
  const navigate = useNavigate();
  const [closeRefused, setCloseRefused] = React.useState(false);
  // Set once this page's answer succeeded: a later read refused as consumed is that answer taken.
  const [answeredHere, setAnsweredHere] = React.useState(false);

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
  // page goes; a browser that refuses to close a hand-opened tab leaves the answered page instead.
  const onAnswered = () => {
    setAnsweredHere(true);
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
    content = <Answered action={action} />;
  } else if (t !== undefined) {
    const view = handoffView({
      pending: byLink.isPending,
      error: byLink.error,
      action,
      answeredHere,
    });
    content =
      view.kind === "loading" ? (
        <Loader />
      ) : view.kind === "answered" ? (
        <Answered action={action} />
      ) : view.kind === "refused" ? (
        <Refusal kind={view.refusal} title={view.title} message={view.message} />
      ) : (
        <PendingActionCard action={view.action} onAnswered={onAnswered} layout="focused" />
      );
  } else if (fromList.isPending) {
    content = <Loader />;
  } else if (!action) {
    content = (
      <Refusal
        kind="refused"
        title="This request is no longer open"
        message="It was answered, expired, or belongs to another account."
      />
    );
  } else {
    content = <PendingActionCard action={action} onAnswered={onAnswered} layout="focused" />;
  }

  return (
    <main className="flex min-h-svh flex-col bg-muted/30">
      <header className="flex h-14 shrink-0 items-center px-4 md:px-6">
        <GraftWordmark className="h-5" />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/" />}>
          Open Graft
          <ChevronRightIcon />
        </Button>
      </header>
      <div className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center gap-4 px-4 pt-4 pb-16">
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
      </div>
    </main>
  );
}

/** The frames' centred card for a page with one thing to say: an icon, a title, a sentence. */
function StatusCard({
  icon,
  title,
  message,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="w-full gap-5 p-6 md:p-8">
      <CardHeader className="flex flex-col items-center gap-4 px-0 text-center">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-muted text-foreground [&_svg]:size-4"
        >
          {icon}
        </span>
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-balance text-lg">{title}</CardTitle>
          <CardDescription className="text-balance text-sm">{message}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-0">{children}</CardContent>
    </Card>
  );
}

/**
 * The handoff visit's end when the browser would not close the tab (frame 10c): what the answer
 * did, where to go next, the access the answer recorded with Change beside it, and Open Graft.
 */
function Answered({ action }: { action: PendingAction | undefined }) {
  const answered = handoffAnswered(
    action
      ? {
          kind: action.kind,
          agentName: action.agent?.name ?? null,
          integrationName: pendingActionIntegrationName(action.payload),
          answer: action.answer,
        }
      : null,
  );
  return (
    <StatusCard icon={<CheckIcon />} title={answered.title} message={answered.message}>
      {answered.access && action ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 py-1.5 pr-1.5 pl-3 text-muted-foreground text-xs">
          <span className="flex-1">{answered.access}</span>
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link to="/agents/$agentId" params={{ agentId: action.agentId }} />}
          >
            Change
          </Button>
        </div>
      ) : null}
      <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
        Open Graft
      </Button>
    </StatusCard>
  );
}

/**
 * The refusal page (frame 10d for an expired or closed request): what the request was and why it
 * does not open. The sentence is `handoffRefusal`'s, which says nothing was answered only where
 * that is true.
 */
function Refusal({
  kind,
  title,
  message,
}: {
  kind: HandoffRefusal["kind"];
  title: string;
  message: string;
}) {
  return (
    <StatusCard
      icon={kind === "expired" ? <HourglassIcon /> : <DangerousIcon />}
      title={title}
      message={message}
    >
      <Button variant="outline" nativeButton={false} render={<Link to="/pending" />}>
        See open requests
      </Button>
    </StatusCard>
  );
}
