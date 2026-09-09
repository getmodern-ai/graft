import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/** The open asks across every agent (ADR 0006: answerable later, from here). */
export const Route = createFileRoute("/_auth/_shell/pending/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(pendingActionsQuery),
  component: PendingRoute,
});

function PendingRoute() {
  const { data } = useSuspenseQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });

  return (
    <>
      <PageHeader
        title="Pending actions"
        description="Asks your agents could not settle on their own: a write's first call, every call of a destructive tool, an acquire against a connection."
      />

      {data.pendingActions.length === 0 ? (
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
          {data.pendingActions.map((action) => (
            <PendingActionCard key={action.id} action={action} />
          ))}
        </div>
      )}
    </>
  );
}
