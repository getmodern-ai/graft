import { createFileRoute } from "@tanstack/react-router";

import { ActivityTable } from "@/components/activity/activity-table";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { useScreenTitle } from "@/components/shell/screen-title";
import { activityScreenQuery, readActivityScreenSearch } from "@/lib/activity-screen";

/**
 * The Activity screen (GRA-330; GRA-286 decided it, with no frame of its own): the integration
 * page's Activity table across every integration, the person's answers as rows of their own. The
 * filters are the search, `?vendor=&agent=&outcome=`, which is how Home, an agent's page and
 * Search link here with one applied.
 *
 * The loader starts the first page and awaits nothing, so the table paints its own pending rows
 * (the agents table's reasoning, `agents.index.tsx`).
 */
export const Route = createFileRoute("/_auth/_shell/activity")({
  validateSearch: readActivityScreenSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchInfiniteQuery(activityScreenQuery(deps));
  },
  component: ActivityRoute,
});

function ActivityRoute() {
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();

  useScreenTitle("Activity");

  return (
    // `large`: the frame's 1120 column, as the integrations list. `gap-4` under the header (GRA-47).
    <PageContainer size="large" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Activity</PageHeaderTitle>
          <PageHeaderDescription>
            What your agents ran, including what ran without asking you, and every answer you gave.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <ActivityTable
        filters={filters}
        // A filter change replaces the entry, so Back leaves the screen rather than undoing a filter.
        onFiltersChange={(next) => void navigate({ search: next, replace: true })}
      />
    </PageContainer>
  );
}
