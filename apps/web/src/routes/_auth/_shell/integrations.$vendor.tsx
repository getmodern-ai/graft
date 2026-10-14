import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PowerIcon } from "@/components/icons";
import { ActivityTab } from "@/components/integration/activity-tab";
import { AgentsTab } from "@/components/integration/agents-tab";
import { ConnectionTab } from "@/components/integration/connection-tab";
import { IntegrationHeader } from "@/components/integration/integration-header";
import { IntegrationTabs } from "@/components/integration/integration-tabs";
import { PageContainer } from "@/components/page/page-container";
import { PageNavBreadcrumb } from "@/components/page/page-nav-breadcrumb";
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
  type IntegrationTab,
  integrationPageOf,
  readIntegrationSearch,
} from "@/lib/integration-page";
import { integrationsQuery } from "@/lib/integration-queries";

/**
 * One integration's page (GRA-315; GRA-287 item 1: one page per integration, listing its
 * connections). Its live connections come from the integrations read (GRA-291), its revoked ones
 * from the connections read, and the tool count of a vendor with nothing live from the toolbox;
 * `lib/integration-page.ts` decides the page from the three. The open tab is `?tab=`, so every tab
 * is a deep link. Tools, Agents and Activity are filled by GRA-317, GRA-318 and GRA-319.
 */
export const Route = createFileRoute("/_auth/_shell/integrations/$vendor")({
  // The Activity tab's filters ride beside `tab` (GRA-319); `readActivityFilters` reads them only there.
  validateSearch: (search: Record<string, unknown>) => ({
    ...readIntegrationSearch(search),
    ...readActivityFilters(search),
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(integrationsQuery),
      context.queryClient.ensureQueryData(connectionsQuery),
      context.queryClient.ensureQueryData(toolsQuery),
    ]),
  component: IntegrationRoute,
});

const PLACEHOLDERS: Record<Exclude<IntegrationTab, "connection">, (name: string) => string> = {
  tools: (name) => `The tools your agents use with ${name} will be listed here.`,
  agents: (name) => `Which agents can use ${name}, and what each may run without asking.`,
  activity: (name) => `Every call your agents made to ${name} will be listed here.`,
};

function IntegrationRoute() {
  const { vendor } = Route.useParams();
  const { tab = DEFAULT_INTEGRATION_TAB, agent, outcome } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: integrationData } = useSuspenseQuery(integrationsQuery);
  const { data: connectionData } = useSuspenseQuery(connectionsQuery);
  const { data: toolData } = useSuspenseQuery(toolsQuery);
  const page = integrationPageOf(
    vendor,
    integrationData.integrations,
    connectionData.connections,
    toolData.tools,
  );
  const name = page.kind === "integration" ? page.displayName : vendor;

  useScreenTitle(
    <PageNavBreadcrumb parentLabel="Integrations" parentTo="/integrations">
      {name}
    </PageNavBreadcrumb>,
  );

  if (page.kind === "missing") {
    return (
      <PageContainer size="large">
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
      <IntegrationHeader page={page} />
      <IntegrationTabs
        vendor={page.vendor}
        current={tab}
        counts={{ tools: page.toolCount, agents: page.agentCount }}
      />
      {tab === "connection" ? (
        <ConnectionTab connections={page.connections} integrationName={page.displayName} />
      ) : tab === "agents" ? (
        <AgentsTab
          vendor={page.vendor}
          integrationName={page.displayName}
          connections={page.connections.filter((connection) => connection.state !== "revoked")}
        />
      ) : tab === "activity" ? (
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
      ) : (
        <p className="text-muted-foreground text-sm">{PLACEHOLDERS[tab](page.displayName)}</p>
      )}
    </PageContainer>
  );
}
