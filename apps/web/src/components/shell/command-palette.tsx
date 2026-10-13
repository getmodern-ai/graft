import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { SearchIcon } from "@/components/icons";
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
import {
  filterPalette,
  isCommandPaletteShortcut,
  NAVIGATION_ITEMS,
  type PaletteItem,
} from "@/lib/command-palette";
import { NAV_ITEMS } from "@/lib/main-sidebar-nav-items";

/**
 * The command palette: ⌘K (Ctrl+K) from anywhere in the shell, or the sidebar's Search row, opens
 * a centred dialog of grouped rows; the arrow keys move, Enter opens, Escape closes (the Figma
 * "App v2" Search frames, GRA-289). Today it lists the four screens the sidebar names; the Search
 * ticket adds rows through `lib/command-palette.ts`, which owns the filter and the grouping.
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

const SCREEN_ICONS = new Map(NAV_ITEMS.map((item) => [item.to, item.icon]));

export function CommandPalette() {
  const open = React.useContext(OpenContext);
  const setOpen = React.useContext(SetOpenContext);
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const groups = filterPalette(NAVIGATION_ITEMS, query);

  const choose = (item: PaletteItem) => {
    setOpen(false);
    void navigate({ to: item.to });
  };

  return (
    <CommandDialog
      title="Search"
      description="Go to a screen in the console. Use the arrow keys to move and Enter to open."
      open={open}
      onOpenChange={setOpen}
      // Cleared once the close animation is over, so the rows do not jump back mid-fade.
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setQuery("");
      }}
      // 640px at 112px from the top, the Figma frame's; Cando's primitive puts it at a third.
      className="top-28 sm:max-w-160"
    >
      {/* `shouldFilter={false}`: the rows arrive filtered and grouped by `filterPalette`, so cmdk
          only moves the selection and answers Enter. The `**:` classes restyle the primitive's
          input row to the frame's (a 16px field on the popover, no inset box) without editing
          Cando's file. */}
      <Command
        shouldFilter={false}
        loop
        className="**:data-[slot=input-group]:bg-transparent **:data-[slot=command-input-wrapper]:px-2 **:data-[slot=command-input-wrapper]:py-2.5 **:[[data-slot=input-group-addon]>svg]:size-5"
      >
        <div className="relative">
          <CommandInput
            placeholder="Search screens"
            value={query}
            onValueChange={setQuery}
            className="pr-12 text-base"
          />
          <Kbd aria-hidden="true" className="absolute top-1/2 right-4 -translate-y-1/2">
            esc
          </Kbd>
        </div>
        <CommandList className="max-h-[min(28rem,60svh)] p-2">
          <CommandEmpty className="text-muted-foreground text-sm">
            No screen matches “{query.trim()}”.
          </CommandEmpty>
          {groups.map((group) => (
            <CommandGroup key={group.name} heading={group.name}>
              {group.items.map((item) => {
                const Icon = SCREEN_ICONS.get(item.to);
                return (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    onSelect={() => choose(item)}
                    className="rounded-md data-selected:bg-accent"
                  >
                    {Icon ? <Icon /> : null}
                    <span>{item.label}</span>
                    {/* The Enter hint, on the selected row alone, as the frame draws it. */}
                    <CommandShortcut className="hidden text-xs tracking-normal group-data-selected/command-item:inline group-data-selected/command-item:text-muted-foreground">
                      Open
                    </CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
        {/* The keys, for a sighted person; the listbox already announces its rows and the
            description says the same to a screen reader. */}
        <div
          aria-hidden="true"
          className="flex items-center gap-4 border-t bg-muted/50 px-4 py-2.5 text-muted-foreground text-xs"
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
  );
}
