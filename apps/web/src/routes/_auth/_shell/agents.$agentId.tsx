import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApprovalsCard } from "@/components/agent/approvals-card";
import { HarnessSnippet } from "@/components/agent/harness-snippet";
import { LimitsForm } from "@/components/agent/limits-form";
import { RevokeAgentDialog } from "@/components/agent/revoke-agent-dialog";
import { ScopeEditor } from "@/components/agent/scope-editor";
import { WorkingSetHistory } from "@/components/agent/working-set-history";
import { WorkingSetTable } from "@/components/agent/working-set-table";
import { ArrowBackIcon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentQuery, workingSetChangesQuery, workingSetQuery } from "@/lib/agent-queries";
import { approvalsQuery } from "@/lib/approval-queries";
import { connectionsQuery, toolsQuery } from "@/lib/connection-queries";

/**
 * One agent: how to connect it, what it may reach, how its working set contracts, and what is in
 * the set and how it got there. The token is not on this page — `HarnessSnippet` says why.
 */
export const Route = createFileRoute("/_auth/_shell/agents/$agentId")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(agentQuery(params.agentId)),
      context.queryClient.ensureQueryData(connectionsQuery),
      context.queryClient.ensureQueryData(workingSetQuery(params.agentId)),
      context.queryClient.ensureQueryData(workingSetChangesQuery(params.agentId)),
      context.queryClient.ensureQueryData(approvalsQuery(params.agentId)),
      context.queryClient.ensureQueryData(toolsQuery),
    ]),
  component: AgentRoute,
});

function AgentRoute() {
  const { agentId } = Route.useParams();
  const { data } = useSuspenseQuery(agentQuery(agentId));
  const { data: connectionData } = useSuspenseQuery(connectionsQuery);
  const { data: workingSet } = useSuspenseQuery(workingSetQuery(agentId));
  const { data: history } = useSuspenseQuery(workingSetChangesQuery(agentId));
  const { data: approvals } = useSuspenseQuery(approvalsQuery(agentId));
  const { data: toolbox } = useSuspenseQuery(toolsQuery);
  const [revoking, setRevoking] = useState(false);
  const { agent, connectionIds } = data;

  return (
    <>
      <div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/agents" />}>
          <ArrowBackIcon />
          All agents
        </Button>
      </div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {agent.name}
            {agent.revokedAt ? (
              <Badge variant="destructive">revoked</Badge>
            ) : (
              <Badge variant="success">active</Badge>
            )}
          </span>
        }
        description={
          <>
            Token <code className="font-mono">{agent.tokenPrefix}…</code> · created{" "}
            <Time iso={agent.createdAt} />
            {agent.revokedAt ? (
              <>
                {" "}
                · revoked <Time iso={agent.revokedAt} />
              </>
            ) : null}
          </>
        }
      >
        {agent.revokedAt ? null : (
          <Button variant="destructive" onClick={() => setRevoking(true)}>
            Revoke token
          </Button>
        )}
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          {agent.revokedAt ? null : <HarnessSnippet agent={agent} />}
          <ScopeEditor
            key={connectionIds.join(",")}
            agent={agent}
            connectionIds={connectionIds}
            connections={connectionData.connections}
          />
        </div>
        <div className="flex flex-col gap-6">
          <LimitsForm
            key={`${agent.name}:${agent.workingSetCap}:${agent.idleWindowDays}`}
            agent={agent}
          />
        </div>
      </div>

      <WorkingSetTable agent={agent} entries={workingSet.workingSet} />
      <ApprovalsCard agent={agent} approvals={approvals.approvals} tools={toolbox.tools} />
      <WorkingSetHistory changes={history.changes} />

      <RevokeAgentDialog agent={agent} open={revoking} onOpenChange={setRevoking} />
    </>
  );
}
