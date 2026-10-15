import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PowerIcon } from "@/components/icons";
import { ActivityTab } from "@/components/integration/activity-tab";
import { AgentsTab } from "@/components/integration/agents-tab";
import { ConnectionTab } from "@/components/integration/connection-tab";
import { IntegrationHeader } from "@/components/integration/integration-header";
import { IntegrationTabs } from "@/components/integration/integration-tabs";
import { ToolsTab } from "@/components/integration/tools-tab";
import { PageBreadcrumb } from "@/components/page/page-breadcrumb";
import { PageContainer } from "@/components/page/page-container";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { connectionsQuery, toolsQuery } from "@/lib/connection-queries";
import { readActivityFilters } from "@/lib/integration-activity";
import {
  DEFAULT_INTEGRATION_TAB,
  integrationPageOf,
  readIntegrationSearch,
} from "@/lib/integration-page";
import { integrationsQuery, integrationToolsQuery } from "@/lib/integration-queries";

/**
 * One integration's page (GRA-315; GRA-287 item 1: one page per integration, listing its
 * connections). Its live connections come from the integrations read (GRA-291), its revoked ones
 * from the connections read, and its tool counts from the integration's tools read (GRA-293), the
 * Tools tab's own, so the header, the badge and the rows count one list (GRA-345);
 * `lib/integration-page.ts` decides the page from the three. The open tab is `?tab=`, so every tab
 * is a deep link. Tools, Agents and Activity are filled by GRA-317, GRA-318 and GRA-319.
 */
export const Route = createFileRoute("/_auth/_shell/integrations/$vendor")({
  // The Activity tab's filters ride beside `tab` (GRA-319); `readActivityFilters` reads them only there.
  validateSearch: (search: Record<string, unknown>) => ({
    ...readIntegrationSearch(search),
    ...readActivityFilters(search),
  }),
  loader: ({ context, params }) => {
    // Not awaited: the Tools tab owns this read's failure, and the header counts off the
    // integrations row until it lands.
    void context.queryClient.prefetchQuery(integrationToolsQuery(params.vendor));
    // Awaited: the Tools tab words a tool's origin off the toolbox's versions, and a guess drawn
    // before it lands would be taken back (Greptile on #280).
    return Promise.all([
      context.queryClient.ensureQueryData(integrationsQuery),
      context.queryClient.ensureQueryData(connectionsQuery),
      context.queryClient.ensureQueryData(toolsQuery),
    ]);
  },
  component: IntegrationRoute,
});

function IntegrationRoute() {
  const { vendor } = Route.useParams();
  const { tab = DEFAULT_INTEGRATION_TAB, agent, outcome } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: integrationData } = useSuspenseQuery(integrationsQuery);
  const { data: connectionData } = useSuspenseQuery(connectionsQuery);
  const { data: offered } = useQuery(integrationToolsQuery(vendor));
  const page = integrationPageOf(
    vendor,
    integrationData.integrations,
    connectionData.connections,
    offered?.tools,
  );
  const name = page.kind === "integration" ? page.displayName : vendor;

  useScreenTitle(name);
  // Above the header on every branch, the missing one included: it is the way back to the list.
  const breadcrumb = (
    <PageBreadcrumb parentLabel="Integrations" parentTo="/integrations">
      {name}
    </PageBreadcrumb>
  );

  if (page.kind === "missing") {
    return (
      <PageContainer size="large" className="gap-6">
        {breadcrumb}
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PowerIcon />
            </EmptyMedia>
            <EmptyTitle>Not connected</EmptyTitle>
            <EmptyDescription>
              You have no connection to {vendor}. An agent asks when it needs one, or you can add it
              yourself.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" nativeButton={false} render={<Link to="/connections" />}>
              Open connections
            </Button>
          </EmptyContent>
        </Empty>
      </PageContainer>
    );
  }

  return (
    // `large`, with `gap-6` for a detail screen of several regions (AGENTS.md, *Screens follow
    // Cando's patterns*): the Connection tab is two columns, as the agent page's editors are.
    <PageContainer size="large" className="gap-6">
      {/* The breadcrumb sits 12px over the header (Figma 2044:7001), inside the page's gap-6. */}
      <div className="flex flex-col gap-3">
        {breadcrumb}
        <IntegrationHeader page={page} />
      </div>
      <IntegrationTabs
        vendor={page.vendor}
        current={tab}
        counts={{ tools: page.toolCount ?? undefined, agents: page.agentCount }}
      />
      {tab === "connection" ? (
        <ConnectionTab connections={page.connections} integrationName={page.displayName} />
      ) : tab === "agents" ? (
        <AgentsTab
          vendor={page.vendor}
          integrationName={page.displayName}
          connections={page.connections.filter((connection) => connection.state !== "revoked")}
        />
      ) : tab === "tools" ? (
        <ToolsTab
          vendor={page.vendor}
          integrationName={page.displayName}
          connections={page.connections}
        />
      ) : (
        <ActivityTab
          vendor={page.vendor}
          integrationName={page.displayName}
          filters={{ agent, outcome }}
          onFiltersChange={(next) =>
            void navigate({
              search: { tab: "activity", agent: next.agent, outcome: next.outcome },
              replace: true,
            })
          }
        />
      )}
    </PageContainer>
  );
}
