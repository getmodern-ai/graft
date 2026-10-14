import { Fragment } from "react";

import { CheckIcon } from "@/components/icons";
import type { SetupStageEntry } from "@/lib/setup-stages";
import { cn } from "@/lib/utils";

/**
 * Setup v2's stepper (the Figma frames' `Stepper`), centred in the top bar at `md` and up: the four
 * stages (`setupStages`) as 32px rows, a 24px marker in the `muted` band, the current one filled in
 * `foreground` with its number in the background's colour, a check on a stage done, and a 24px
 * connector between, solid once the stage before it is done. The current stage is
 * `aria-current="step"`, so a screen reader hears where the person is without the colour. It is a
 * picture of where the record stands, not a set of links: the footer's Back is the way back.
 */
export function SetupStepper({ stages }: { stages: readonly SetupStageEntry[] }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="flex items-center gap-2">
        {stages.map((entry, index) => (
          <Fragment key={entry.stage}>
            {index > 0 ? (
              <li
                aria-hidden="true"
                className={cn(
                  "h-0.5 w-6 rounded-full",
                  entry.state === "upcoming" ? "bg-border" : "bg-foreground",
                )}
              />
            ) : null}
            <li
              aria-current={entry.state === "current" ? "step" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm",
                entry.state === "current" ? "bg-muted font-medium" : null,
                entry.state === "upcoming" ? "text-muted-foreground" : null,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                  entry.state === "current"
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {entry.state === "done" ? <CheckIcon className="size-3.5" /> : entry.stage}
              </span>
              <span className="whitespace-nowrap">{entry.label}</span>
              {entry.state === "done" ? <span className="sr-only">(done)</span> : null}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** Below `md`: the eyebrow and four bars, the frames' mobile progress. */
export function SetupStepperCompact({
  stages,
  eyebrow,
}: {
  stages: readonly SetupStageEntry[];
  eyebrow: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{eyebrow}</p>
      <div className="grid grid-cols-4 gap-1" aria-hidden="true">
        {stages.map((entry) => (
          <span
            key={entry.stage}
            className={cn(
              "h-1 rounded-full",
              entry.state === "upcoming" ? "bg-muted" : "bg-foreground",
            )}
          />
        ))}
      </div>
    </div>
  );
}
