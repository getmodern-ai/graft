import { useQuery } from "@tanstack/react-query";
import type * as React from "react";

import {
  ArrowForwardIcon,
  BlockIcon,
  BoltIcon,
  CheckCircleIcon,
  ErrorIcon,
} from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ActivityIcon,
  activityRowView,
  agentActivityHref,
  agentRecentActivityQuery,
  integrationNameOf,
  RECENT_ACTIVITY_LIMIT,
} from "@/lib/agent-page";
import type { Agent } from "@/lib/agent-queries";
import { integrationsQuery } from "@/lib/integration-queries";
import { cn } from "@/lib/utils";

const ICONS: Record<ActivityIcon, { Icon: typeof CheckCircleIcon; className: string }> = {
  ran: { Icon: CheckCircleIcon, className: "text-success" },
  allowed: { Icon: CheckCircleIcon, className: "text-success" },
  asked: { Icon: BoltIcon, className: "text-primary" },
  failed: { Icon: ErrorIcon, className: "text-destructive" },
  blocked: { Icon: BlockIcon, className: "text-muted-foreground" },
  denied: { Icon: BlockIcon, className: "text-muted-foreground" },
};

/**
 * The agent page's recent activity (GRA-325; Figma 2072:8121): the agent's last runs and the
 * person's answers, from `GET /api/activity?agentId=` (GRA-308), which leaves meta-tool calls and
 * dry runs out. *All* opens the Activity screen filtered by the agent (GRA-330). A row's
 * integration name comes from the person's integrations, the slug standing in until they land.
 */
export function AgentRecentActivity({ agent }: { agent: Agent }) {
  const activity = useQuery(agentRecentActivityQuery(agent.id));
  const integrations = useQuery(integrationsQuery);
  const known = integrations.data?.integrations ?? [];
  const rows = activity.data?.rows ?? [];

  return (
    <section aria-labelledby="agent-recent-activity" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="agent-recent-activity" className="font-medium text-foreground text-lg">
            Recent activity
          </h2>
          <p className="text-muted-foreground text-sm">
            What {agent.name} ran, and what you said no to.
          </p>
        </div>
        {/* A plain link until the Activity screen's route lands (GRA-330), so the type program
            does not need it to exist. */}
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<a href={agentActivityHref(agent.id)} />}
        >
          All
          <ArrowForwardIcon />
        </Button>
      </div>
      <Card className="gap-0 rounded-lg py-0 ring-border">
        {activity.isPending ? (
          Array.from({ length: 3 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity of their own
            <ActivityRowFrame key={index}>
              <Skeleton className="size-4 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
            </ActivityRowFrame>
          ))
        ) : activity.isError ? (
          <ActivityNote>
            <RetryNotice
              error={activity.error}
              message="Could not load the activity."
              onRetry={() => void activity.refetch()}
              retrying={activity.isFetching}
            />
          </ActivityNote>
        ) : rows.length === 0 ? (
          <ActivityNote>Nothing yet. Runs and your answers show here.</ActivityNote>
        ) : (
          rows.slice(0, RECENT_ACTIVITY_LIMIT).map((row) => {
            const integration = integrationNameOf(row.vendor, known);
            const view = activityRowView(row, integration);
            const { Icon, className } = ICONS[view.icon];
            return (
              <ActivityRowFrame key={row.key}>
                <Icon className={cn("size-4 shrink-0", className)} />
                {row.vendor ? (
                  <IntegrationMark
                    slug={row.vendor}
                    name={integration}
                    tile="none"
                    className="size-[18px]"
                  />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="truncate text-foreground text-sm">{view.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    {view.integration ? `${view.integration} · ` : null}
                    <Time iso={row.at} />
                    {view.sentence ? ` · ${view.sentence}` : null}
                  </p>
                </div>
              </ActivityRowFrame>
            );
          })
        )}
      </Card>
    </section>
  );
}

function ActivityRowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-border border-b px-4 py-2.5 last:border-b-0">
      {children}
    </div>
  );
}

function ActivityNote({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-muted-foreground text-sm">{children}</div>;
}
