import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The Graft mark: the letter G, centred in a rounded square. **A placeholder until Graft has a
 * brand** — the same letter the console shipped with, and the same status the docs repository
 * gives its wordmark. Nothing here is a logo; when one is decided it is made in Figma and
 * imported the way ADR 0017 describes, and only the artwork in this file changes.
 *
 * An inline SVG rather than a styled `<span>` so the letter scales with the square — `size-6` in
 * the sidebar header, `size-8` on the auth doors — without a font-size per mount. Drawn in tokens:
 * the tile is `--foreground` and the letter `--background`, so the mark inverts with the mode on
 * its own and needs none of the `dark:invert` Cando's flat exported artwork does (its
 * `agent-rail.tsx`, CAN-130); the colour guard reads no literal here because there is none.
 *
 * `aria-hidden`: every mount sits beside the product's name in text, which is what a reader is
 * told.
 */
export function GraftMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("shrink-0", className)} {...props}>
      <rect width="32" height="32" rx="7" className="fill-foreground" />
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="19"
        className="fill-background font-medium"
      >
        G
      </text>
    </svg>
  );
}
