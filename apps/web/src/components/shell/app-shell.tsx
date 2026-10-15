import type * as React from "react";
import { useState } from "react";

import { CollapsedSidebarToggle } from "@/components/shell/collapsed-sidebar-toggle";
import { CommandPalette, CommandPaletteProvider } from "@/components/shell/command-palette";
import { MainSidebar } from "@/components/shell/main-sidebar";
import { MobileTopBar } from "@/components/shell/mobile-top-bar";
import { ScreenTitleProvider } from "@/components/shell/screen-title";
import { MAIN_CONTENT_ID, SkipNav } from "@/components/skip-nav";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { sidebarOpenFromCookie } from "@/lib/sidebar-state";

/**
 * The frame the console's screens render inside: the sidebar and the content column beside it.
 * Hung off `routes/_auth/_shell/route.tsx`, which is what decides who wears it.
 *
 * Cando's `apps/web/src/components/shell/app-shell.tsx` without the agent rail and without the
 * `--sidebar-width` override that existed to fit beside it (ADR 0017) — so the sidebar sits at
 * the left edge at the primitive's own 16rem. The column is a flex stack rather than Cando's
 * grid: the mobile top bar is a `shrink-0` row, and the screen scrolls in the row that is left.
 *
 * No page strip at `md` and up, unlike Cando's: App v2 opens each screen on its own `PageHeader`,
 * a detail screen with its breadcrumb above it (`page/page-breadcrumb.tsx`), so the strip and the
 * title it repeated are gone (GRA-344). What the strip also carried, the way back to a collapsed
 * sidebar, is `CollapsedSidebarToggle`, floating in the column's corner.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  // Read once, at mount: `SidebarProvider` writes the cookie on every toggle and reads it never
  // (`lib/sidebar-state.ts`), so this is what makes a collapse survive a reload.
  const [defaultOpen] = useState(() =>
    sidebarOpenFromCookie(typeof document === "undefined" ? "" : document.cookie),
  );

  return (
    // ⌘B stays on (the provider's default): this is the one shell, with a desktop sidebar of its
    // own for the shortcut to act on — the case the provider's opt-out exists for is a provider
    // mounted with none.
    <SidebarProvider defaultOpen={defaultOpen}>
      {/* ⌘K, beside the provider's ⌘B: the palette is mounted once here, and the sidebar's Search
          row opens the same one (`command-palette.tsx`). */}
      <CommandPaletteProvider>
        <ScreenTitleProvider>
          {/* First in the tree, deliberately: it has to be the first focusable element for a
              keyboard user's first Tab to land on it, ahead of the sidebar it exists to skip. */}
          <SkipNav />
          <MainSidebar />
          <SidebarInset
            id={MAIN_CONTENT_ID}
            // Not in the normal tab order — a keyboard user reaches it only via `SkipNav`'s href,
            // which needs the target to be programmatically focusable at all.
            tabIndex={-1}
            // While the sidebar is collapsed the floating toggle holds the top-left corner, and
            // below 1200px a `large` page's 24px gutter would run under it; 48px of padding
            // clears it. Wider, the centred page starts past it and nothing moves.
            className="h-svh min-h-0 min-w-0 md:max-[1200px]:peer-data-[state=collapsed]:pl-12"
          >
            <MobileTopBar />
            <CollapsedSidebarToggle />
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </SidebarInset>
          <CommandPalette />
        </ScreenTitleProvider>
      </CommandPaletteProvider>
    </SidebarProvider>
  );
}
