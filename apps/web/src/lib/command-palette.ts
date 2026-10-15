import type { ActivityScreenSearch } from "@/lib/activity-screen";
import type { IntegrationTab } from "@/lib/integration-page";
import type { IntegrationsListSearch } from "@/lib/integrations-list";
import { type NavTarget, SCREEN_NAV_ITEMS } from "@/lib/main-sidebar-nav-items";
import type { HarnessMarkId } from "@/lib/marks";

/**
 * One row of the command palette (`components/shell/command-palette.tsx`): what it reads as, the
 * group it is drawn under, the extra words it answers to, its mark and sub-line, and what Enter
 * does. A pure data shape, so the filter and the ranking below are tested on the rows the palette
 * actually draws; `lib/command-palette-search.ts` makes the rows out of the console's reads
 * (GRA-329).
 */
export type PaletteItem = {
  /** Unique across the palette: cmdk keys its selection on it. */
  id: string;
  group: PaletteGroupName;
  label: string;
  /** Words the row answers to beside its label, lower case. */
  keywords: readonly string[];
  /** The muted line under the label. */
  detail?: string;
  mark?: PaletteMark;
  /** The Enter hint on the selected row; `Open` when absent. */
  hint?: "Open" | "Connect";
  /**
   * Ranked ahead of how well the row matches, lower first (0 when absent): a revoked agent is 1,
   * so the best match among them never pushes a working agent past its group's cap.
   */
  tier?: number;
  open: PaletteOpen;
};

/**
 * Where a row takes the person, as the router's own targets, so a row cannot name a path, a
 * param or a search the route does not take. Each screen's search is its route's
 * `validateSearch` answer.
 */
export type PaletteRoute =
  | { to: Exclude<NavTarget, "/integrations" | "/activity"> }
  | { to: "/integrations"; search?: IntegrationsListSearch }
  | { to: "/activity"; search?: ActivityScreenSearch }
  | { to: "/integrations/$vendor"; params: { vendor: string }; search?: { tab?: IntegrationTab } }
  | { to: "/agents/$agentId"; params: { agentId: string } };

/** A route, or an open request shown in place in its focused layout (`RequestDialog`, GRA-311). */
export type PaletteOpen = PaletteRoute | { request: string };

/** The palette's own glyphs, drawn by the component; a screen's is its sidebar icon. */
export type PaletteIcon = NavTarget | "add" | "agent" | "custom" | "more" | "search" | "docs";

export type PaletteMark =
  | { kind: "icon"; icon: PaletteIcon }
  | { kind: "integration"; slug: string | null; name: string; logoUrl: string | null }
  | { kind: "harness"; mark: HarnessMarkId };

/**
 * The groups in the order the palette draws them, whatever order the rows arrive in (the Figma
 * "App v2" Search frames, 2086:8998, 2086:10233, 2086:11100). *Needs you* is the open requests
 * before anything is typed and *Requests* the ones a query finds, so the two never show at once;
 * the last two are the directory's, under what the person already has.
 */
export const PALETTE_GROUPS = [
  "Needs you",
  "Integrations",
  "Tools",
  "Requests",
  "Activity",
  "Agents",
  "Go to",
  "Do something",
  "Connect a new integration",
  "Can't find it?",
] as const;

export type PaletteGroupName = (typeof PALETTE_GROUPS)[number];

export type PaletteGroup = { name: PaletteGroupName; items: PaletteItem[] };

/**
 * The most rows a group shows for a query, so one long list (a toolbox of forty tools) cannot push
 * the rest below the fold; a group with no cap shows all it matched.
 */
export const PALETTE_GROUP_LIMITS: Partial<Record<PaletteGroupName, number>> = {
  Integrations: 4,
  Tools: 4,
  Requests: 4,
  Activity: 3,
  Agents: 3,
};

/**
 * The words each screen answers to beyond its label: the name a screen had before its label
 * changed (GRA-282, GRA-309), so a person who learned the old one still finds it.
 */
const NAV_KEYWORDS: Record<NavTarget, readonly string[]> = {
  "/": ["start", "overview"],
  "/pending": ["pending", "actions", "asks", "approvals", "inbox"],
  "/agents": ["harness", "token"],
  "/integrations": ["connections", "tools"],
  "/activity": ["history", "calls", "runs", "log", "answers"],
  "/settings": ["model", "key", "preferences"],
};

/** The screens the sidebar names, as palette rows, so the two cannot list different ones. */
export const NAVIGATION_ITEMS: readonly PaletteItem[] = SCREEN_NAV_ITEMS.map((item) => ({
  id: `go:${item.to}`,
  group: "Go to",
  label: item.label,
  keywords: NAV_KEYWORDS[item.to],
  mark: { kind: "icon", icon: item.to },
  open: { to: item.to },
}));

/**
 * The palette's verbs (frame 2086:8998, *Do something*): connect an integration from Discover,
 * connect another agent from the Agents screen, and add an API by its docs, which Discover hands to
 * Flow C (GRA-323) through its `custom` param.
 */
export const ACTION_ITEMS: readonly PaletteItem[] = [
  {
    id: "do:connect-integration",
    group: "Do something",
    label: "Connect an integration",
    keywords: ["add", "new", "app", "discover", "directory"],
    mark: { kind: "icon", icon: "add" },
    open: { to: "/integrations", search: { tab: "discover" } },
  },
  {
    id: "do:connect-agent",
    group: "Do something",
    label: "Connect another agent",
    keywords: ["add", "new", "install", "harness", "token"],
    mark: { kind: "icon", icon: "agent" },
    open: { to: "/agents" },
  },
  {
    id: "do:custom-api",
    group: "Do something",
    label: "Add a custom API",
    keywords: ["docs", "link", "openapi", "new"],
    mark: { kind: "icon", icon: "custom" },
    open: { to: "/integrations", search: { tab: "discover", custom: "" } },
  },
];

/**
 * How well a row answers the query, lower first: its label starting with the whole query, then
 * every word of the query starting a word of the label, then every word starting a word of the
 * label or the keywords. Null when it does not answer. A blank query answers every row alike.
 */
export function paletteMatchRank(
  item: Pick<PaletteItem, "label" | "keywords">,
  query: string,
): 0 | 1 | 2 | null {
  const terms = words(query);
  if (terms.length === 0) return 0;
  const label = words(item.label);
  const startsEach = (haystack: readonly string[]) =>
    terms.every((term) => haystack.some((word) => word.startsWith(term)));
  if (label.join(" ").startsWith(terms.join(" "))) return 0;
  if (startsEach(label)) return 1;
  if (startsEach([...label, ...item.keywords.flatMap(words)])) return 2;
  return null;
}

/**
 * The rows a query leaves, grouped in `PALETTE_GROUPS` order, each group by `tier`, then best match
 * first (rows that match alike keep the order they arrived in) and cut at its `PALETTE_GROUP_LIMITS` once
 * something is typed, and a group with nothing left omitted so no heading stands over an empty
 * list.
 *
 * A row matches when every word of the query starts a word of its label or keywords, ignoring
 * case: "req" finds Requests, "set" finds Settings, "tings" finds nothing. A blank
 * query matches every row.
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteGroup[] {
  const ranked: { item: PaletteItem; index: number; rank: number; tier: number }[] = [];
  items.forEach((item, index) => {
    const rank = paletteMatchRank(item, query);
    if (rank !== null) ranked.push({ item, index, rank, tier: item.tier ?? 0 });
  });
  ranked.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.index - b.index);
  const blank = words(query).length === 0;

  return groupPalette(ranked.map((row) => row.item)).map((group) => {
    const limit = blank ? undefined : PALETTE_GROUP_LIMITS[group.name];
    return limit === undefined ? group : { ...group, items: group.items.slice(0, limit) };
  });
}

/** Rows in `PALETTE_GROUPS` order, each group's in the order given, empty groups left out. */
export function groupPalette(items: readonly PaletteItem[]): PaletteGroup[] {
  return PALETTE_GROUPS.map((name) => ({
    name,
    items: items.filter((item) => item.group === name),
  })).filter((group) => group.items.length > 0);
}

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * ⌘K on a Mac, Ctrl+K elsewhere, as `SidebarProvider` reads ⌘B: either modifier, so a person on
 * either keyboard has it. Shift or Alt with it is another shortcut (the browser's or the
 * system's), and a held key's repeats would flicker the palette open and shut.
 */
export function isCommandPaletteShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}): boolean {
  return (
    event.key.toLowerCase() === "k" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.repeat
  );
}
