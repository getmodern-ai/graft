import {
  AppsIcon,
  HelpIcon,
  HomeIcon,
  InboxIcon,
  SettingsIcon,
  SmartToyIcon,
} from "@/components/icons";

/** Narrowed to the paths that exist, so a row cannot point at one that does not. */
export type NavTarget = "/" | "/pending" | "/agents" | "/integrations" | "/settings";

type NavIcon = typeof SmartToyIcon;

export type NavItem = {
  label: string;
  icon: NavIcon;
  to: NavTarget;
  /** The path prefix that lights the row, so a detail screen keeps its section lit. */
  match: string;
  /** Lit on `match` alone, never on a path under it: Home is `/`, which prefixes every path. */
  exact?: boolean;
};

/**
 * The sidebar's main group, in the order it draws them (the Figma "App v2" sidebar, GRA-309):
 * what is happening, what needs the person, where Graft is in use, what the agents can reach.
 * `/agents/<id>` lights Agents and `/pending/<id>` lights Requests.
 *
 * Labels are CONTEXT.md's person-facing words: *Requests* for the pending actions and
 * *Integrations* for the connections (GRA-282), whose list is `/integrations` (GRA-321) and whose
 * pages under it keep the row lit. Activity, which the frame draws after Integrations, joins when
 * its screen does (GRA-330).
 *
 * A pure data module — no router, no auth client — so a test can import the array and assert on
 * its actual contents rather than scanning `main-sidebar.tsx`'s source for these labels, which
 * would stay green after the render site stopped mapping over it. The shape is Cando's
 * `apps/web/src/lib/main-sidebar-nav-items.ts` (its CAN-353); the rows are Graft's.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Home", icon: HomeIcon, to: "/", match: "/", exact: true },
  { label: "Requests", icon: InboxIcon, to: "/pending", match: "/pending" },
  { label: "Agents", icon: SmartToyIcon, to: "/agents", match: "/agents" },
  { label: "Integrations", icon: AppsIcon, to: "/integrations", match: "/integrations" },
];

/** The footer group's console screen, under Docs & help, as the frame draws it. */
export const FOOTER_NAV_ITEMS: readonly NavItem[] = [
  { label: "Settings", icon: SettingsIcon, to: "/settings", match: "/settings" },
];

/** Every console screen the sidebar names, main group first: what the palette lists. */
export const SCREEN_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, ...FOOTER_NAV_ITEMS];

/** The public documentation site, the one place the console names it. */
export const DOCS_URL = "https://docs.getgraft.ai";

/** The footer's link out to the docs, above Settings. Opens beside the console, not over it. */
export const DOCS_NAV_ITEM = { label: "Docs & help", icon: HelpIcon, href: DOCS_URL } as const;

/** Whether `item`'s row is lit on `pathname`. */
export function isNavItemActive(item: Pick<NavItem, "match" | "exact">, pathname: string): boolean {
  if (item.exact) return pathname === item.match;
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}
