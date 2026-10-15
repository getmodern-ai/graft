import { useQuery } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { GraftWordmark } from "@/components/graft-wordmark";
import { AccountMenu } from "@/components/shell/account-menu";
import { CommandPaletteTrigger } from "@/components/shell/command-palette";
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
import { integrationsQuery } from "@/lib/integration-queries";
import {
  DOCS_NAV_ITEM,
  FOOTER_NAV_ITEMS,
  isNavItemActive,
  NAV_ITEMS,
  type NavItem,
} from "@/lib/main-sidebar-nav-items";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { openRequestCount } from "@/lib/sign-in-requests";

/**
 * The console's sidebar (the Figma "App v2" sidebar, GRA-309): the wordmark, the Search row that
 * opens the command palette (GRA-289), the main group, a footer group of Docs & help and Settings,
 * and the account menu.
 *
 * Cando's `apps/web/src/components/shell/main-sidebar.tsx` reduced to what Graft has. Left out,
 * each because there is no such thing here (ADR 0017): the agent rail and its `mobileLeading`
 * copy inside the drawer, the active agent's face and name in the header, the New Thread button,
 * and the Automations and Recents groups. What remains is the same skeleton — header row with the
 * collapse control, one nav group, the rail on the edge — plus a footer group pushed to the foot and
 * the account under it, which Cando's sidebar does not have because its account menu hangs off the
 * rail.
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
            to="/"
            aria-label="Graft, home"
            className="flex min-w-0 items-center rounded-sm outline-hidden ring-ring/50 focus-visible:ring-3"
          >
            <GraftWordmark className="h-5.5" />
          </Link>
          <SidebarToggle />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <CommandPaletteTrigger />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          {/* A landmark with a name, so a screen-reader user can jump to it — and past it — by
              name; the strip in `app-shell.tsx` is the other `nav`. */}
          <nav aria-label="Console">
            <SidebarMenu>
              <SidebarNavigation items={NAV_ITEMS} />
            </SidebarMenu>
          </nav>
        </SidebarGroup>
        {/* At the foot of the scrolling region, above the account, as the frame draws it. */}
        <SidebarGroup className="mt-auto">
          <nav aria-label="Help and settings">
            <SidebarMenu>
              <SidebarMenuItem>
                {/* A new tab: the docs are read beside the console, and the person keeps their
                    place in it. */}
                <SidebarMenuButton
                  render={<a href={DOCS_NAV_ITEM.href} target="_blank" rel="noopener noreferrer" />}
                >
                  <DOCS_NAV_ITEM.icon />
                  <span>{DOCS_NAV_ITEM.label}</span>
                  <span className="sr-only">, opens in a new tab</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarNavigation items={FOOTER_NAV_ITEMS} />
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
 * sidebar's rows, the breadcrumb links, the browser's back and forward, which no click handler
 * would see — and `onBeforeNavigate` fires when the navigation *starts*, so the sheet gets out of
 * the way immediately instead of after the destination's loader has resolved.
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
 * One group's console screens. Each lights by `isNavItemActive`, so a detail screen keeps its
 * section lit and Home lights on `/` alone. The rows render `Link`s, which is what makes them
 * addresses the browser's own affordances understand and lets a hover preload the screen.
 */
function SidebarNavigation({ items }: { items: readonly NavItem[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      {items.map((item) => {
        const { label, icon: Icon, to } = item;
        return (
          <SidebarMenuItem key={label}>
            <SidebarMenuButton isActive={isNavItemActive(item, pathname)} render={<Link to={to} />}>
              <Icon />
              <span>{label}</span>
              {to === "/pending" ? <PendingCountName /> : null}
            </SidebarMenuButton>
            {to === "/pending" ? <PendingCount /> : null}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}

/**
 * How many requests are waiting, beside the Requests row — the one number a person opening the
 * console wants first (ADR 0006). The open asks and the connections that need the person to sign
 * in, which Requests lists in Open with them (`openRequestCount`, GRA-313). Polled, because an ask
 * arrives while the person is on another screen. Nothing when zero: a "0" would be furniture on the
 * row most people see most.
 *
 * Two renderings of one number. `SidebarMenuBadge` is the primitive's own count — a sibling of the
 * row positioned over its right edge, `pointer-events-none`, outside the link's accessible name —
 * so it is what a sighted person reads and is hidden from assistive technology. The name lives in
 * the link itself: `PendingCountName` puts "3 requests waiting" inside the row, `sr-only`, so the
 * link announces as "Requests, 3 requests waiting" rather than as a bare label with a number
 * floating somewhere after it.
 */
function usePendingCount() {
  const { data } = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const integrations = useQuery({ ...integrationsQuery, refetchInterval: 15_000 });
  return openRequestCount(data?.pendingActions.length ?? 0, integrations.data?.integrations);
}

function PendingCount() {
  const open = usePendingCount();
  if (open === 0) return null;
  return <SidebarMenuBadge aria-hidden="true">{open}</SidebarMenuBadge>;
}

function PendingCountName() {
  const open = usePendingCount();
  if (open === 0) return null;
  return <span className="sr-only">, {count(open, "request")} waiting</span>;
}
