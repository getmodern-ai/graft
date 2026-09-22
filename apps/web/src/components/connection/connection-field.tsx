import { type ReactNode, useEffect, useState } from "react";

import { EditIcon } from "@/components/icons";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { CONNECTION_FIELD_CHIP } from "@/lib/status-chips";

type ControlProps = {
  id: string;
  readOnly: boolean;
  disabled?: boolean;
  tabIndex?: number;
  className?: string;
  "aria-describedby": string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

/** Supplied details stay readable until Edit; secrets stay in their entry controls (ADR 0006). */
export function ConnectionField({
  id,
  label,
  value,
  required = false,
  incomplete = !value.trim(),
  secret = false,
  alwaysEditable = false,
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
  alwaysEditable?: boolean;
  hint?: string;
  error?: string;
  disabled?: boolean;
  children: (props: ControlProps) => ReactNode;
}) {
  // Snapshot only non-secret defaults; typing into an empty field must never lock it mid-entry.
  const [initialValue] = useState(() => (secret || incomplete ? "" : value));
  const [editing, setEditing] = useState(false);
  const prefilled = initialValue !== "";
  const readOnly = prefilled && !alwaysEditable && !editing && !error && value === initialValue;
  const missing = required && incomplete;
  const status = error
    ? "invalid"
    : missing
      ? "missing"
      : prefilled
        ? value !== initialValue
          ? "edited"
          : editing
            ? "editing"
            : "prefilled"
        : incomplete
          ? null
          : "entered";

  useEffect(() => {
    if (editing) document.getElementById(id)?.focus();
  }, [editing, id]);

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
        <div className="flex items-center gap-1.5">
          {status ? (
            <span id={`${id}-status`}>
              <StatusChip chip={CONNECTION_FIELD_CHIP[status]} />
            </span>
          ) : null}
          {readOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Edit ${label}`}
              aria-controls={id}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <EditIcon />
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      {children({
        id,
        readOnly,
        disabled,
        tabIndex: readOnly ? -1 : undefined,
        className: readOnly
          ? "bg-muted/50"
          : missing && !error
            ? "border-primary/50 bg-primary/5"
            : undefined,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}
