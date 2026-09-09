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
import { pendingActionQuery } from "@/lib/pending-action-queries";

/**
 * Where a handoff URL lands (ADR 0006): `/pending/<id>?t=<token>`, the shape `@graft/mcp`'s
 * `handoff.ts` builds on GRA-23's branch. The server verifies the token against the row and answers
 * a verdict; a tampered, expired or already-used link is a refusal page that answers nothing, and the
 * action is shown only when the link is the one Graft issued for it. Without a token the page shows
 * the action to its signed-in owner — the list links here too.
 */
export const Route = createFileRoute("/_auth/_shell/pending/$id")({
  validateSearch: (search: Record<string, unknown>) => ({
    t: typeof search.t === "string" && search.t.length > 0 ? search.t : undefined,
  }),
  component: PendingActionRoute,
});

const REFUSAL_TITLE: Record<string, string> = {
  tampered: "This link is not one Graft issued",
  expired: "This link has expired",
  consumed: "This link was already used",
  answered: "This ask was already answered",
  not_found: "There is no such pending action",
};

function PendingActionRoute() {
  const { id } = Route.useParams();
  const { t } = Route.useSearch();
  const navigate = useNavigate();
  const { data, error, isPending } = useQuery(pendingActionQuery(id, t ?? null));

  if (isPending) return <Loader />;

  if (error || !data.ok) {
    const reason = data && !data.ok ? data.reason : null;
    const message =
      data && !data.ok
        ? data.message
        : error instanceof ApiError
          ? error.message
          : "Could not resolve this link.";
    return (
      <Empty className="mx-auto h-full max-w-md rounded-lg border px-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlertIcon />
          </EmptyMedia>
          <EmptyTitle>
            {(reason && REFUSAL_TITLE[reason]) ?? "This link cannot be opened"}
          </EmptyTitle>
          <EmptyDescription>{message} Nothing has been approved or declined.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" nativeButton={false} render={<Link to="/pending" />}>
          See every pending action
        </Button>
      </Empty>
    );
  }

  return (
    <>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/pending" />}>
          <ArrowLeftIcon />
          All pending actions
        </Button>
      </div>
      <PendingActionCard action={data.action} onAnswered={() => navigate({ to: "/pending" })} />
    </>
  );
}
