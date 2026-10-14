import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { InfoIcon } from "@/components/icons";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { AgentFilterMenu } from "@/components/pending/agent-filter-menu";
import { DoneRow } from "@/components/pending/done-row";
import {
  RequestList,
  RequestListLoading,
  RequestListNote,
  RequestRow,
} from "@/components/pending/request-row";
import { RetryNotice } from "@/components/retry-notice";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentsQuery } from "@/lib/agent-queries";
import { harnessMark } from "@/lib/marks";
import { donePendingActionsQuery, pendingActionsQuery } from "@/lib/pending-action-queries";
import {
  agentFilterOptions,
  filterAgentId,
  filterByAgent,
  type RequestsTab,
  readRequestsSearch,
  selectedAgent,
} from "@/lib/requests-filter";

/**
 * Requests (CONTEXT.md, *Request*; ADR 0006: answerable later, from here): the open asks across
 * every agent, one row each (GRA-310), and the finished ones under Done (GRA-312). The loader
 * starts the reads and awaits neither, so the list draws its own pending and failed rows (GRA-47);
 * the agents are for each row's harness mark, which reads as the generic glyph until they land, and
 * for the filter by agent. The tab and the agent live in the search (`?tab=done&agent=<id>`), so a
 * link from an agent's card lands filtered; the filter is client-side over each tab's rows, and
 * Done pages by "Show older".
 */
export const Route = createFileRoute("/_auth/_shell/pending/")({
  validateSearch: readRequestsSearch,
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(pendingActionsQuery);
    void context.queryClient.prefetchQuery(agentsQuery);
  },
  component: RequestsRoute,
});

function RequestsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: RequestsTab = search.tab ?? "open";
  const requests = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const done = useInfiniteQuery({ ...donePendingActionsQuery, enabled: tab === "done" });
  const agents = useQuery(agentsQuery);
  const allOpen = requests.data?.pendingActions ?? [];
  const options = agents.data ? agentFilterOptions(agents.data.agents, allOpen) : undefined;
  const selected = options ? selectedAgent(search.agent, options) : null;
  const agentId = filterAgentId(search.agent, options);
  const agentLabel = selected?.name ?? "this agent";
  const rows = filterByAgent(allOpen, agentId);
  const doneRows = filterByAgent(
    done.data?.pages.flatMap((page) => page.pendingActions) ?? [],
    agentId,
  );
  const activeAgents = new Set((options ?? []).map((option) => option.id));
  const harnessOf = new Map(
    (agents.data?.agents ?? []).map((agent) => [
      agent.id,
      harnessMark(agent.connectedVia?.clientName),
    ]),
  );

  useScreenTitle("Requests");

  return (
    <PageContainer size="large" className="gap-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Requests</PageHeaderTitle>
          <PageHeaderDescription>What your agents need from you.</PageHeaderDescription>
        </PageHeaderContent>
        {options && options.length > 0 ? (
          <AgentFilterMenu
            options={options}
            selected={selected}
            total={requests.data ? allOpen.length : null}
            counts={tab === "open" && requests.data !== undefined}
            onSelect={(agent) =>
              void navigate({
                search: (previous) => ({ ...previous, agent: agent ?? undefined }),
                replace: true,
              })
            }
          />
        ) : null}
      </PageHeader>

      <Tabs
        value={tab}
        onValueChange={(next: RequestsTab) =>
          void navigate({
            search: (previous) => ({ ...previous, tab: next === "done" ? "done" : undefined }),
          })
        }
        className="gap-6"
      >
        <TabsList variant="line" className="w-full justify-start border-border border-b">
          <TabsTrigger value="open">
            Open
            {requests.data ? <Badge variant="secondary">{rows.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="done">Done</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex flex-col gap-4 text-sm">
          <RequestList aria-label="Open requests" aria-busy={requests.isPending}>
            {requests.isPending ? (
              <RequestListLoading />
            ) : requests.isError && !requests.data ? (
              // Only a first read that failed replaces the rows: a failed background refetch keeps
              // them, and any dialog open on one with what the person typed (the toast says it).
              <RequestListNote>
                <RetryNotice
                  error={requests.error}
                  message="Your requests could not be loaded."
                  onRetry={() => void requests.refetch()}
                  retrying={requests.isFetching}
                />
              </RequestListNote>
            ) : rows.length === 0 ? (
              <RequestListNote>
                {agentId
                  ? `Nothing from ${agentLabel} is waiting on you.`
                  : "Nothing is waiting on you. When an agent needs an answer, it appears here."}
              </RequestListNote>
            ) : (
              rows.map((action) => (
                <RequestRow
                  key={action.id}
                  action={action}
                  harness={harnessOf.get(action.agentId) ?? "generic"}
                />
              ))
            )}
          </RequestList>

          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <InfoIcon className="size-4 shrink-0" />
            Allow lets you pick how much: every tool for that integration, or just that tool. Change
            it any time on the agent's page.
          </p>
        </TabsContent>

        <TabsContent value="done" className="flex flex-col gap-4 text-sm">
          <RequestList aria-label="Done requests" aria-busy={done.isPending}>
            {done.isPending ? (
              <RequestListLoading />
            ) : done.isError && !done.data ? (
              <RequestListNote>
                <RetryNotice
                  error={done.error}
                  message="Your finished requests could not be loaded."
                  onRetry={() => void done.refetch()}
                  retrying={done.isFetching}
                />
              </RequestListNote>
            ) : doneRows.length === 0 ? (
              <RequestListNote>
                {agentId && done.hasNextPage
                  ? `Nothing from ${agentLabel} in what is loaded. Show older to look further back.`
                  : agentId
                    ? `Nothing from ${agentLabel} has finished yet.`
                    : "Nothing has finished yet. Requests you answer, and ones that expire, appear here."}
              </RequestListNote>
            ) : (
              doneRows.map((card) => (
                <DoneRow
                  key={card.id}
                  card={card}
                  harness={harnessOf.get(card.agentId) ?? "generic"}
                  agentActive={activeAgents.has(card.agentId)}
                />
              ))
            )}
          </RequestList>
          {done.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              disabled={done.isFetchingNextPage}
              onClick={() => void done.fetchNextPage()}
            >
              {done.isFetchingNextPage ? "Loading" : "Show older"}
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
