import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { InboxIcon } from "@/components/icons";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { PendingActionCard } from "@/components/pending/pending-action-card";
import { useScreenTitle } from "@/components/shell/screen-title";
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

  useScreenTitle("Pending actions");

  return (
    // `gap-4` between the header and a list, as Cando's connections screen passes.
    <PageContainer size="medium" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Pending actions</PageHeaderTitle>
          <PageHeaderDescription>
            Asks your agents could not settle on their own: a tool's first call that is not a read,
            every call of a tool you set to ask every time, an acquire against a connection, a
            connection to set up or a credential to re-enter.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {data.pendingActions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing is waiting on you</EmptyTitle>
            <EmptyDescription>
              Reads never ask, any other tool asks once and the answer holds, unless you set it to
              ask every time — when an agent does ask, it appears here.
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
    </PageContainer>
  );
}
