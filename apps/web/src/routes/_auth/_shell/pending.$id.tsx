import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ShieldAlertIcon } from "lucide-react";

import { Loader } from "@/components/loader";
import { PendingActionCard } from "@/components/pending/pending-action-card";
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
  type PendingAction,
  pendingActionQuery,
  pendingActionsQuery,
} from "@/lib/pending-action-queries";

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

  if (t !== undefined) {
    if (byLink.isPending) return <Loader />;
    if (byLink.error) return <Refusal {...handoffRefusal(byLink.error)} />;
    return (
      <Selected
        action={byLink.data.pendingAction}
        onAnswered={() => navigate({ to: "/pending" })}
      />
    );
  }

  if (fromList.isPending) return <Loader />;
  const action = fromList.data?.pendingActions.find((candidate) => candidate.id === id);
  if (!action) {
    return (
      <Refusal
        title="This ask is no longer open"
        message="It was answered, expired, or belongs to another account."
      />
    );
  }
  return <Selected action={action} onAnswered={() => navigate({ to: "/pending" })} />;
}

function Selected({ action, onAnswered }: { action: PendingAction; onAnswered: () => void }) {
  return (
    <>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/pending" />}>
          <ArrowLeftIcon />
          All pending actions
        </Button>
      </div>
      <PendingActionCard action={action} onAnswered={onAnswered} />
    </>
  );
}

/** The refusal page: what the link was, why it does not open, and that nothing was answered. */
function Refusal({ title, message }: { title: string; message: string }) {
  return (
    <Empty className="mx-auto h-full max-w-md rounded-lg border px-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldAlertIcon />
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
