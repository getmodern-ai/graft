import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A titled group of settings cards.
 *
 * 12px between the heading and its card, against the 24px the settings column puts between
 * sections, which is what keeps a heading reading as belonging to the card under it. Renders an
 * `h2`: the page title above it is the `h1`, so this is the next level down rather than text at
 * heading size.
 *
 * Cando's `apps/web/src/components/settings/settings-section.tsx` (GRA-47).
 */
export function SettingsSection({
  heading,
  description,
  className,
  headingClassName,
  children,
}: {
  heading: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  headingClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div>
        <h2 className={cn("font-medium text-lg", headingClassName)}>{heading}</h2>
        {description ? <div className="text-muted-foreground text-sm">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}
