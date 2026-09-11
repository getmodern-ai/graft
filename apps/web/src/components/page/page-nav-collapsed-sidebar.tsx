import { SidebarToggle } from "@/components/shell/sidebar-toggle";
import { Separator } from "@/components/ui/separator";
import { useSidebar } from "@/components/ui/sidebar";

/**
 * The expand control `PageNav` carries while the sidebar is collapsed — a 32px ghost toggle, an
 * 8px gap, a 24px vertical rule, and the rest of the fixed 56px as clearance before whatever
 * follows.
 *
 * It reads the sidebar's own context rather than taking an `isCollapsed` prop, so a page cannot
 * show it while the sidebar is open or forget it while closed — mounted in the strip, it renders
 * exactly when the sidebar is off canvas. Desktop only: below `md` the sidebar is a sheet and
 * `MobileTopBar` already carries the one way into it; a second trigger here would compete with
 * that one.
 *
 * The rule is drawn only when content follows the toggle, and this component cannot see its
 * siblings, so a strip that is otherwise empty passes `separator={false}`.
 *
 * Cando's `apps/web/src/components/page/page-nav-collapsed-sidebar.tsx` (its CAN-317, CAN-345),
 * with the import rewrites (GRA-46).
 */
export function PageNavCollapsedSidebar({ separator = true }: { separator?: boolean }) {
  const { state, isMobile } = useSidebar();

  if (isMobile || state !== "collapsed") {
    return null;
  }

  return (
    <div data-slot="page-nav-collapsed-sidebar" className="flex h-8 w-14 items-center gap-2">
      <SidebarToggle className="size-8" />
      {/* An explicit height wins over the base `self-stretch`, keeping the rule at 24px inside
          this 32px row. */}
      {separator ? <Separator orientation="vertical" className="h-6" /> : null}
    </div>
  );
}
