import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A 48px navigation strip that sits over the page column — space-between, so two children land
 * at either end. The 24px gutters and the bottom rule are the component's own.
 *
 * Not hidden below `md` here: the one shell that mounts it (`shell/app-shell.tsx`) hides its own
 * instance, because `MobileTopBar` stands in for the strip at that width. Cando keeps the class
 * out of the base for a screen that renders the strip with no top bar above it (its
 * `page-nav.tsx`, CAN-352); the console has no such screen today, and the rule is kept where
 * Cando keeps it so one can arrive without touching this file.
 *
 * Cando's `apps/web/src/components/page/page-nav.tsx`, with the import rewrite (GRA-46).
 */
function PageNav({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="page-nav"
      className={cn("flex h-12 items-center justify-between gap-2.5 border-b px-6", className)}
      {...props}
    />
  );
}

/**
 * The strip title's sub-page half. In the breadcrumb the parent title is muted and ends in a
 * slash; this is the part after it, in full foreground, so "Agents / hermes-laptop" reads as
 * where you are rather than two labels.
 */
function PageNavSubPageTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="page-nav-sub-page-title"
      className={cn("flex items-center gap-3 font-medium text-base text-foreground", className)}
      {...props}
    />
  );
}

export { PageNav, PageNavSubPageTitle };
