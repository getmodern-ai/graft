import type { SetupNavigationFields, SetupStep } from "@graft/core/setup/setup.rules";

import { CheckIcon } from "@/components/icons";
import {
  backStepOf,
  type SetupBackStep,
  type SetupRailEntry,
  setupProgress,
  setupRail,
} from "@/lib/setup-steps";
import { cn } from "@/lib/utils";

type RailProps = {
  step: SetupStep;
  /** The record, so the rail can say which steps it can go back to (`setupRail`). */
  record?: SetupNavigationFields | null;
  /** The back move, the footer's own (`useSetupBack`). */
  onBack?: (step: SetupBackStep) => void;
  /** A move in flight: every link waits for it. */
  pending?: boolean;
};

/**
 * Setup's steps, down the left of the page at `md` and up (ADR 0024; GRA-202, *Layout*). Cando has
 * no stepper, so this is composed from its tokens rather than copied (ADR 0017; the pull request's
 * delta list): the sidebar menu's 32px rows and `text-sm` labels, a 24px marker per step in the
 * `muted` band a sidebar badge wears, `primary` for the current step's marker and a check for a
 * step done. The current step is `aria-current="step"`, so a screen reader hears where the person
 * is without the colour.
 *
 * **Navigable** (GRA-215): every step the record completed, and the current one, is a button with
 * the sidebar menu's hover (`hover:bg-muted`); a completed one returns the record to it through the
 * back move, the footer's Back for the step before. A step ahead is plain text, never a link.
 */
export function SetupRail({ step, record, onBack, pending }: RailProps) {
  return (
    <nav aria-label="Setup steps">
      <ol className="flex flex-col gap-1">
        {setupRail(step, record).map((entry) => (
          <li key={entry.step}>
            <RailRow entry={entry} onBack={onBack} pending={pending} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function RailRow({
  entry,
  onBack,
  pending,
}: {
  entry: SetupRailEntry;
  onBack?: (step: SetupBackStep) => void;
  pending?: boolean;
}) {
  const current = entry.state === "current";
  const className = cn(
    "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm",
    current ? "bg-muted font-medium text-foreground" : null,
    entry.state === "upcoming" ? "text-muted-foreground" : null,
  );
  const content = (
    <>
      <Marker entry={entry} />
      <span>{entry.label}</span>
      {entry.state === "done" ? <span className="sr-only">(done)</span> : null}
    </>
  );
  const target = backStepOf(entry.step);
  if (!entry.link || !onBack) {
    return (
      <div aria-current={current ? "step" : undefined} className={className}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-current={current ? "step" : undefined}
      disabled={pending}
      onClick={() => {
        if (!current && target) onBack(target);
      }}
      className={cn(
        className,
        "outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-wait",
      )}
    >
      {content}
    </button>
  );
}

function Marker({ entry, compact }: { entry: SetupRailEntry; compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
        compact ? "size-7" : "size-6",
        entry.state === "current"
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground",
      )}
    >
      {entry.state === "done" ? <CheckIcon className="size-3.5" /> : entry.position}
    </span>
  );
}

/**
 * The rail below `md`, collapsed to one line above the step: which of seven, a bar in the
 * `primary` token over the `muted` track, and (GRA-215) the seven markers in a row, the completed
 * ones buttons that go back as the rail's rows do, each named for its step.
 */
export function SetupProgress({ step, record, onBack, pending }: RailProps) {
  const progress = setupProgress(step);
  const entries = setupRail(step, record);
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
      {entries.some((entry) => entry.link && entry.state === "done") && onBack ? (
        <nav aria-label="Setup steps">
          <ol className="flex flex-wrap gap-1.5">
            {entries.map((entry) => {
              const target = backStepOf(entry.step);
              const back = entry.link && entry.state === "done" && target;
              return (
                <li key={entry.step}>
                  {back ? (
                    <button
                      type="button"
                      aria-label={`Back to ${entry.label}`}
                      disabled={pending}
                      onClick={() => onBack(target)}
                      className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <Marker entry={entry} compact />
                    </button>
                  ) : (
                    <span aria-current={entry.state === "current" ? "step" : undefined}>
                      <Marker entry={entry} compact />
                      <span className="sr-only">{entry.label}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
    </div>
  );
}
