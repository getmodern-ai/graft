import { useQuery } from "@tanstack/react-query";

import {
  HomeListFailed,
  HomeListLoading,
  HomePanel,
  HomeRow,
  HomeRowText,
} from "@/components/home/home-panel";
import { IntegrationMark } from "@/components/marks";
import { RequestList, RequestListNote } from "@/components/pending/request-row";
import { Time } from "@/components/time";
import { activityIntegrationName, homeActivityCopy, homeActivityQuery } from "@/lib/home";
import { integrationsQuery } from "@/lib/integration-queries";
import { cn } from "@/lib/utils";

/**
 * *Recent activity* (GRA-327): the person's latest runs and answers from the activity read
 * (GRA-308), in the Activity screen's words, "Ran without asking" included. The integrations read
 * only names a row's integration; until it lands, or if it fails, a row names the slug.
 */
export function ActivityPanel() {
  const activity = useQuery(homeActivityQuery);
  const integrations = useQuery(integrationsQuery);
  const names = new Map(
    (integrations.data?.integrations ?? []).map((row) => [row.vendor, row.displayName]),
  );
  const rows = activity.data?.rows ?? [];

  return (
    <HomePanel
      title="Recent activity"
      description="Including what ran without asking you."
      // "View all" opens `/activity` once the Activity screen (GRA-330, PR #260) is on main.
    >
      <RequestList aria-label="Recent activity" aria-busy={activity.isPending}>
        {activity.isPending ? (
          <HomeListLoading />
        ) : activity.isError && !activity.data ? (
          <HomeListFailed query={activity} message="Could not load your activity." />
        ) : rows.length === 0 ? (
          <RequestListNote>Nothing has run yet.</RequestListNote>
        ) : (
          rows.map((row) => {
            const copy = homeActivityCopy(row, names);
            return (
              <HomeRow key={row.key}>
                <IntegrationMark
                  slug={row.vendor}
                  name={activityIntegrationName(row.vendor, names)}
                  tile="none"
                  className="size-5"
                />
                <HomeRowText
                  title={<span title={copy.title}>{copy.title}</span>}
                  detail={copy.detail}
                  detailClassName={cn(copy.tone === "destructive" && "text-destructive")}
                />
                <Time iso={row.at} className="shrink-0 text-muted-foreground text-xs" />
              </HomeRow>
            );
          })
        )}
      </RequestList>
    </HomePanel>
  );
}
