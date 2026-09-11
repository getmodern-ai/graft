import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The settings surface container — `data-slot="settings-card"` in Cando's design-system file.
 *
 * Chrome only. Put a `SettingsCardContent` inside for free-form content, or a
 * `SettingsRowGroup` to stack rows; the rows bring their own padding, so a card
 * that padded its children as well would double the inset.
 *
 * Cando's `apps/web/src/components/settings/settings-card.tsx`, with the import rewrite (GRA-47).
 */
function SettingsCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-card"
      className={cn("overflow-hidden rounded-xl border border-foreground/10 bg-card", className)}
      {...props}
    />
  );
}

function SettingsCardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="settings-card-content" className={cn("p-4", className)} {...props} />;
}

/**
 * Stacks settings rows, divided. The rows supply their own padding.
 *
 * The divider is inset 16px from both edges, which is what the spec draws — a
 * `Separator` instance between rows, itself padded, rather than a line across the
 * card. `divide-y` cannot be inset, so each row after the first gets a
 * pseudo-element instead. Tailwind v4 supplies `content: ""` with `before:`, so
 * there is none to declare.
 *
 * `border-border` is not redundant. The base layer's `* { @apply border-border }`
 * does **not** match pseudo-elements, so a `::before` with only `border-t` takes
 * `currentColor` — a near-black line at text colour, which is what Cando shipped
 * until it was measured in the browser.
 */
function SettingsRowGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-row-group"
      className={cn(
        "[&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:border-border [&>*+*]:before:border-t",
        className,
      )}
      {...props}
    />
  );
}

export { SettingsCard, SettingsCardContent, SettingsRowGroup };
