import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { InfoIcon } from "@/components/icons";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import {
  RequestList,
  RequestListLoading,
  RequestListNote,
  RequestRow,
} from "@/components/pending/request-row";
import { SignInRequestRow } from "@/components/pending/sign-in-request-row";
import { RetryNotice } from "@/components/retry-notice";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentsQuery } from "@/lib/agent-queries";
import { integrationsQuery } from "@/lib/integration-queries";
import { harnessMark } from "@/lib/marks";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { signInRequestsOf } from "@/lib/sign-in-requests";

/**
 * Requests (CONTEXT.md, *Request*; ADR 0006: answerable later, from here): the open asks across
 * every agent, one row each (GRA-310). The loader starts the reads and awaits neither, so the list
 * draws its own pending and failed rows (GRA-47); the agents are only for each row's harness mark,
 * which reads as the generic glyph until they land. The Done tab is GRA-312's, drawn disabled.
 * Above the asks, the connections that need the person to sign in (GRA-313), from the
 * integrations read: they join Open once it lands, and a failed read leaves the asks alone.
 */
export const Route = createFileRoute("/_auth/_shell/pending/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(pendingActionsQuery);
    void context.queryClient.prefetchQuery(agentsQuery);
    void context.queryClient.prefetchQuery(integrationsQuery);
  },
  component: RequestsRoute,
});

function RequestsRoute() {
  const requests = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const agents = useQuery(agentsQuery);
  const integrations = useQuery({ ...integrationsQuery, refetchInterval: 15_000 });
  const rows = requests.data?.pendingActions ?? [];
  const signIns = signInRequestsOf(integrations.data?.integrations ?? []);
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
      </PageHeader>

      <Tabs value="open" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-border border-b">
          <TabsTrigger value="open">
            Open
            {requests.data || signIns.length > 0 ? (
              <Badge variant="secondary">{rows.length + signIns.length}</Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="done" disabled>
            Done
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex flex-col gap-4 text-sm">
          <RequestList aria-label="Open requests" aria-busy={requests.isPending}>
            {/* Drawn whatever the asks' read is doing: the badge counts them, so a pending or
                failed asks read must not hide their Sign in. */}
            {signIns.map((request) => (
              <SignInRequestRow key={request.key} request={request} />
            ))}
            {requests.isPending ? (
              <RequestListLoading rows={signIns.length > 0 ? 1 : 3} />
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
            ) : rows.length + signIns.length === 0 ? (
              <RequestListNote>
                Nothing is waiting on you. When an agent needs an answer, it appears here.
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
      </Tabs>
    </PageContainer>
  );
}
