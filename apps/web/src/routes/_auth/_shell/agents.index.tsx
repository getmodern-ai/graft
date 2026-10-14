import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AgentCards } from "@/components/agent/agent-cards";
import { CreateAgentDialog } from "@/components/agent/create-agent-dialog";
import { AddIcon } from "@/components/icons";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Button } from "@/components/ui/button";
import { agentsQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { setupQuery } from "@/lib/setup-queries";

/**
 * The loader *starts* the reads and awaits none, so the screen paints at once — header and
 * skeleton cards — and fills when the agents arrive; a hover on the sidebar link has usually run
 * it already (`defaultPreload: "intent"`), so the cards are there on click. Awaiting would hand the
 * wait to the router's whole-screen spinner and leave the cards' own pending state unreachable
 * (Cando's CAN-546 makes the same call for its detail page). The connections draw each card's
 * "Can use" marks and are the create dialog's scope, which holds Create until they arrive
 * (`create-agent-dialog.tsx`); the open asks are each card's request count, the same list the
 * sidebar's count reads.
 */
export const Route = createFileRoute("/_auth/_shell/agents/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(agentsQuery);
    void context.queryClient.prefetchQuery(connectionsQuery);
    void context.queryClient.prefetchQuery(pendingActionsQuery);
  },
  component: AgentsRoute,
});

function AgentsRoute() {
  // `useQuery`, not the suspense form: the cards draw their own pending and failed states, and a
  // refetch that fails has to reach them as state rather than as a throw the route boundary would
  // swallow the whole screen for. The marks and request counts fill in when their reads land.
  const agents = useQuery(agentsQuery);
  const connections = useQuery(connectionsQuery);
  const pending = useQuery(pendingActionsQuery);
  // The shell's intercept read it already; a person who skipped is offered Setup again.
  const setup = useQuery(setupQuery);
  const [creating, setCreating] = useState(false);
  const rows = agents.data?.agents ?? [];

  useScreenTitle("Agents");

  return (
    <PageContainer size="large" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Agents</PageHeaderTitle>
          <PageHeaderDescription>
            Each agent that connects to Graft can use only the integrations you allow, and keeps its
            own tools ready.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button id="new-agent" onClick={() => setCreating(true)}>
            <AddIcon />
            Add an agent
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <AgentCards
        agents={rows}
        connections={connections.data?.connections ?? []}
        pendingActions={pending.data?.pendingActions ?? []}
        setup={setup.data}
        isPending={agents.isPending}
        isError={agents.isError}
        error={agents.error}
        retrying={agents.isFetching}
        onRetry={() => void agents.refetch()}
        onAdd={() => setCreating(true)}
        offerSetup={Boolean(setup.data?.setup?.skippedAt && !setup.data.setup.completedAt)}
      />

      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        connections={connections.data?.connections}
        connectionsFailed={
          connections.isError
            ? {
                error: connections.error,
                onRetry: () => void connections.refetch(),
                retrying: connections.isFetching,
              }
            : undefined
        }
      />
    </PageContainer>
  );
}
