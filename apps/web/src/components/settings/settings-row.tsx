import * as React from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The settings row family, from Cando's Settings spec board — its
 * `apps/web/src/components/settings/settings-row.tsx`, with the import rewrites (GRA-47).
 *
 * Every row is the same frame — space-between, centred, `px-4 py-3` — differing
 * only in what sits on the right. `SettingsRow` is that frame plus the standard
 * label/description stack; the variants below fill in the control.
 *
 * Labels are Regular weight, not medium. That is what the spec says, and it is a
 * deliberate departure from the ad-hoc rows this replaces.
 *
 * The type ramp is `text-base` over `text-sm` — 16/24 above 14/20, per the row's
 * own frame in the product designs. The description wraps rather than truncating,
 * which is the other thing the frame shows: it is a sentence, and a clipped
 * sentence is worse than a two-line one.
 */
function SettingsRow({
  title,
  description,
  action,
  className,
  stacked,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * Stacks the action full-width below the title/description at the base breakpoint, and returns
   * to the side-by-side row from `md` up — for a row whose control is a button or a field rather
   * than something that fits beside a label at 390px (Cando's CAN-390).
   *
   * **Not `SettingsFieldRow`.** That row already stacks a label above a full-width control, but
   * it has no `description` slot and forces a fixed `md:h-16` at desktop — right for a single-line
   * label beside a 240px input, wrong for a row whose description runs to two lines. `stacked`
   * layers onto this row's own auto-height, description-bearing shape instead.
   *
   * The caller's `action` still has to carry its own `w-full md:w-auto` (or equivalent) — this
   * wrapper decides whether the *row* offers the action the full width, not whether the control
   * drawn inside it takes it.
   */
  stacked?: boolean;
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3",
        stacked && "flex-col items-start gap-3 py-4 md:flex-row md:items-center md:gap-4 md:py-3",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col">
        <div className="truncate text-base">{title}</div>
        {description ? <div className="text-muted-foreground text-sm">{description}</div> : null}
      </div>
      {action ? (
        <div className={cn("shrink-0", stacked && "w-full md:w-auto")}>{action}</div>
      ) : null}
    </div>
  );
}

/**
 * A labelled toggle. **The label is wired here rather than left to the caller** (Cando's CAN-133):
 * a title in a `<div>` beside a control is proximity rather than association, and every switch
 * drawn that way reached a screen reader as "switch, off". The row is the thing that knows a title
 * and a control belong to each other, so it is where the association is made.
 *
 * `aria-labelledby` rather than `aria-label`, so the accessible name **is** the visible text rather
 * than a second copy of it that can drift — and so `title` may stay a `ReactNode`. The description
 * is deliberately *not* wired as `aria-describedby`: a description is announced after a pause and
 * some settings verbosity suppresses it entirely, so it is not a place to put something
 * load-bearing.
 */
function SettingsToggleRow({
  checked,
  onCheckedChange,
  disabled,
  title,
  ...props
}: React.ComponentProps<typeof SettingsRow> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const titleId = React.useId();

  return (
    <SettingsRow
      data-slot="settings-toggle-row"
      title={<span id={titleId}>{title}</span>}
      action={
        <Switch
          aria-labelledby={titleId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
        />
      }
      {...props}
    />
  );
}

/**
 * A fixed 64px row without a description, because the spec sizes it around the
 * control rather than the text. The control itself is 240px there — pass
 * `className="w-60"` to match.
 *
 * Named for the select the spec draws in it, but the geometry is what it
 * contributes: any 32px-tall, 240px-wide control belongs in this row.
 */
function SettingsSelectRow({
  title,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="settings-select-row"
      className={cn("flex h-16 items-center justify-between gap-4 px-4", className)}
      {...props}
    >
      <div className="truncate text-base">{title}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function SettingsButtonRow(props: React.ComponentProps<typeof SettingsRow>) {
  return <SettingsRow data-slot="settings-button-row" {...props} />;
}

/**
 * A labelled control that stacks below its label at the base breakpoint and sits beside it,
 * fixed at 240px, from `md` up (Cando's CAN-362). The mobile frame draws this as a different row
 * than the desktop one, not the same row squeezed to fit: a 240px control alongside a label
 * leaves too little room once the column drops to 390px, so the frame gives the control the
 * row's full width and moves it below the label instead.
 *
 * The action is still responsible for its own width (`w-full md:w-60`) — the wrapper only decides
 * whether the control's row is full width or shrink-wrapped.
 */
function SettingsFieldRow({
  title,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="settings-field-row"
      className={cn(
        "flex flex-col items-start gap-3 p-4 md:h-16 md:flex-row md:items-center md:justify-between md:gap-4 md:px-4 md:py-0",
        className,
      )}
      {...props}
    >
      <div className="truncate text-base">{title}</div>
      {action ? <div className="w-full shrink-0 md:w-auto">{action}</div> : null}
    </div>
  );
}

/** A row frame with no label — the whole width is a slot for whatever the caller needs. */
function SettingsEmptyRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-empty-row"
      className={cn("flex items-center justify-between gap-4 px-4 py-3", className)}
      {...props}
    />
  );
}

export {
  SettingsButtonRow,
  SettingsEmptyRow,
  SettingsFieldRow,
  SettingsRow,
  SettingsSelectRow,
  SettingsToggleRow,
};
