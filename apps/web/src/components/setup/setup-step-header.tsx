import type * as React from "react";
import { createContext, useContext } from "react";

/**
 * The eyebrow every step's heading wears ("Step 3 of 4 · Tool"), provided once by the page from the
 * state (`setupEyebrow`), so a step component names only its own title.
 */
export const SetupEyebrowContext = createContext<string | null>(null);

/**
 * A step's heading, Setup v2's hero (the Figma frames' `Hero`): the eyebrow in `xs` muted, the
 * page's `h1` at the heading size with its tracking, an optional mark beside it (the integration's
 * logo on the tool step), and one sentence under it in `lg` muted, all centred over the step.
 */
export function SetupStepHeader({
  title,
  description,
  media,
}: {
  title: string;
  description: React.ReactNode;
  media?: React.ReactNode;
}) {
  const eyebrow = useContext(SetupEyebrowContext);
  return (
    <header className="flex flex-col items-center gap-2 text-center">
      {eyebrow ? (
        <p className="font-medium text-muted-foreground text-xs uppercase">{eyebrow}</p>
      ) : null}
      <div className="flex items-center justify-center gap-3">
        {media}
        <h1 className="text-balance font-heading font-medium text-3xl tracking-tight md:text-4xl">
          {title}
        </h1>
      </div>
      <p className="max-w-2xl text-balance text-lg text-muted-foreground">{description}</p>
    </header>
  );
}
