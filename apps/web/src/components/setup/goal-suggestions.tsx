import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { setupGoalQuery, setupGoalSuggestionsQuery } from "@/lib/setup-queries";

/**
 * The row of suggested read-only goals above the goal field (GRA-209; GRA-202, *The goal step*):
 * up to three chips the deployment's triage model proposes for the connected vendor, a click on
 * one filling the field through `onPick`. They are read from their own route after the step has
 * drawn (`setupGoalSuggestionsQuery`), and asked only where Build is available, since that is where
 * a model is configured. While they load, and when there are none, the row renders nothing, so
 * the step is as GRA-207 left it.
 */
export function GoalSuggestions({ onPick }: { onPick: (goal: string) => void }) {
  const goal = useQuery(setupGoalQuery);
  const connectionId = goal.data?.connection?.id ?? null;
  const asked = connectionId !== null && goal.data?.build.available === true;
  const suggestions = useQuery({
    ...setupGoalSuggestionsQuery(connectionId ?? ""),
    enabled: asked,
  });
  const chips = asked ? (suggestions.data?.suggestions ?? []) : [];
  if (chips.length === 0) return null;

  return (
    <fieldset>
      <legend className="mb-2 text-muted-foreground text-xs">Suggested goals</legend>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <Button
            key={chip}
            type="button"
            variant="outline"
            size="sm"
            // A sentence, so it wraps inside the chip rather than running off a narrow screen.
            className="h-auto min-h-7 whitespace-normal py-1 text-left"
            onClick={() => onPick(chip)}
          >
            {chip}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
