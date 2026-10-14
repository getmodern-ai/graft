import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_INTEGRATION_TAB,
  INTEGRATION_TAB_LABELS,
  INTEGRATION_TABS,
  type IntegrationTab,
} from "@/lib/integration-page";
import { cn } from "@/lib/utils";

/**
 * The integration page's tab bar (Figma 2044:7440): links, not a tab widget, because the open tab
 * is the URL's `?tab=` (`readIntegrationSearch`), so a tab is a deep link and Back steps through
 * them. The open one is foreground over a 2px primary rule; the rest are muted. The console has no
 * Tabs primitive yet, so this is composed from `Link` and `Badge` on the frame's measures.
 */
export function IntegrationTabs({
  vendor,
  current,
  counts,
}: {
  vendor: string;
  current: IntegrationTab;
  counts: Partial<Record<IntegrationTab, number>>;
}) {
  return (
    <nav aria-label="Integration sections" className="flex gap-5 border-border border-b">
      {INTEGRATION_TABS.map((tab) => {
        const active = tab === current;
        const tally = counts[tab];
        return (
          <Link
            key={tab}
            to="/integrations/$vendor"
            params={{ vendor }}
            search={tab === DEFAULT_INTEGRATION_TAB ? {} : { tab }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1 rounded-t-md border-b-2 px-1.5 pb-1 font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {INTEGRATION_TAB_LABELS[tab]}
            {tally === undefined ? null : <Badge variant="secondary">{tally}</Badge>}
          </Link>
        );
      })}
    </nav>
  );
}
