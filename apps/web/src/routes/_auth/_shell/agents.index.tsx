import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AgentsTable } from "@/components/agent/agents-table";
import { CreateAgentDialog } from "@/components/agent/create-agent-dialog";
import { AddIcon, SmartToyIcon } from "@/components/icons";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { agentListQuery, agentsQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";

/**
 * The loader *starts* both reads and awaits neither, so the screen paints at once — header, table
 * header, skeleton rows — and fills when the agents arrive; a hover on the sidebar link has
 * usually run it already (`defaultPreload: "intent"`), so the rows are there on click. Awaiting
 * would hand the wait to the router's whole-screen spinner and leave the table's own pending rows
 * unreachable, which is the state the design draws for this (Cando's CAN-546 makes the same call
 * for its detail page). The connections are the create dialog's, which draws its scope as
 * skeleton rows and holds Create until they arrive (`create-agent-dialog.tsx`).
 */
export const Route = createFileRoute("/_auth/_shell/agents/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(agentsQuery);
    void context.queryClient.prefetchQuery(connectionsQuery);
  },
  component: AgentsRoute,
});

function AgentsRoute() {
  // `useQuery`, not the suspense form: the table draws its own pending and failed rows, and a
  // refetch that fails has to reach it as state rather than as a throw the route boundary would
  // swallow the whole screen for.
  const [showArchived, setShowArchived] = useState(false);
  const agents = useQuery(agentListQuery(showArchived));
  const connections = useQuery(connectionsQuery);
  const [creating, setCreating] = useState(false);
  const rows = agents.data?.agents ?? [];

  useScreenTitle("Agents");

  return (
    // `large`: the table is the screen, and a table wants the column. `gap-4` between the header
    // and a list, as Cando's connections screen passes; the detail screens keep `gap-6`.
    <PageContainer size="large" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Agents</PageHeaderTitle>
          <PageHeaderDescription>
            Each harness that connects to Graft is an agent, with a token, a scope and a working set
            of its own.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Field orientation="horizontal">
            <Checkbox
              id="show-archived-agents"
              checked={showArchived}
              onCheckedChange={setShowArchived}
            />
            <FieldLabel htmlFor="show-archived-agents">Show archived</FieldLabel>
          </Field>
          <Button onClick={() => setCreating(true)}>
            <AddIcon />
            New agent
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {agents.isSuccess && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SmartToyIcon />
            </EmptyMedia>
            <EmptyTitle>No agents to show</EmptyTitle>
            <EmptyDescription>
              {showArchived
                ? "Create one to connect your harness — a name is all it takes."
                : "Create an agent or turn on Show archived to view past agents."}
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setCreating(true)}>
            <AddIcon />
            New agent
          </Button>
        </Empty>
      ) : (
        <AgentsTable
          agents={rows}
          isPending={agents.isPending}
          isError={agents.isError}
          error={agents.error}
          retrying={agents.isFetching}
          onRetry={() => void agents.refetch()}
        />
      )}

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
