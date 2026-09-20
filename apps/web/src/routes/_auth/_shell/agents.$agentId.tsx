import { createFileRoute } from "@tanstack/react-router";

import { AgentDetailsDrawer } from "@/components/agent/agent-details-drawer";
import { agentQuery, workingSetChangesQuery, workingSetQuery } from "@/lib/agent-queries";
import { approvalsQuery } from "@/lib/approval-queries";
import { toolsQuery } from "@/lib/connection-queries";

/** The list stays mounted behind the drawer, including on a direct link (ADR 0017). */
export const Route = createFileRoute("/_auth/_shell/agents/$agentId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(agentQuery(params.agentId));
    void context.queryClient.prefetchQuery(workingSetQuery(params.agentId));
    void context.queryClient.prefetchQuery(workingSetChangesQuery(params.agentId));
    void context.queryClient.prefetchQuery(approvalsQuery(params.agentId));
    void context.queryClient.prefetchQuery(toolsQuery);
  },
  component: AgentRoute,
});

function AgentRoute() {
  const { agentId } = Route.useParams();
  const navigate = Route.useNavigate();

  return (
    <AgentDetailsDrawer
      key={agentId}
      agentId={agentId}
      onClose={() => void navigate({ to: "/agents", replace: true })}
    />
  );
}
