import { useQuery } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { GraftWordmark } from "@/components/graft-wordmark";
import { AccountMenu } from "@/components/shell/account-menu";
import { SidebarToggle } from "@/components/shell/sidebar-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { count } from "@/lib/format";
import { NAV_ITEMS } from "@/lib/main-sidebar-nav-items";
import { pendingActionsQuery } from "@/lib/pending-action-queries";

/**
 * The console's sidebar: the wordmark, the four destinations, and the account menu.
 *
 * Cando's `apps/web/src/components/shell/main-sidebar.tsx` reduced to what Graft has. Left out,
 * each because there is no such thing here (ADR 0017): the agent rail and its `mobileLeading`
 * copy inside the drawer, the active agent's face and name in the header, the New Thread button,
 * and the Automations and Recents groups. What remains is the same skeleton — header row with the
 * collapse control, one nav group, the rail on the edge — plus a footer, which Cando's sidebar
 * does not have because its account menu hangs off the rail.
 *
 * At the left edge and the primitive's own 16rem: Cando offsets its sidebar past a 48px rail
 * (`data-[side=left]:left-12`) and widens it to 260px; with no rail there is nothing to clear and
 * no frame to match, so the defaults stand.
 */
export function MainSidebar() {
  useCloseMobileSidebarOnNavigate();

  return (
    /* Off canvas, not the icon rail: collapsed, the sidebar leaves the layout and the way back in
       is the page strip's `PageNavCollapsedSidebar`, plus ⌘B — Cando's CAN-335. */
    <Sidebar collapsible="offcanvas">
      {/* py-1.5 over the primitive's p-2: 8px sides but 6px above and below the 36px row, which is
          what brings the header to the strip's 48. */}
      <SidebarHeader className="py-1.5">
        <div className="flex h-9 items-center justify-between rounded-md px-2">
          <Link
            to="/agents"
            className="flex min-w-0 items-center rounded-sm outline-hidden ring-ring/50 focus-visible:ring-3"
          >
            <GraftWordmark className="h-6" />
          </Link>
          <SidebarToggle />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          {/* A landmark with a name, so a screen-reader user can jump to it — and past it — by
              name; the strip in `app-shell.tsx` is the other `nav`. */}
          <nav aria-label="Console">
            <SidebarMenu>
              <SidebarNavigation />
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* The edge strip collapses the open sidebar. Collapsed, the container is off screen and
          `inert` (the primitive's own off-canvas behaviour), so this strip retires with the rest
          of it. */}
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Below `md` this sidebar *is* a sheet over the screen, so a row that navigates would leave the
 * person looking at the sheet rather than at where they just went.
 *
 * Subscribed to the router's own navigation event rather than to a `useRouterState` pathname, for
 * two reasons Cando records (its CAN-178): it covers every route into a navigation at once — the
 * four rows, the breadcrumb links, the browser's back and forward, which no click handler would
 * see — and `onBeforeNavigate` fires when the navigation *starts*, so the sheet gets out of the
 * way immediately instead of after the destination's loader has resolved.
 *
 * Deliberately not gated on `isMobile`. `openMobile` is the sheet's own state, read by nothing at
 * desktop widths, so closing it there is a no-op — and gating would tear the subscription down
 * and rebuild it on every crossing of 768px to buy nothing.
 */
function useCloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const router = useRouter();

  useEffect(
    () => router.subscribe("onBeforeNavigate", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );
}

/**
 * The four destinations. Each lights by prefix (`NAV_ITEMS`' `match`), so a detail screen keeps
 * its section lit. The rows render `Link`s, which is what makes them addresses the browser's own
 * affordances understand and lets a hover preload the screen.
 */
function SidebarNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      {NAV_ITEMS.map(({ label, icon: Icon, to, match }) => (
        <SidebarMenuItem key={label}>
          <SidebarMenuButton isActive={pathname.startsWith(match)} render={<Link to={to} />}>
            <Icon />
            <span>{label}</span>
            {to === "/pending" ? <PendingCountName /> : null}
          </SidebarMenuButton>
          {to === "/pending" ? <PendingCount /> : null}
        </SidebarMenuItem>
      ))}
    </>
  );
}

/**
 * How many asks are waiting, beside the Pending actions row — the one number a person opening the
 * console wants first (ADR 0006). Polled, because an ask arrives while the person is on another
 * screen. Nothing when zero: a "0" would be furniture on the row most people see most.
 *
 * Two renderings of one number. `SidebarMenuBadge` is the primitive's own count — a sibling of the
 * row positioned over its right edge, `pointer-events-none`, outside the link's accessible name —
 * so it is what a sighted person reads and is hidden from assistive technology. The name lives in
 * the link itself: `PendingCountName` puts "3 asks waiting" inside the row, `sr-only`, so the link
 * announces as "Pending actions, 3 asks waiting" rather than as a bare label with a number floating
 * somewhere after it.
 */
function usePendingCount() {
  const { data } = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  return data?.pendingActions.length ?? 0;
}

function PendingCount() {
  const open = usePendingCount();
  if (open === 0) return null;
  return <SidebarMenuBadge aria-hidden="true">{open}</SidebarMenuBadge>;
}

function PendingCountName() {
  const open = usePendingCount();
  if (open === 0) return null;
  return <span className="sr-only">, {count(open, "ask")} waiting</span>;
}
