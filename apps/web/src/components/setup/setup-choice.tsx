import type * as React from "react";

import { CheckCircleIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export type SetupChoiceOption<T extends string> = {
  value: T;
  label: string;
  description?: React.ReactNode;
  /** Beside the label: a chip, a badge. */
  aside?: React.ReactNode;
  /** The mark in the card's top left (`SetupLogo`). */
  media?: React.ReactNode;
  /** Drawn dashed and on the muted band, as the frames draw *Anything else*. */
  dashed?: boolean;
};

/**
 * One choice among a few, drawn as Setup v2's selection cards (the Figma frames' harness and app
 * cards): a bordered card with the mark, the label and the line under it, and the radio in its top
 * right. Each card wraps a native radio, so the group is a real radio group: arrow keys move the
 * choice, Tab leaves it, and a screen reader hears the label and the line under it. The radio is
 * transparent and laid over the whole card, so a press anywhere lands on the radio itself (GRA-206's
 * live test found a press on a vendor's name that selected nothing). The card carries the state:
 * `primary` on the chosen card's border over a primary wash, the ring on the focused one; the drawn
 * dot is decoration. `layout="row"` puts the mark beside the text (the harness cards),
 * `layout="stack"` above it (the integration cards).
 */
export function SetupChoice<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
  className,
  layout = "row",
  variant = "radio",
}: {
  name: string;
  legend: string;
  options: readonly SetupChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  layout?: "row" | "stack";
  /**
   * `task`: the tool screen's cards (the frames' idea cards), the label in the base size, no drawn
   * radio, and a check in the primary colour on the chosen one.
   */
  variant?: "radio" | "task";
}) {
  return (
    <fieldset
      className={cn(
        "grid gap-4",
        layout === "row" ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
      disabled={disabled}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className={cn(
              "relative flex cursor-pointer gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50",
              layout === "row" ? "items-center" : "flex-col items-start",
              variant === "task" ? "min-h-24 items-start" : null,
              option.dashed ? "border-dashed bg-muted/50" : null,
              "has-disabled:cursor-not-allowed has-disabled:opacity-50",
              "has-checked:border-primary has-checked:bg-primary/5",
              "has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
            )}
          >
            <input
              id={`${name}-${option.value}`}
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-lg opacity-0 disabled:cursor-not-allowed"
            />
            {option.media}
            <span className="flex min-w-0 flex-1 flex-col gap-1 pr-6">
              <span
                className={cn(
                  "flex flex-wrap items-center gap-2 font-medium",
                  variant === "task" ? "text-base" : "text-sm",
                )}
              >
                {option.label}
                {option.aside}
              </span>
              {option.description ? (
                <span className="text-muted-foreground text-xs">{option.description}</span>
              ) : null}
            </span>
            {variant === "task" ? (
              checked ? (
                <CheckCircleIcon
                  aria-hidden="true"
                  className="absolute top-4 right-4 size-5 text-primary"
                />
              ) : null
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-4 right-4 flex size-4 items-center justify-center rounded-full border border-input bg-background",
                  checked ? "border-primary" : null,
                )}
              >
                {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
