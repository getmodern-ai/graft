import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
  AddIcon,
  ArrowForwardIcon,
  DescriptionIcon,
  ElectricalServicesIcon,
  ExploreIcon,
  SearchIcon,
  SmartToyIcon,
} from "@/components/icons";
import { HarnessMark, IntegrationMark } from "@/components/marks";
import { RequestDialog } from "@/components/pending/request-dialog";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { activityRows, activityScreenQuery } from "@/lib/activity-screen";
import { agentsQuery } from "@/lib/agent-queries";
import {
  isCommandPaletteShortcut,
  type PaletteIcon,
  type PaletteItem,
  type PaletteMark,
  type PaletteRoute,
} from "@/lib/command-palette";
import {
  paletteDirectoryHomeQuery,
  paletteDirectorySearchQuery,
} from "@/lib/command-palette-queries";
import { paletteView } from "@/lib/command-palette-search";
import { toolsQuery } from "@/lib/connection-queries";
import { integrationsQuery } from "@/lib/integration-queries";
import { SCREEN_NAV_ITEMS } from "@/lib/main-sidebar-nav-items";
import { type PendingAction, pendingActionsQuery, readAsk } from "@/lib/pending-action-queries";
import { requestRowCopy } from "@/lib/request-row";
import { cachedDirectoryLogo } from "@/lib/setup-queries";

/**
 * The command palette: ⌘K (Ctrl+K) from anywhere in the shell, or the sidebar's Search row, opens
 * a centred dialog of grouped rows; the arrow keys move, Enter opens, Escape closes (the Figma
 * "App v2" Search frames, GRA-289). What it lists is GRA-329's, decided by
 * `lib/command-palette-search.ts`: the open requests, the screens and the verbs before anything is
 * typed, then the person's integrations, tools, requests, activity and agents, and the directory's
 * integrations they have not connected.
 *
 * The open state is a context rather than Base UI's detached-trigger handle, so nothing outside
 * `components/ui` imports Base UI. One consequence for focus: the dialog returns it to whatever
 * held it when it opened, so the Search row focuses itself on press (`CommandPaletteTrigger`),
 * since Safari does not focus a button it clicks and focus would otherwise fall back to the page.
 */
const OpenContext = React.createContext(false);
const SetOpenContext = React.createContext<React.Dispatch<React.SetStateAction<boolean>>>(() => {});

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // On `window`, as `SidebarProvider` binds ⌘B, so it reaches the palette from a focused input
  // too, and a second press closes it.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <SetOpenContext.Provider value={setOpen}>
      <OpenContext.Provider value={open}>{children}</OpenContext.Provider>
    </SetOpenContext.Provider>
  );
}

/** The sidebar's Search row, where the Figma sidebar draws it under the wordmark. */
export function CommandPaletteTrigger() {
  const setOpen = React.useContext(SetOpenContext);

  return (
    <SidebarMenuButton
      variant="outline"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={(event) => {
        event.currentTarget.focus();
        setOpen(true);
      }}
      className="text-muted-foreground"
    >
      <SearchIcon />
      <span>Search</span>
      <Kbd className="ml-auto">⌘K</Kbd>
    </SidebarMenuButton>
  );
}

const SCREEN_ICONS = new Map<PaletteIcon, typeof SearchIcon>(
  SCREEN_NAV_ITEMS.map((item) => [item.to, item.icon]),
);
const ICONS = new Map<PaletteIcon, typeof SearchIcon>([
  ...SCREEN_ICONS,
  ["add", AddIcon],
  ["agent", SmartToyIcon],
  ["custom", ElectricalServicesIcon],
  ["more", ArrowForwardIcon],
  ["search", ExploreIcon],
  ["docs", DescriptionIcon],
]);

/** How long typing rests before the directory is asked, so a word is one request, not five. */
const DIRECTORY_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function CommandPalette() {
  const open = React.useContext(OpenContext);
  const setOpen = React.useContext(SetOpenContext);
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const directoryQuery = useDebounced(query.trim(), DIRECTORY_DEBOUNCE_MS);
  // A request chosen here opens in place once the palette has closed, so the two dialogs never
  // contend for focus; `shownRequest` is the one on screen.
  const chosenRequest = React.useRef<PendingAction | null>(null);
  const [shownRequest, setShownRequest] = React.useState<PendingAction | null>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);

  // Every read waits for the palette to open (`enabled`), then answers from the cache the screens
  // share, so a palette opened on Requests or Home costs nothing it has not read already.
  const integrations = useQuery({ ...integrationsQuery, enabled: open });
  const tools = useQuery({ ...toolsQuery, enabled: open });
  const pending = useQuery({ ...pendingActionsQuery, enabled: open });
  const agents = useQuery({ ...agentsQuery, enabled: open });
  const activity = useInfiniteQuery({ ...activityScreenQuery({}), enabled: open });
  const searching = open && directoryQuery !== "";
  const directory = useQuery({
    ...paletteDirectorySearchQuery(directoryQuery),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const directoryHome = useQuery({ ...paletteDirectoryHomeQuery, enabled: searching });

  const view = paletteView(
    {
      integrations: integrations.data?.integrations,
      tools: tools.data?.tools,
      pendingActions: pending.data?.pendingActions,
      agents: agents.data?.agents,
      // The newest page alone: the read takes no words, so the palette filters what it has.
      activity: activity.data ? activityRows(activity.data.pages.slice(0, 1)) : undefined,
      directory: searching ? directory.data?.entries : undefined,
      directoryTotal: directoryHome.data?.total,
    },
    query,
  );

  const go = (target: PaletteRoute) => {
    switch (target.to) {
      case "/integrations":
        return navigate({ to: target.to, search: target.search ?? {} });
      case "/activity":
        return navigate({ to: target.to, search: target.search ?? {} });
      case "/integrations/$vendor":
        return navigate({ to: target.to, params: target.params, search: target.search ?? {} });
      case "/agents/$agentId":
        return navigate({ to: target.to, params: target.params });
      default:
        return navigate({ to: target.to });
    }
  };

  const choose = (item: PaletteItem) => {
    setOpen(false);
    if ("request" in item.open) {
      const id = item.open.request;
      chosenRequest.current =
        pending.data?.pendingActions.find((action) => action.id === id) ?? null;
      // Answered or gone since the list was read: Requests says where it stands.
      if (!chosenRequest.current) void navigate({ to: "/pending" });
      return;
    }
    void go(item.open);
  };

  return (
    <>
      <CommandDialog
        title="Search"
        description="Search your integrations, tools, requests, activity and agents, or go to a screen. Use the arrow keys to move and Enter to open."
        open={open}
        onOpenChange={setOpen}
        // Cleared once the close animation is over, so the rows do not jump back mid-fade.
        onOpenChangeComplete={(isOpen) => {
          if (isOpen) return;
          setQuery("");
          if (chosenRequest.current) {
            setShownRequest(chosenRequest.current);
            setRequestOpen(true);
            chosenRequest.current = null;
          }
        }}
        // 640px at 112px from the top, the Figma frame's (Cando's primitive puts it at a third). On a
        // short screen, a phone on its side, the offset shrinks to 12svh and the dialog is held to the
        // height left beneath it, a flex column whose list is what gives way, so the input and the
        // key hints stay on screen (Greptile on #226).
        className="top-[min(7rem,12svh)] flex max-h-[calc(100svh_-_2_*_min(7rem,12svh))] flex-col sm:max-w-160"
      >
        {/* `shouldFilter={false}`: the rows arrive filtered and grouped by `paletteView`, so cmdk
            only moves the selection and answers Enter. The `**:` classes restyle the primitive's
            input row to the frame's (a 16px field on the popover, no inset box) without editing
            Cando's file. */}
        <Command
          shouldFilter={false}
          loop
          className="min-h-0 **:data-[slot=command-input-wrapper]:shrink-0 **:data-[slot=input-group]:bg-transparent **:data-[slot=command-input-wrapper]:px-2 **:data-[slot=command-input-wrapper]:py-2.5 **:[[data-slot=input-group-addon]>svg]:size-5"
        >
          <div className="relative shrink-0">
            <CommandInput
              placeholder="Search integrations, tools, agents and requests"
              value={query}
              onValueChange={setQuery}
              className="pr-12 text-base"
            />
            <Kbd aria-hidden="true" className="absolute top-1/2 right-4 -translate-y-1/2">
              esc
            </Kbd>
          </div>
          <CommandList className="max-h-112 min-h-0 flex-1 p-2">
            <CommandEmpty className="text-muted-foreground text-sm">
              Nothing matches “{query.trim()}”.
            </CommandEmpty>
            {view.notice ? (
              <p className="px-2 pt-1 pb-2 text-muted-foreground text-sm">{view.notice}</p>
            ) : null}
            {view.groups.map((group) => (
              <CommandGroup key={group.name} heading={group.name}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => choose(item)}
                    className="gap-3 rounded-md data-selected:bg-accent"
                  >
                    {item.mark ? <RowMark mark={item.mark} /> : null}
                    {item.detail ? (
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        <span className="truncate text-muted-foreground text-xs">
                          {item.detail}
                        </span>
                      </span>
                    ) : (
                      <span className="min-w-0 truncate">{item.label}</span>
                    )}
                    {/* The Enter hint, on the selected row alone, as the frame draws it. */}
                    <CommandShortcut className="hidden shrink-0 text-xs tracking-normal group-data-selected/command-item:inline group-data-selected/command-item:text-muted-foreground">
                      {item.hint ?? "Open"}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {/* The keys, for a sighted person; the listbox already announces its rows and the
              description says the same to a screen reader. */}
          <div
            aria-hidden="true"
            className="flex shrink-0 items-center gap-4 border-t bg-muted/50 px-4 py-2.5 text-muted-foreground text-xs"
          >
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              to open
            </span>
          </div>
        </Command>
      </CommandDialog>

      {shownRequest ? (
        <RequestDialog
          action={shownRequest}
          title={requestRowCopy(readAsk(shownRequest)).title}
          open={requestOpen}
          onOpenChange={setRequestOpen}
        />
      ) : null}
    </>
  );
}

/** A row's mark: the integration's or the agent's in the frame's 32px outlined tile, or a glyph. */
function RowMark({ mark }: { mark: PaletteMark }) {
  const queryClient = useQueryClient();
  switch (mark.kind) {
    case "integration":
      return (
        <IntegrationMark
          slug={mark.slug}
          name={mark.name}
          logoUrl={mark.logoUrl ?? (mark.slug ? cachedDirectoryLogo(queryClient, mark.slug) : null)}
          tile="outline"
          tileSize={32}
          size={18}
        />
      );
    case "harness":
      return <HarnessMark mark={mark.mark} tile="outline" tileSize={32} size={18} />;
    case "icon": {
      const Icon = ICONS.get(mark.icon);
      return Icon ? <Icon /> : null;
    }
  }
}
