import type * as React from "react";

/**
 * A titled group of settings cards, with an optional line under the title (GRA-331; App v2's
 * section header, Figma 2100:10414).
 *
 * 16px between the header and its card, against the 40px the settings column puts between
 * sections, which is what keeps a heading reading as belonging to the card under it; 2px between
 * the title and its line. Renders an `h2`: the page title above it is the `h1`, so this is the
 * next level down rather than text at heading size.
 *
 * Cando's `apps/web/src/components/settings/settings-section.tsx` (GRA-47), with the description
 * and App v2's spacing.
 */
export function SettingsSection({
  heading,
  description,
  children,
}: {
  heading: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-heading font-medium text-lg">{heading}</h2>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
