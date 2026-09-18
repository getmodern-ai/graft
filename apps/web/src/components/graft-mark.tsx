import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The Graft mark: three branching waves, the artwork the marketing site (getgraft.ai) and the docs
 * carry since GRA-67, from the Figma frame *Graft / Marketing website*. It replaces the placeholder
 * G this file shipped with, and only the artwork changed, as that placeholder's comment promised.
 *
 * An inline SVG so the mark scales with its box — `size-6` in the sidebar header, `size-8` on the
 * auth doors. Drawn in tokens: every path is `--foreground`, so the mark inverts with the mode on
 * its own and needs none of the `dark:invert` Cando's flat exported artwork does (its
 * `agent-rail.tsx`, CAN-130); the colour guard reads no literal here because there is none. The
 * viewBox is the artwork's own aspect (about 7:5), so the mark is wider than it is tall inside a
 * square box and sits centred in it.
 *
 * `aria-hidden`: every mount sits beside the product's name in text, which is what a reader is
 * told.
 */
export function GraftMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 55.7256 40"
      aria-hidden="true"
      className={cn("shrink-0 fill-foreground", className)}
      {...props}
    >
      <path d="M0 12.0636C4.87897 13.064 7.77783 16.7611 11.0732 21.0745C14.8196 25.9782 19.1124 31.7305 27.6639 31.7306V40C14.5825 40 8.01346 30.6426 4.55247 26.1124C2.38581 23.2765 1.06459 21.7543 0 20.9467V12.0636Z" />
      <path d="M0 0.142383C11.2788 1.32862 17.1646 9.68486 20.3754 13.8876C21.4206 15.2557 22.2692 16.318 22.987 17.142V11.7969C30.2465 11.7969 33.8676 16.0956 38.0049 21.1241C42.0678 26.0623 46.6471 31.7305 55.7255 31.7306V39.9997C42.3832 39.9997 35.5578 31.1218 31.6695 26.3958C29.972 24.3327 28.7291 22.9137 27.6639 21.9506V28.2031C21.0447 28.2031 17.7228 23.9886 13.8547 18.9255C10.5308 14.5748 6.77673 9.55709 0 8.48043V0.142383Z" />
      <path d="M22.9871 0C36.3295 -5.90074e-07 43.1548 8.87825 47.0431 13.6042C51.355 18.845 52.73 19.9337 55.7256 19.9337V28.2031C48.4661 28.2031 44.845 23.9042 40.7077 18.8756C36.6448 13.9374 32.0655 8.26944 22.9871 8.26944V0Z" />
    </svg>
  );
}
