import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Setup v2's app card (the Figma frames' `App / Gmail`, on the connect, building, done and failed
 * screens): a bordered card, 24px in, a header row of the integration's 32px mark, its name in the
 * `xl` heading size with an optional chip beside it, one muted line under it, and the card's action
 * or state at the end; then whatever the step puts under it, usually a `SetupTaskRow`.
 */
export function SetupAppCard({
  media,
  name,
  chip,
  subline,
  action,
  children,
  className,
}: {
  media: React.ReactNode;
  name: React.ReactNode;
  chip?: React.ReactNode;
  subline?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("flex w-full flex-col gap-4 rounded-lg border bg-card p-4 md:p-6", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        {media}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading font-medium text-xl tracking-tight">{name}</h2>
            {chip}
          </div>
          {subline ? <p className="text-muted-foreground text-sm">{subline}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The tool's row inside an app card (the frames' `Tool / …`): the muted band, a 20px state glyph,
 * the task, a short note at the end ("Waits for Gmail", "Reading the documentation · 1 of 5"),
 * and, while it builds, the primary bar under it at `progress` (0 to 1).
 */
export function SetupTaskRow({
  icon,
  task,
  note,
  progress,
}: {
  icon: React.ReactNode;
  task: React.ReactNode;
  note?: React.ReactNode;
  progress?: number | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted/50 px-4 py-3">
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 font-medium text-sm">{task}</p>
          {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
        </div>
        {progress != null ? (
          <div
            role="progressbar"
            aria-label="Build progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-1 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.max(4, progress * 100)}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
