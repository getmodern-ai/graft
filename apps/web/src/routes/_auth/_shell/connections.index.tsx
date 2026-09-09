import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlugIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { ConnectionCard } from "@/components/connection/connection-card";
import { PageHeader } from "@/components/page-header";
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

  return (
    <>
      <PageHeader
        title="Connections"
        description="One vendor account each: its scheme, the hosts it may reach, and whether a credential is set. Credentials are never shown."
      >
        <Button onClick={() => setAdding(true)}>
          <PlusIcon />
          Add connection
        </Button>
      </PageHeader>

      {data.connections.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugIcon />
            </EmptyMedia>
            <EmptyTitle>No connections yet</EmptyTitle>
            <EmptyDescription>
              An agent proposes a connection when it needs a vendor it cannot reach, and you enter
              the secret here — never in the chat. Or add one yourself and put it in an agent's
              scope.
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
    </>
  );
}
