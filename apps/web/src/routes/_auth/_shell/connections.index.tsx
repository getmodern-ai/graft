import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { ConnectionCard } from "@/components/connection/connection-card";
import { AddIcon, PowerIcon } from "@/components/icons";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { connectionsQuery, toolsOfConnection, toolsQuery } from "@/lib/connection-queries";

/**
 * The person's connections (ADR 0007: entered once, however many agents). Listing, adding one with
 * its credential, re-entering a credential and revoking are here; the usual way a connection
 * arrives is the handoff an agent's `request_connection` returns, answered under `/pending`
 * (GRA-28), and Add connection is the same form with no ask behind it.
 */
export const Route = createFileRoute("/_auth/_shell/connections/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(connectionsQuery),
      context.queryClient.ensureQueryData(toolsQuery),
    ]),
  component: ConnectionsRoute,
});

function ConnectionsRoute() {
  const { data } = useSuspenseQuery(connectionsQuery);
  const { data: toolData } = useSuspenseQuery(toolsQuery);
  const [adding, setAdding] = useState(false);

  useScreenTitle("Connections");

  return (
    // `medium`: a stack of cards reads at 896 where a table would want the wider column. `gap-4`
    // between the header and a list, as Cando's connections screen passes.
    <PageContainer size="medium" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Connections</PageHeaderTitle>
          <PageHeaderDescription>
            One vendor account each: its scheme, the hosts it may reach, and whether a credential is
            set. Credentials are never shown.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button onClick={() => setAdding(true)}>
            <AddIcon />
            Add connection
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {data.connections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PowerIcon />
            </EmptyMedia>
            <EmptyTitle>No connections yet</EmptyTitle>
            <EmptyDescription>
              An agent proposes one when it needs a vendor it cannot reach, and you enter the secret
              here — never through the agent.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              tools={toolsOfConnection(toolData.tools, connection)}
            />
          ))}
        </div>
      )}

      <AddConnectionDialog open={adding} onOpenChange={setAdding} />
    </PageContainer>
  );
}
