import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { Loader } from "@/components/loader";
import { PageHeader } from "@/components/page-header";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ApiError } from "@/lib/api";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * The open asks across every agent (ADR 0006: answerable later, from here). Read with `useQuery`
 * rather than a loader on purpose: until GRA-23's endpoint lands the list is a 404, and a screen
 * that says so beats an error boundary.
 */
export const Route = createFileRoute("/_auth/_shell/pending/")({
  component: PendingRoute,
});

function PendingRoute() {
  const { data, error, isPending } = useQuery(pendingActionsQuery);

  return (
    <>
      <PageHeader
        title="Pending actions"
        description="Asks your agents could not settle on their own: a write's first call, every call of a destructive tool, an acquire against a connection."
      />

      {isPending ? (
        <Loader />
      ) : error ? (
        <Alert>
          <InboxIcon />
          <AlertTitle>
            {error instanceof ApiError && error.status === 404
              ? "Pending actions are not wired yet"
              : "Could not load pending actions"}
          </AlertTitle>
          <AlertDescription>
            {error instanceof ApiError && error.status === 404
              ? "The approval endpoints arrive with GRA-23; this page reads them as soon as they exist."
              : error.message}
          </AlertDescription>
        </Alert>
      ) : data.actions.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing is waiting on you</EmptyTitle>
            <EmptyDescription>
              Reads never ask. A write asks once, a destructive tool asks every time until you relax
              it. When an agent asks, it appears here and the link it relayed opens it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.actions.map((action) => (
            <PendingActionCard key={action.id} action={action} />
          ))}
        </div>
      )}
    </>
  );
}
