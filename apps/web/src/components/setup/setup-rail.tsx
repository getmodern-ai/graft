import type { SetupStep } from "@graft/core/setup/setup.rules";

import { CheckIcon } from "@/components/icons";
import { setupProgress, setupRail } from "@/lib/setup-steps";
import { cn } from "@/lib/utils";

/**
 * Setup's steps, down the left of the page at `md` and up (ADR 0024; GRA-202, *Layout*). Cando has
 * no stepper, so this is composed from its tokens rather than copied (ADR 0017; the pull request's
 * delta list): the sidebar menu's 32px rows and `text-sm` labels, a 24px marker per step in the
 * `muted` band a sidebar badge wears, `primary` for the current step's marker and a check for a
 * step done. The current step is `aria-current="step"`, so a screen reader hears where the person
 * is without the colour.
 */
export function SetupRail({ step }: { step: SetupStep }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="flex flex-col gap-1">
        {setupRail(step).map((entry) => (
          <li
            key={entry.step}
            aria-current={entry.state === "current" ? "step" : undefined}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm",
              entry.state === "current" ? "bg-muted font-medium text-foreground" : null,
              entry.state === "upcoming" ? "text-muted-foreground" : null,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                entry.state === "current"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {entry.state === "done" ? <CheckIcon className="size-3.5" /> : entry.position}
            </span>
            <span>{entry.label}</span>
            {entry.state === "done" ? <span className="sr-only">(done)</span> : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The rail below `md`, collapsed to one line above the step: which of seven, and a bar in the
 * `primary` token over the `muted` track.
 */
export function SetupProgress({ step }: { step: SetupStep }) {
  const progress = setupProgress(step);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-muted-foreground text-sm">{progress.text}</p>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${progress.fraction * 100}%` }}
        />
      </div>
    </div>
  );
}
