import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The page column — `data-slot="page-container"` in Cando's design-system file.
 *
 * The four fixed widths land exactly on Tailwind's scale (1152 / 896 / 672 / 448), so they map
 * to max-w steps rather than arbitrary values; `mx-auto w-full` is the fluid equivalent of the
 * fixed frame the system draws. Padding is 24px on every side, except `xs`, whose slot sits 16px
 * in horizontally.
 *
 * A plain record rather than `cva`, as in Cando: the variant is a single lookup.
 *
 * Cando's `apps/web/src/components/page/page-container.tsx`, with the import rewrite (GRA-46).
 */
const SIZES = {
  large: "max-w-6xl",
  medium: "max-w-4xl",
  small: "max-w-2xl",
  xs: "max-w-md px-4",
  /* Fluid, not a fifth fixed width: the column runs the container's width minus the same 24px
     gutters the base carries. */
  full: "max-w-none",
} as const;

type PageContainerSize = keyof typeof SIZES;

function PageContainer({
  className,
  size = "large",
  ...props
}: React.ComponentProps<"div"> & { size?: PageContainerSize }) {
  return (
    <div
      data-slot="page-container"
      data-size={size}
      className={cn("mx-auto flex w-full flex-col p-6", SIZES[size], className)}
      {...props}
    />
  );
}

export { PageContainer, type PageContainerSize };
