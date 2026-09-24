import { type ReactNode, useState } from "react";

import { StatusChip } from "@/components/status-chip";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { CONNECTION_FIELD_CHIP } from "@/lib/status-chips";

type ControlProps = {
  id: string;
  disabled?: boolean;
  className?: string;
  "aria-describedby": string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

/** Editable details with required-entry and validation states; secrets stay write-only (ADR 0006). */
export function ConnectionField({
  id,
  label,
  value,
  required = false,
  incomplete = !value.trim(),
  secret = false,
  hint,
  error,
  disabled,
  children,
}: {
  id: string;
  label: string;
  value: string;
  required?: boolean;
  incomplete?: boolean;
  secret?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
  children: (props: ControlProps) => ReactNode;
}) {
  // Compare changes against non-secret defaults without copying credentials into this state.
  const [initialValue] = useState(() => (secret || incomplete ? "" : value));
  const prefilled = initialValue !== "";
  const missing = required && incomplete;
  const status = error
    ? "invalid"
    : missing
      ? "missing"
      : prefilled
        ? value !== initialValue
          ? "edited"
          : null
        : incomplete
          ? null
          : "entered";

  const describedBy = [status && `${id}-status`, hint && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");

  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <FieldLabel htmlFor={id}>
          {label}
          {required ? null : <span className="font-normal text-muted-foreground">(optional)</span>}
        </FieldLabel>
        {status ? (
          <span id={`${id}-status`}>
            <StatusChip chip={CONNECTION_FIELD_CHIP[status]} />
          </span>
        ) : null}
      </div>
      {children({
        id,
        disabled,
        className: missing && !error ? "border-primary/50 bg-primary/5" : undefined,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}
