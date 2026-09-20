import type { AgentScopeMode } from "@graft/core";

import { ConnectionPicker } from "@/components/connection/connection-picker";
import { RetryNotice } from "@/components/retry-notice";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { Connection } from "@/lib/connection-queries";
import { readScopeMode, SCOPE_MODE_DESCRIPTION, SCOPE_MODE_ITEMS } from "@/lib/scope-mode";

/**
 * The scope as a form field (CONTEXT.md, *Scope*; ADR 0007 as amended 2026-09-19): the mode as
 * the `Select` primitive with `items` on the root, as every fixed choice in the console is
 * (AGENTS.md), and under `Limit to these` the picker the scope always was. The create dialog and
 * the consent card mount it inside their own `FieldGroup`; the agent page's Scope section draws
 * the same choice inside its card (`scope-editor.tsx`) with its own save.
 *
 * The connections arrive from a read the parent started without awaiting, so the field can show
 * before they have: `connections` is `undefined` until then, and under `listed` the picker's place
 * holds skeleton rows — or the same Retry a table body carries when the read failed. Under `all`
 * nothing is chosen from the list, so the parent may let its submit proceed without it.
 */
export function ScopeModeField({
  id,
  mode,
  onModeChange,
  selected,
  onSelectedChange,
  connections,
  connectionsFailed,
  disabled,
}: {
  id: string;
  mode: AgentScopeMode;
  onModeChange: (mode: AgentScopeMode) => void;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** The person's connections, or `undefined` while the read is pending or has failed. */
  connections: readonly Connection[] | undefined;
  /** Set while the connections read has failed: what to show and how to try again. */
  connectionsFailed?: { error: unknown; onRetry: () => void; retrying: boolean };
  disabled?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Scope</FieldLabel>
      <Select
        value={mode}
        items={SCOPE_MODE_ITEMS}
        disabled={disabled}
        onValueChange={(next) => {
          const read = readScopeMode(next);
          if (read) onModeChange(read);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCOPE_MODE_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{SCOPE_MODE_DESCRIPTION[mode]}</FieldDescription>
      {mode === "listed" ? (
        connections ? (
          <ConnectionPicker
            connections={connections}
            selected={selected}
            onChange={onSelectedChange}
            disabled={disabled}
          />
        ) : connectionsFailed ? (
          <p className="text-muted-foreground text-sm">
            <RetryNotice
              error={connectionsFailed.error}
              message="Could not load your connections."
              onRetry={connectionsFailed.onRetry}
              retrying={connectionsFailed.retrying}
            />
          </p>
        ) : (
          // Two rows at the picker's own height, so the form does not jump when it lands.
          <div className="flex flex-col gap-2.5" aria-busy="true">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        )
      ) : null}
    </Field>
  );
}
