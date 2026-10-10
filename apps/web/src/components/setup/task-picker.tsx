import { useState } from "react";

import { EditIcon, StarsIcon } from "@/components/icons";
import { SetupChoice } from "@/components/setup/setup-choice";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The tool screen's choice (Setup v2, *Tools*): one read-only task among the cards, or one the
 * person describes in the row under them. Single-select across both (the 2026-09-29 decision 1):
 * picking a card clears nothing the person typed, but the card is the task; typing makes the
 * described task the choice. `tasks` empty is the frames' Airtable state: no ready-made tasks, and
 * the described row is the whole input, with the empty sentence under it.
 */
export function TaskPicker({
  tasks,
  value,
  onChange,
  integrationName,
  disabled,
}: {
  tasks: readonly string[];
  value: string;
  onChange: (task: string) => void;
  integrationName: string;
  disabled?: boolean;
}) {
  const fromCards = tasks.includes(value);
  const [described, setDescribed] = useState(fromCards ? "" : value);
  const custom = !fromCards && value.trim() !== "";

  const describeRow = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border p-1.5 pl-3 transition-colors",
        custom ? "border-primary bg-primary/5" : "border-input",
      )}
    >
      <EditIcon className="size-4 shrink-0 text-muted-foreground" />
      <Input
        aria-label={`Describe your own read-only tool for ${integrationName}`}
        placeholder={
          tasks.length > 0
            ? `Or describe your own read-only tool for ${integrationName}`
            : "Describe what the tool should read"
        }
        className="border-0 bg-transparent shadow-none focus-visible:ring-0"
        value={described}
        disabled={disabled}
        onChange={(event) => {
          setDescribed(event.target.value);
          onChange(event.target.value);
        }}
        onFocus={() => {
          if (described.trim()) onChange(described);
        }}
      />
    </div>
  );

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-medium text-muted-foreground text-sm">Describe the tool</p>
        {describeRow}
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
          <span className="flex size-8 items-center justify-center rounded-md bg-secondary">
            <StarsIcon className="size-4" />
          </span>
          <p className="font-medium">No ready-made tools for {integrationName} yet</p>
          <p className="max-w-sm text-muted-foreground text-sm">
            Say what you need above, in a sentence. Graft reads the documentation and builds one
            read-only tool for it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
        <p className="font-medium text-sm">What Graft can build for {integrationName}</p>
        <p className="text-xs">All read-only</p>
      </div>
      <SetupChoice
        name="setup-task"
        legend={`Tasks for ${integrationName}`}
        variant="task"
        options={tasks.map((task) => ({ value: task, label: task }))}
        value={fromCards ? value : null}
        onChange={onChange}
        disabled={disabled}
      />
      {describeRow}
    </div>
  );
}
