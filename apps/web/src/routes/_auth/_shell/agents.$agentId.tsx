import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AgentHeader } from "@/components/agent/agent-header";
import { AgentRecentActivity } from "@/components/agent/agent-recent-activity";
import { AgentStats } from "@/components/agent/agent-stats";
import { ApprovalsCard } from "@/components/agent/approvals-card";
import { BuildApprovalsCard } from "@/components/agent/build-approvals-card";
import { IntegrationApprovalsCard } from "@/components/agent/integration-approvals-card";
import { LimitsForm } from "@/components/agent/limits-form";
import { ScopeEditor } from "@/components/agent/scope-editor";
import { WorkingSetHistory } from "@/components/agent/working-set-history";
import { WorkingSetTable } from "@/components/agent/working-set-table";
import { PageContainer } from "@/components/page/page-container";
import { PageNavBreadcrumb } from "@/components/page/page-nav-breadcrumb";
import { useScreenTitle } from "@/components/shell/screen-title";
import { agentRecentActivityQuery, agentStatsQuery } from "@/lib/agent-page";
import { agentQuery, workingSetChangesQuery, workingSetQuery } from "@/lib/agent-queries";
import { approvalsQuery, vendorApprovalsQuery } from "@/lib/approval-queries";
import { connectionsQuery, toolsQuery } from "@/lib/connection-queries";
import { integrationsQuery } from "@/lib/integration-queries";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * The standalone management page opens from the agent name or View agent action (GRA-135).
 * Removing the drawer must not remove scope, approval and history access (ADR 0007, ADR 0008).
 *
 * The loader awaits the agent and the connections, which the header and the two editors need
 * before anything can draw, and only *starts* the other reads: each table, figure and list owns
 * its query and paints its own pending state until it lands, so the page appears once rather than
 * after the slowest. Cando's automation page arrived at the same split (its CAN-546).
 */
export const Route = createFileRoute("/_auth/_shell/agents/$agentId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(workingSetQuery(params.agentId));
    void context.queryClient.prefetchQuery(workingSetChangesQuery(params.agentId));
    void context.queryClient.prefetchQuery(approvalsQuery(params.agentId));
    void context.queryClient.prefetchQuery(vendorApprovalsQuery(params.agentId));
    void context.queryClient.prefetchQuery(toolsQuery);
    void context.queryClient.prefetchQuery(agentStatsQuery(params.agentId));
    void context.queryClient.prefetchQuery(agentRecentActivityQuery(params.agentId));
    void context.queryClient.prefetchQuery(pendingActionsQuery);
    void context.queryClient.prefetchQuery(integrationsQuery);
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
  const { agent, connectionIds } = data;

  // The breadcrumb's parent half is the way back to the list; the header's own title repeats the
  // name at every width, as the page's heading rather than as this breadcrumb.
  useScreenTitle(
    <PageNavBreadcrumb parentLabel="Agents" parentTo="/agents">
      {agent.name}
    </PageNavBreadcrumb>,
  );

  return (
    <PageContainer size="large" className="gap-6">
      <AgentHeader agent={agent} />
      <AgentStats agent={agent} connectionIds={connectionIds} />

      {/* Two columns (Figma 2047:8070), each slot a column of its own: the main one is the
          integrations panel's (GRA-326) above the tables, the side one the recent activity
          (GRA-325) above Advanced (GRA-326), so each ticket changes its own slot. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div data-slot="agent-main" className="flex min-w-0 flex-col gap-6">
          <ScopeEditor
            key={`${agent.scopeMode}:${connectionIds.join(",")}`}
            agent={agent}
            connectionIds={connectionIds}
            connections={connectionData.connections}
          />
          <WorkingSetTable agent={agent} />
          <ApprovalsCard agent={agent} />
          <IntegrationApprovalsCard agent={agent} />
          <BuildApprovalsCard agent={agent} />
          <WorkingSetHistory agentId={agent.id} />
        </div>
        <div data-slot="agent-side" className="flex min-w-0 flex-col gap-8">
          <AgentRecentActivity agent={agent} />
          <LimitsForm
            key={`${agent.name}:${agent.workingSetCap}:${agent.idleWindowDays}`}
            agent={agent}
          />
        </div>
      </div>
    </PageContainer>
  );
}
