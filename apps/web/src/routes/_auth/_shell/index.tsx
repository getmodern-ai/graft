import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { ActivityPanel } from "@/components/home/activity-panel";
import { AgentsPanel } from "@/components/home/agents-panel";
import { GetStartedPanel, HomeCreateAgentDialog } from "@/components/home/get-started-panel";
import { GoodFirstPanel } from "@/components/home/good-first-panel";
import { IntegrationsPanel } from "@/components/home/integrations-panel";
import { NeedsYouPanel } from "@/components/home/needs-you-panel";
import { SuggestedPanel } from "@/components/home/suggested-panel";
import { WhatYouSeePanel } from "@/components/home/what-you-see-panel";
import { AddIcon } from "@/components/icons";
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
import { agentsQuery } from "@/lib/agent-queries";
import { homeActivityQuery } from "@/lib/home";
import { homeChecklist, homeView } from "@/lib/home-checklist";
import { homeGreeting, welcomeGreeting } from "@/lib/home-greeting";
import { integrationsQuery, suggestedIntegrationsQuery } from "@/lib/integration-queries";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { sessionQuery } from "@/lib/session-queries";

/**
 * Home, at `/`, where a signed-in person lands (`DEFAULT_SIGNED_IN_PATH`; GRA-327, Figma
 * 2040:5486): the greeting, then a panel per screen it summarises, each owning its read so one
 * that fails says so inside itself and leaves the rest standing (GRA-47). The loader starts the
 * reads and awaits none, so every panel paints its own pending rows (`agents.index.tsx`'s
 * reasoning).
 *
 * Until the person has done *Get started*'s three steps (GRA-328, Figma 2099:10107;
 * `lib/home-checklist.ts`'s `homeView`), the checklist leads: in place of the panels with none
 * done, above them with some.
 */
export const Route = createFileRoute("/_auth/_shell/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(pendingActionsQuery);
    void context.queryClient.prefetchQuery(agentsQuery);
    void context.queryClient.prefetchQuery(integrationsQuery);
    void context.queryClient.prefetchQuery(homeActivityQuery);
    void context.queryClient.prefetchQuery(suggestedIntegrationsQuery);
  },
  component: HomeRoute,
});

function HomeRoute() {
  useScreenTitle("Home");
  // The guard's cached read, so the name is there on the first paint rather than a beat after.
  const { data: session } = useQuery(sessionQuery);
  // GRA-328: *Get started* until its three steps are done, judged once both reads are in.
  const agents = useQuery(agentsQuery);
  const integrations = useQuery(integrationsQuery);
  const checklist =
    agents.data && integrations.data
      ? homeChecklist({
          agents: agents.data.agents,
          hasRunTool: agents.data.hasRunTool,
          integrations: integrations.data.integrations,
        })
      : null;
  const view = homeView(checklist);
  const integrationOpen = checklist?.steps.some((step) => step.id === "integration" && !step.done);

  // One create dialog for both views, mounted beside them rather than inside either: the agent it
  // creates is step one done, which can swap the view, and the token it shows once must outlive it.
  const [creating, setCreating] = useState(false);
  const openCreate = () => setCreating(true);

  const body =
    view === "start" && checklist ? (
      <PageContainer size="large" className="gap-8">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle className="text-2xl tracking-tight md:text-3xl">
              {welcomeGreeting(session?.user.name)}
            </PageHeaderTitle>
            <PageHeaderDescription className="md:text-lg">
              Graft gives your AI agents the tools they're missing, and asks you before anything
              changes.
            </PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        {/* The panels would each say they are empty; the frame shows what they will hold. */}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:gap-6">
          <GetStartedPanel checklist={checklist} onCreateAgent={openCreate} />
          <WhatYouSeePanel />
        </div>

        <GoodFirstPanel />
      </PageContainer>
    ) : (
      // `large`: the frame's 1120 column; `gap-8` is the frame's between the bands.
      <PageContainer size="large" className="gap-8">
        <PageHeader className="flex-wrap items-center gap-4">
          <PageHeaderContent>
            <PageHeaderTitle className="text-2xl tracking-tight md:text-3xl">
              {homeGreeting(new Date(), session?.user.name)}
            </PageHeaderTitle>
          </PageHeaderContent>
          <PageHeaderActions>
            <Button
              nativeButton={false}
              render={<Link to="/integrations" search={{ tab: "discover" }} />}
            >
              <AddIcon />
              Connect an integration
            </Button>
          </PageHeaderActions>
        </PageHeader>

        {view === "partial" && checklist ? (
          <>
            <GetStartedPanel checklist={checklist} emphasis={false} onCreateAgent={openCreate} />
            {integrationOpen ? <GoodFirstPanel /> : null}
          </>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:gap-6">
          <NeedsYouPanel />
          <AgentsPanel />
        </div>

        <div className="grid gap-8 lg:grid-cols-2 lg:gap-6">
          <IntegrationsPanel />
          <ActivityPanel />
        </div>

        <SuggestedPanel />
      </PageContainer>
    );

  return (
    <>
      {body}
      <HomeCreateAgentDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
