import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AgentAdvanced } from "@/components/agent/agent-advanced";
import { AgentHeader } from "@/components/agent/agent-header";
import { AgentIntegrationsPanel } from "@/components/agent/agent-integrations-panel";
import { AgentRecentActivity } from "@/components/agent/agent-recent-activity";
import { AgentStats } from "@/components/agent/agent-stats";
import { ApprovalsCard } from "@/components/agent/approvals-card";
import { BuildApprovalsCard } from "@/components/agent/build-approvals-card";
import { IntegrationApprovalsCard } from "@/components/agent/integration-approvals-card";
import { WorkingSetHistory } from "@/components/agent/working-set-history";
import { WorkingSetTable } from "@/components/agent/working-set-table";
import { PageBreadcrumb } from "@/components/page/page-breadcrumb";
import { PageContainer } from "@/components/page/page-container";
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
 * The loader awaits the agent and the connections, which the header and the integrations panel
 * need before anything can draw, and only *starts* the other reads: each card, figure and list
 * owns its query and paints its own pending state until it lands, so the page appears once rather
 * than after the slowest. Cando's automation page arrived at the same split (its CAN-546).
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

  useScreenTitle(agent.name);

  return (
    <PageContainer size="large" className="gap-6">
      {/* The breadcrumb's parent half is the way back to the list, 12px over the header (Figma
          2047:7614), inside the page's gap-6. */}
      <div className="flex flex-col gap-3">
        <PageBreadcrumb parentLabel="Agents" parentTo="/agents">
          {agent.name}
        </PageBreadcrumb>
        <AgentHeader agent={agent} />
      </div>
      <AgentStats agent={agent} connectionIds={connectionIds} />

      {/* Two columns (Figma 2047:8070): the integrations panel (GRA-326) on the left; on the
          right the recent activity (GRA-325) above Advanced (GRA-326). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AgentIntegrationsPanel
          agent={agent}
          connectionIds={connectionIds}
          connections={connectionData.connections}
        />
        <div className="flex min-w-0 flex-col gap-8">
          <AgentRecentActivity agent={agent} />
          <AgentAdvanced agent={agent} />
        </div>
      </div>

      {/* What the design leaves off the page and ADR 0008 has the console answer: every tool,
          integration and build approval this agent holds, and its working set (GRA-326). */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading font-medium text-lg">Answers and tools</h2>
          <p className="text-muted-foreground text-sm">
            What you have said yes or no to for {agent.name}, and the tools it keeps ready.
          </p>
        </div>
        <ApprovalsCard agent={agent} />
        <IntegrationApprovalsCard agent={agent} />
        <BuildApprovalsCard agent={agent} />
        <WorkingSetTable agent={agent} />
        <WorkingSetHistory agentId={agent.id} />
      </section>
    </PageContainer>
  );
}
