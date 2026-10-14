import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  HomeListFailed,
  HomeListLoading,
  HomePanel,
  HomeRow,
  HomeRowText,
  useRefetchWhenRequestsChange,
} from "@/components/home/home-panel";
import { IntegrationMark } from "@/components/marks";
import { RequestList, RequestListNote } from "@/components/pending/request-row";
import { Time } from "@/components/time";
import { activityIntegrationName } from "@/lib/activity-screen";
import { homeActivityCopy, homeActivityQuery, homeIntegrationNames } from "@/lib/home";
import { integrationsQuery } from "@/lib/integration-queries";
import { cn } from "@/lib/utils";

/**
 * *Recent activity* (GRA-327): the person's latest runs and answers from the activity read
 * (GRA-308), in the Activity screen's words (GRA-330), "Ran without asking" included. The
 * integrations read only names a row's integration; until it lands, or if it fails, a row names
 * the slug.
 *
 * An answer given on Home refreshes the open requests and nothing of activity's, so the panel
 * reads again whenever they change (`useRefetchWhenRequestsChange`).
 */
export function ActivityPanel() {
  const activity = useQuery(homeActivityQuery);
  const integrations = useQuery(integrationsQuery);
  useRefetchWhenRequestsChange(activity.refetch);
  const names = homeIntegrationNames(integrations.data?.integrations ?? []);
  const rows = activity.data?.rows ?? [];

  return (
    <HomePanel
      title="Recent activity"
      description="Including what ran without asking you."
      more={{ label: "View all", render: <Link to="/activity" /> }}
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
                  name={activityIntegrationName(row, names)}
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
