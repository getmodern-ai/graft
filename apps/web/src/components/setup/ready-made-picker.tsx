import { SetupChoice } from "@/components/setup/setup-choice";
import { Badge } from "@/components/ui/badge";
import type { SetupReadyMadeTool } from "@/lib/setup-queries";

/**
 * *Use a ready-made tool* (GRA-276; ADR 0025): the integration's stock tools Setup offers, drawn as
 * the tool screen's task cards above the tasks Graft would build, the curated task's match first.
 * One choice with the tasks below (`ToolChoice`): picking a card here clears a task there, and the
 * step's own state holds which. Each card is the task in the person's words, the catalogue's first
 * sentence under it, and a *Ready-made* badge, the word the connections screen draws a stock
 * version with (`tool-versions.ts`).
 */
export function ReadyMadePicker({
  tools,
  value,
  onChange,
  integrationName,
  disabled,
  onPickCard,
}: {
  tools: readonly SetupReadyMadeTool[];
  /** The wire name chosen, or null while a task to build is the choice. */
  value: string | null;
  onChange: (tool: string) => void;
  integrationName: string;
  disabled?: boolean;
  /** A card tapped, beside `onChange`: the step's way on where a tap is the choice (a phone). */
  onPickCard?: (tool: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
        <p className="font-medium text-sm">Use a ready-made tool</p>
        <p className="text-xs">Ready now, nothing to build</p>
      </div>
      <SetupChoice
        name="setup-ready-made"
        legend={`Ready-made tools for ${integrationName}`}
        variant="task"
        options={tools.map((tool) => ({
          value: tool.tool,
          label: tool.goal,
          description: tool.description,
          aside: <Badge variant="secondary">Ready-made</Badge>,
        }))}
        value={value}
        onChange={onChange}
        onPick={onPickCard}
        disabled={disabled}
      />
    </div>
  );
}
