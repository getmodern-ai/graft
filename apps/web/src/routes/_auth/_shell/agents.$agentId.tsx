import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ApprovalsCard } from "@/components/agent/approvals-card";
import { HarnessSnippet } from "@/components/agent/harness-snippet";
import { LimitsForm } from "@/components/agent/limits-form";
import { RevokeAgentDialog } from "@/components/agent/revoke-agent-dialog";
import { ScopeEditor } from "@/components/agent/scope-editor";
import { WorkingSetHistory } from "@/components/agent/working-set-history";
import { WorkingSetTable } from "@/components/agent/working-set-table";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { PageNavBreadcrumb } from "@/components/page/page-nav-breadcrumb";
import { useScreenTitle } from "@/components/shell/screen-title";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { agentQuery, workingSetChangesQuery, workingSetQuery } from "@/lib/agent-queries";
import { approvalsQuery } from "@/lib/approval-queries";
import { connectionsQuery, toolsQuery } from "@/lib/connection-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * One agent: how to connect it, what it may reach, how its working set contracts, and what is in
 * the set and how it got there. The token is not on this page — `HarnessSnippet` says why.
 *
 * The loader awaits the agent and the connections, which the header and the two editors need
 * before anything can draw, and only *starts* the three table reads: each table owns its query
 * and paints skeleton rows until it lands, so the page appears once rather than after the slowest
 * of six. Cando's automation page arrived at the same split (its CAN-546).
 */
export const Route = createFileRoute("/_auth/_shell/agents/$agentId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(workingSetQuery(params.agentId));
    void context.queryClient.prefetchQuery(workingSetChangesQuery(params.agentId));
    void context.queryClient.prefetchQuery(approvalsQuery(params.agentId));
    void context.queryClient.prefetchQuery(toolsQuery);
    return Promise.all([
      context.queryClient.ensureQueryData(agentQuery(params.agentId)),
      context.queryClient.ensureQueryData(connectionsQuery),
    ]);
  },
  component: AgentRoute,
});

function AgentRoute() {
  const { agentId } = Route.useParams();
  const { data } = useSuspenseQuery(agentQuery(agentId));
  const { data: connectionData } = useSuspenseQuery(connectionsQuery);
  const [revoking, setRevoking] = useState(false);
  const { agent, connectionIds } = data;

  // The breadcrumb's parent half is the way back to the list; the on-page `PageHeaderTitle` below
  // repeats the name at every width, as the page's own heading rather than as this breadcrumb.
  useScreenTitle(
    <PageNavBreadcrumb parentLabel="Agents" parentTo="/agents">
      {agent.name}
    </PageNavBreadcrumb>,
  );

  return (
    <PageContainer size="large" className="gap-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle className="flex items-center gap-2">
            {agent.name}
            <StatusChip chip={agentStatusChip(agent)} />
          </PageHeaderTitle>
          <PageHeaderDescription>
            Token <code className="font-mono">{agent.tokenPrefix}…</code> · created{" "}
            <Time iso={agent.createdAt} />
            {agent.revokedAt ? (
              <>
                {" "}
                · revoked <Time iso={agent.revokedAt} />
              </>
            ) : null}
          </PageHeaderDescription>
        </PageHeaderContent>
        {agent.revokedAt ? null : (
          <PageHeaderActions>
            <Button variant="destructive" onClick={() => setRevoking(true)}>
              Revoke token
            </Button>
          </PageHeaderActions>
        )}
      </PageHeader>

      {/* `grid-cols-1` at every width, not only `lg:grid-cols-2`: an implicit grid track is `auto`,
          sized to its content's max-content width, and below `lg` the harness snippet's `<pre>`
          made the one track wider than a 390px viewport — the whole column overflowed, with
          "Revoke token" off the right edge. `minmax(0, 1fr)`, which `grid-cols-1` expands to, is
          what lets the track shrink and the `<pre>` scroll inside it. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          {agent.revokedAt ? null : <HarnessSnippet agent={agent} />}
          <ScopeEditor
            key={connectionIds.join(",")}
            agent={agent}
            connectionIds={connectionIds}
            connections={connectionData.connections}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <LimitsForm
            key={`${agent.name}:${agent.workingSetCap}:${agent.idleWindowDays}`}
            agent={agent}
          />
        </div>
      </div>

      <WorkingSetTable agent={agent} />
      <ApprovalsCard agent={agent} />
      <WorkingSetHistory agentId={agent.id} />

      <RevokeAgentDialog agent={agent} open={revoking} onOpenChange={setRevoking} />
    </PageContainer>
  );
}
