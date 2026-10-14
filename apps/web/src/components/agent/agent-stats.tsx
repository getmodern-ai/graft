import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { ArrowForwardIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { Time } from "@/components/time";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentIntegrationsStat,
  agentRequestCount,
  agentStatsQuery,
  integrationsStatDetail,
  integrationsStatValue,
  lastActiveDetail,
  runsSplitLine,
} from "@/lib/agent-page";
import type { Agent } from "@/lib/agent-queries";
import { integrationsQuery } from "@/lib/integration-queries";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * The agent page's four figures (GRA-325; Figma 2047:8053): what waits on the person, the
 * integrations it can use, the week's runs split as GRA-286 defines it, and when it last ran
 * what. The run figures are `GET /api/agents/:id/stats`, which counts no meta-tool call and no dry
 * run. Each card owns its read and draws its own pending and failed states (GRA-47), so a slow
 * figure holds up none of the others.
 */
export function AgentStats({ agent, connectionIds }: { agent: Agent; connectionIds: string[] }) {
  const requests = useQuery(pendingActionsQuery);
  const integrations = useQuery(integrationsQuery);
  const stats = useQuery(agentStatsQuery(agent.id));
  const integrationStat = integrations.data
    ? agentIntegrationsStat(connectionIds, integrations.data.integrations)
    : null;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Waiting on you" query={requests}>
        {requests.data ? (
          <>
            <StatValue>{agentRequestCount(requests.data.pendingActions, agent.id)}</StatValue>
            <Link
              to="/pending"
              search={{ agent: agent.id }}
              className="inline-flex items-center gap-1 text-primary text-xs hover:underline"
            >
              See requests
              <ArrowForwardIcon className="size-3.5" />
            </Link>
          </>
        ) : null}
      </StatCard>
      <StatCard label="Integrations it can use" query={integrations}>
        {integrationStat ? (
          <>
            <StatValue>{integrationsStatValue(integrationStat)}</StatValue>
            <StatDetail>{integrationsStatDetail(integrationStat)}</StatDetail>
          </>
        ) : null}
      </StatCard>
      <StatCard label="Tool runs this week" query={stats}>
        {stats.data ? (
          <>
            <StatValue>{stats.data.runs}</StatValue>
            <StatDetail>{runsSplitLine(stats.data)}</StatDetail>
          </>
        ) : null}
      </StatCard>
      <StatCard label="Last active" query={stats}>
        {stats.data ? (
          <>
            <StatValue>
              {stats.data.lastRun ? <Time iso={stats.data.lastRun.at} /> : "Never"}
            </StatValue>
            <StatDetail>{lastActiveDetail(stats.data)}</StatDetail>
          </>
        ) : null}
      </StatCard>
    </div>
  );
}

/** One figure's card: its label, then the figure, or skeletons while it reads, or a Retry. */
function StatCard({
  label,
  query,
  children,
}: {
  label: string;
  query: Pick<UseQueryResult, "isPending" | "isError" | "error" | "refetch" | "isFetching">;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-1 rounded-lg px-4 py-3.5 ring-border">
      <p className="text-muted-foreground text-xs">{label}</p>
      {query.isPending ? (
        <>
          <Skeleton className="my-1 h-5 w-12" />
          <Skeleton className="h-4 w-28" />
        </>
      ) : query.isError ? (
        <div className="text-muted-foreground text-xs">
          <RetryNotice
            error={query.error}
            message="Could not load this."
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function StatValue({ children }: { children: React.ReactNode }) {
  return <p className="truncate text-foreground text-xl tracking-tight">{children}</p>;
}

function StatDetail({ children }: { children: React.ReactNode }) {
  return <p className="truncate text-muted-foreground text-xs">{children}</p>;
}
