import { Link } from "@tanstack/react-router";
import type * as React from "react";

import { PageNavSubPageTitle } from "@/components/page/page-nav";
import type { NavTarget } from "@/lib/main-sidebar-nav-items";

/**
 * A detail screen's title in the shell's bars: the muted parent, a slash, the record's name in
 * foreground — "Agents / hermes-laptop". The parent half is a link back to the list rather than
 * static text: the way in is also the way back, which is what lets the detail screens drop the
 * ghost "All agents" button they used to open with. The slash is a plain glyph — the icon set is
 * Material Symbols, which has no forward slash.
 *
 * Cando draws this inline in each detail strip (`apps/web/src/routes/_auth/_main/
 * automations_.$automationId.tsx`, its CAN-323); it is a component here because two screens
 * draw it and both of the shell's bars show it (`screen-title.tsx`). `parentTo` is narrowed to
 * the sidebar's destinations, which is every parent a detail screen has.
 */
export function PageNavBreadcrumb({
  parentLabel,
  parentTo,
  children,
}: {
  parentLabel: string;
  parentTo: NavTarget;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 font-medium text-base">
      <Link
        to={parentTo}
        className="rounded-sm text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {parentLabel}
      </Link>
      <span aria-hidden="true" className="text-muted-foreground">
        /
      </span>
      <PageNavSubPageTitle className="min-w-0">
        <span className="truncate">{children}</span>
      </PageNavSubPageTitle>
    </div>
  );
}
