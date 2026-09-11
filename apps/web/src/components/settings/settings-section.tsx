import type * as React from "react";

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
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-lg">{heading}</h2>
      {children}
    </section>
  );
}
