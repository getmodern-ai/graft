import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The page header — a growing text column on the left, hugging actions on the right.
 *
 * Items align to the top rather than centre, so a two-line description keeps the actions level
 * with the title instead of pushing them down the block.
 *
 * Cando's `apps/web/src/components/page/page-header.tsx`, with the import rewrite (GRA-46).
 */
function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header"
      className={cn("flex items-start justify-between gap-2.5", className)}
      {...props}
    />
  );
}

function PageHeaderContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      {...props}
    />
  );
}

/** Renders an `h1` — this is the page's heading, not just text at heading size. */
function PageHeaderTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-header-title"
      className={cn("font-medium text-2xl text-foreground", className)}
      {...props}
    />
  );
}

function PageHeaderDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-header-description"
      className={cn("text-base text-muted-foreground", className)}
      {...props}
    />
  );
}

function PageHeaderActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn("flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  );
}

export { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle };
