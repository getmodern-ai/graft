import { type NavTarget, SCREEN_NAV_ITEMS } from "@/lib/main-sidebar-nav-items";

/**
 * One row of the command palette (`components/shell/command-palette.tsx`): what it reads as, the
 * group it is drawn under, the extra words it answers to, and where Enter takes the person.
 *
 * A pure data shape, so the filter below is tested on the rows the palette actually draws. The
 * later Search ticket adds groups (requests, integrations, tools, agents) by adding rows of its
 * own kinds; the filter and the grouping do not change.
 */
export type PaletteItem = {
  /** Unique across the palette: cmdk keys its selection on it. */
  id: string;
  group: PaletteGroupName;
  label: string;
  /** Words the row answers to beside its label, lower case. */
  keywords: readonly string[];
  to: NavTarget;
};

/** The groups in the order the palette draws them, whatever order the rows arrive in. */
export const PALETTE_GROUPS = ["Go to"] as const;

export type PaletteGroupName = (typeof PALETTE_GROUPS)[number];

export type PaletteGroup = { name: PaletteGroupName; items: PaletteItem[] };

/**
 * The words each screen answers to beyond its label: the name a screen had before its label
 * changed (GRA-282, GRA-309), so a person who learned the old one still finds it.
 */
const NAV_KEYWORDS: Record<NavTarget, readonly string[]> = {
  "/": ["start", "overview"],
  "/pending": ["pending", "actions", "asks", "approvals", "inbox"],
  "/agents": ["harness", "token"],
  "/integrations": ["connections", "tools"],
  "/settings": ["model", "key", "preferences"],
};

/** The screens the sidebar names, as palette rows, so the two cannot list different ones. */
export const NAVIGATION_ITEMS: readonly PaletteItem[] = SCREEN_NAV_ITEMS.map((item) => ({
  id: `go:${item.to}`,
  group: "Go to",
  label: item.label,
  keywords: NAV_KEYWORDS[item.to],
  to: item.to,
}));

/**
 * The rows a query leaves, grouped in `PALETTE_GROUPS` order, each group in the order its rows
 * arrived, and a group with nothing left omitted so no heading stands over an empty list.
 *
 * A row matches when every word of the query starts a word of its label or keywords, ignoring
 * case: "req" finds Requests, "set" finds Settings, "tings" finds nothing. A blank
 * query matches every row.
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteGroup[] {
  const terms = words(query);
  const matching = items.filter((item) => {
    const haystack = [...words(item.label), ...item.keywords.flatMap(words)];
    return terms.every((term) => haystack.some((word) => word.startsWith(term)));
  });

  return PALETTE_GROUPS.map((name) => ({
    name,
    items: matching.filter((item) => item.group === name),
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
