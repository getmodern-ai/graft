import { Link } from "@tanstack/react-router";
import type * as React from "react";

import type { NavTarget } from "@/lib/main-sidebar-nav-items";

/**
 * A detail screen's breadcrumb, drawn in the page above its `PageHeader`: the muted parent, a
 * slash, the record's name in foreground ("Integrations / Gmail", "Agents / Claude"; Figma
 * 2044:7001 and 2047:7614, GRA-344). The parent half is a link back to the list, so the way in is
 * also the way back at every width. The slash is a plain glyph: the icon set is Material Symbols,
 * which has no forward slash.
 *
 * It replaces the breadcrumb the shell's 48px strip used to carry (GRA-46), which App v2 does not
 * draw. `parentTo` is narrowed to the sidebar's destinations, which is every parent a detail
 * screen has.
 */
export function PageBreadcrumb({
  parentLabel,
  parentTo,
  children,
}: {
  parentLabel: string;
  parentTo: NavTarget;
  children: React.ReactNode;
}) {
  return (
    <nav aria-label="Breadcrumb" data-slot="page-breadcrumb" className="min-w-0 text-sm">
      <ol className="flex min-w-0 items-center gap-1.5">
        <li className="shrink-0">
          <Link
            to={parentTo}
            className="rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {parentLabel}
          </Link>
        </li>
        <li aria-hidden="true" className="text-muted-foreground">
          /
        </li>
        <li aria-current="page" className="min-w-0 truncate text-foreground">
          {children}
        </li>
      </ol>
    </nav>
  );
}
