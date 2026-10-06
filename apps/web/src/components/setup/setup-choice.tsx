import type * as React from "react";

import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { cn } from "@/lib/utils";

export type SetupChoiceOption<T extends string> = {
  value: T;
  label: string;
  description?: React.ReactNode;
  /** Beside the label: a chip, a badge. */
  aside?: React.ReactNode;
};

/**
 * One choice among a few, each option an `Item` in its outline frame (the connection picker's
 * shape, `connection-picker.tsx`) wrapping a native radio, so the group is a real radio group:
 * arrow keys move the choice, Tab leaves it, and a screen reader hears the label and the line
 * under it. The radio is transparent and laid over the whole frame, so a press anywhere on the
 * card, its name and its sentence included, lands on the radio itself rather than relying on the
 * label to forward it (GRA-206's live test found a press on a vendor's name that selected
 * nothing). The frame carries the state: `primary` on the chosen option's border, the ring on
 * the focused one; the drawn dot beneath is decoration. Composed for Setup (ADR 0017's delta): the
 * console has no radio primitive, and a `Select` would hide the one line under each harness that
 * is the reason to show them as a list.
 */
export function SetupChoice<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  name: string;
  legend: string;
  options: readonly SetupChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <fieldset className={cn("grid gap-2.5 sm:grid-cols-2", className)} disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <Item
          key={option.value}
          variant="outline"
          // biome-ignore lint/a11y/noLabelWithoutControl: the radio and the label's text are the Item's children, which the rule cannot see through `render`.
          render={<label htmlFor={`${name}-${option.value}`} />}
          className="relative cursor-pointer hover:bg-muted/50 has-disabled:cursor-not-allowed has-checked:border-primary has-focus-visible:border-ring has-checked:bg-muted/50 has-disabled:opacity-50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
        >
          {/* Out of `ItemMedia`, whose transform would otherwise be the box it covers. */}
          <input
            id={`${name}-${option.value}`}
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-lg opacity-0 disabled:cursor-not-allowed"
          />
          <ItemMedia>
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 items-center justify-center rounded-full border border-input",
                value === option.value ? "border-primary" : null,
              )}
            >
              {value === option.value ? <span className="size-2 rounded-full bg-primary" /> : null}
            </span>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              {option.label}
              {option.aside}
            </ItemTitle>
            {option.description ? <ItemDescription>{option.description}</ItemDescription> : null}
          </ItemContent>
        </Item>
      ))}
    </fieldset>
  );
}
