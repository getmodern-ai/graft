import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CreateAgentDialog } from "@/components/agent/create-agent-dialog";
import { AddIcon, SmartToyIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { agentsQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import { count } from "@/lib/format";

export const Route = createFileRoute("/_auth/_shell/agents/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentsQuery),
      context.queryClient.ensureQueryData(connectionsQuery),
    ]),
  component: AgentsRoute,
});

function AgentsRoute() {
  const { data } = useSuspenseQuery(agentsQuery);
  const { data: connectionData } = useSuspenseQuery(connectionsQuery);
  const [creating, setCreating] = useState(false);
  const agents = data.agents;

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each harness that connects to Graft is an agent, with a token, a scope and a working set of its own."
      >
        <Button onClick={() => setCreating(true)}>
          <AddIcon />
          New agent
        </Button>
      </PageHeader>

      {agents.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SmartToyIcon />
            </EmptyMedia>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              Create one to get a token and the block to paste into your harness's MCP
              configuration.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setCreating(true)}>
            <AddIcon />
            New agent
          </Button>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Cap</TableHead>
                <TableHead>Idle window</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <Link
                      to="/agents/$agentId"
                      params={{ agentId: agent.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {agent.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
                  </TableCell>
                  <TableCell>{count(agent.workingSetCap, "tool")}</TableCell>
                  <TableCell>{count(agent.idleWindowDays, "day")}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <Time iso={agent.createdAt} />
                  </TableCell>
                  <TableCell>
                    {agent.revokedAt ? (
                      <Badge variant="destructive">revoked</Badge>
                    ) : (
                      <Badge variant="success">active</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        connections={connectionData.connections}
      />
    </>
  );
}
