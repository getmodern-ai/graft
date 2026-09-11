import { InboxIcon, PowerIcon, SettingsIcon, SmartToyIcon } from "@/components/icons";

/** Narrowed to the paths that exist, so a row cannot point at one that does not. */
export type NavTarget = "/agents" | "/pending" | "/connections" | "/settings";

type NavIcon = typeof SmartToyIcon;

/**
 * The sidebar's four destinations, in the order the sidebar draws them. `match` is the path
 * prefix that lights the row, so a detail screen keeps its section lit — `/agents/<id>` lights
 * Agents, `/pending/<id>` lights Pending actions.
 *
 * A pure data module — no router, no auth client — so a test can import the array and assert on
 * its actual contents rather than scanning `main-sidebar.tsx`'s source for these labels, which
 * would stay green after the render site stopped mapping over it. The shape is Cando's
 * `apps/web/src/lib/main-sidebar-nav-items.ts` (its CAN-353); the rows are Graft's.
 */
export const NAV_ITEMS: { label: string; icon: NavIcon; to: NavTarget; match: string }[] = [
  { label: "Agents", icon: SmartToyIcon, to: "/agents", match: "/agents" },
  { label: "Pending actions", icon: InboxIcon, to: "/pending", match: "/pending" },
  { label: "Connections", icon: PowerIcon, to: "/connections", match: "/connections" },
  { label: "Settings", icon: SettingsIcon, to: "/settings", match: "/settings" },
];
