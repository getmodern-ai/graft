import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The Graft mark — the same drawing as `public/favicon.svg`, as an inline SVG so it can take the
 * theme's tokens. The favicon bakes its colours in because a browser tab has no stylesheet; here
 * the tile is `--foreground`, the G is `--background` and the graft stroke is `--primary`, so the
 * mark inverts with the mode on its own and needs none of the `dark:invert` Cando's flat
 * exported artwork does (its `agent-rail.tsx`, CAN-130). A guard reads no colour literal here
 * because there is none (ADR 0017).
 *
 * Sized by the caller — `size-6` in the sidebar header, `size-8` on the auth doors — and
 * `aria-hidden`: every mount sits beside the product's name in text, which is what a reader is
 * told.
 */
export function GraftMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("shrink-0", className)} {...props}>
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <path
        d="M10 22V10h7.5a4.5 4.5 0 0 1 0 9H13"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-background"
      />
      <path
        d="M17 19l5 3"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-primary"
      />
    </svg>
  );
}
