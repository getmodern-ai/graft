import { MenuIcon } from "@/components/icons";
import { ScreenTitle } from "@/components/shell/screen-title";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * The one 48px band a screen wears below `md`: a hamburger at the leading edge that opens the
 * sidebar's drawer, then the mounted screen's title. At `md` and up it is gone, and the page strip
 * in `app-shell.tsx` carries the same title beside the collapsed-sidebar toggle.
 *
 * Cando's `apps/web/src/components/shell/mobile-top-bar.tsx` (its CAN-352) without the agent
 * face and the actions slot — Graft has no agent faces, and its screens' actions live in
 * `PageHeaderActions` at every width. The title comes from `screen-title.tsx` rather than a slot
 * of this component's own; that file says why the two bars share one.
 *
 * Two deviations Cando records against its frame, carried over: the frame's 16px glyph gets a
 * 36px button, because 16px falls short of the 24px WCAG 2.2 minimum (SC 2.5.8); and there is no
 * search icon, because there is no search.
 */
export function MobileTopBar() {
  return (
    // A `div`, not a `header`. `SidebarInset` renders `<main>`, and per HTML-AAM a `header` scoped
    // to `main` maps to `generic` rather than `banner` — so the element would buy no landmark
    // while putting a second `<header>` beside whatever a screen renders inside that `<main>`.
    <div className="flex h-12 shrink-0 items-center gap-2 px-3 py-1.5 md:hidden">
      {/* `size="icon-lg"` is the 36px square; the glyph stays at the Button's default 16px.
          `touch-manipulation` opts the control out of double-tap-to-zoom, which is what a person
          gets instead of a second tap when the thing they are tapping is 36px wide. */}
      <SidebarTrigger aria-label="Open navigation" size="icon-lg" className="touch-manipulation">
        <MenuIcon />
      </SidebarTrigger>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ScreenTitle />
      </div>
    </div>
  );
}
