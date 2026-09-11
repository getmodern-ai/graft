import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type * as React from "react";

import { DangerousIcon } from "@/components/icons";
import { Loader } from "@/components/loader";
import { PageContainer } from "@/components/page/page-container";
import { PageNavBreadcrumb } from "@/components/page/page-nav-breadcrumb";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ApiError } from "@/lib/api";
import { pendingActionQuery, pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * Where a handoff URL lands (ADR 0006): `/pending/<id>?t=<token>`, the shape `@graft/mcp`'s
 * `handoff.ts` builds. The server verifies the token against the row and the session against the
 * owner; a tampered, expired or already-used link is a refusal page that answers nothing, and the
 * action is shown only when the link is the one Graft issued for it. Without a token — the list
 * links here too — the action is read from the person's open list instead.
 */
export const Route = createFileRoute("/_auth/_shell/pending/$id")({
  validateSearch: (search: Record<string, unknown>): { t?: string } =>
    typeof search.t === "string" && search.t.length > 0 ? { t: search.t } : {},
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
  const { t } = Route.useSearch();
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

  const onAnswered = () => navigate({ to: "/pending" });

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

  return <PageContainer size="medium">{content}</PageContainer>;
}

/** The refusal page: what the link was, why it does not open, and that nothing was answered. */
function Refusal({ title, message }: { title: string; message: string }) {
  return (
    <Empty className="mx-auto h-full max-w-md rounded-lg border px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DangerousIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message} Nothing has been approved or declined.</EmptyDescription>
      </EmptyHeader>
      <Button variant="outline" nativeButton={false} render={<Link to="/pending" />}>
        See every pending action
      </Button>
    </Empty>
  );
}
