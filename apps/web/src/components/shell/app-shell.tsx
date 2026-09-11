import type * as React from "react";
import { useState } from "react";

import { PageNav } from "@/components/page/page-nav";
import { PageNavCollapsedSidebar } from "@/components/page/page-nav-collapsed-sidebar";
import { MainSidebar } from "@/components/shell/main-sidebar";
import { MobileTopBar } from "@/components/shell/mobile-top-bar";
import { ScreenTitle, ScreenTitleProvider } from "@/components/shell/screen-title";
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
 * grid: the top bar and the strip are `shrink-0` rows, and the screen scrolls in the row that is
 * left, which keeps the strip — and the collapsed-sidebar toggle it carries — on screen however
 * long the page.
 *
 * The strip is mounted here, once, rather than per screen as Cando mounts it; `screen-title.tsx`
 * says why, and what it feeds.
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
          className="h-svh min-h-0 min-w-0"
        >
          <MobileTopBar />
          {/* `hidden … md:flex`: below `md` the top bar above stands in for this strip. The
              collapsed-sidebar control leads the title whenever the sidebar is off canvas, by its
              own rule (`page-nav-collapsed-sidebar.tsx`). */}
          <PageNav aria-label="Page" className="hidden shrink-0 md:flex">
            <div className="flex min-w-0 items-center">
              <PageNavCollapsedSidebar />
              <ScreenTitle />
            </div>
          </PageNav>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </SidebarInset>
      </ScreenTitleProvider>
    </SidebarProvider>
  );
}
