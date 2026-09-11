import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The expand/collapse control — the primitive's trigger dressed with the state-aware label, the
 * tooltip, and the ⌘B hint.
 *
 * One component for the two desktop surfaces that draw it: the sidebar's own header
 * (`main-sidebar.tsx`) and the page strip's collapsed control (`page-nav-collapsed-sidebar.tsx`)
 * — shared so the label and the shortcut hint cannot drift between them.
 *
 * Cando's `apps/web/src/components/shell/sidebar-toggle.tsx` (its CAN-326), with one change: the
 * hint is the `Kbd` primitive rather than Cando's hand-styled `<kbd>`, because the primitive
 * already carries the on-tooltip colours (`in-data-[slot=tooltip-content]:…` in `ui/kbd.tsx`)
 * that the raw element restated (GRA-46).
 */
export function SidebarToggle({ className }: { className?: string }) {
  const { state, isMobile, openMobile } = useSidebar();
  // Below `md` the trigger drives the sheet, whose state is `openMobile` — `state` is the desktop
  // cookie's, so labelling from it would announce "Expand sidebar" on a control that closes the
  // open menu. "Menu", because at that width the sidebar *is* the mobile menu. The ⌘B hint stays:
  // `isMobile` is a width, and a narrow desktop window still has the keyboard.
  const label = isMobile
    ? openMobile
      ? "Close menu"
      : "Open menu"
    : state === "collapsed"
      ? "Expand sidebar"
      : "Collapse sidebar";

  return (
    <Tooltip>
      <TooltipTrigger
        render={<SidebarTrigger aria-label={label} className={cn("size-6", className)} />}
      />
      <TooltipContent side="right" className="flex items-center gap-2">
        {label}
        <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
