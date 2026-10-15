import { SidebarToggle } from "@/components/shell/sidebar-toggle";
import { useSidebar } from "@/components/ui/sidebar";

/**
 * The way back to a collapsed sidebar at `md` and up: the same toggle the sidebar's header
 * carries by the wordmark, floating at the content column's top-left corner while the sidebar is
 * off canvas. App v2 draws no page strip to hold it (GRA-344), and ⌘B alone is not a visible way
 * back.
 *
 * It reads the sidebar's own context, so it renders exactly when the sidebar is collapsed at a
 * desktop width. Below `md` the sidebar is a sheet and `MobileTopBar` carries the one way into it.
 * `app-shell.tsx` pads the column while it shows, at the widths where a page would run under it.
 */
export function CollapsedSidebarToggle() {
  const { state, isMobile } = useSidebar();

  if (isMobile || state !== "collapsed") {
    return null;
  }

  return (
    <div data-slot="collapsed-sidebar-toggle" className="absolute top-3 left-3 z-10">
      <SidebarToggle className="size-8" />
    </div>
  );
}
