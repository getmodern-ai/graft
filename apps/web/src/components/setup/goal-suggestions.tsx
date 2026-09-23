/**
 * The row of suggested read-only goals above the goal field (GRA-202, *The goal step*): up to three
 * chips the deployment's triage model proposes for the vendor, a click on one filling the field
 * through `onPick`. It renders nothing until GRA-209 gives the server the proposer and this row its
 * chips; the goal step already places it and hands it the setter, so that ticket changes this file
 * alone.
 */
export function GoalSuggestions(_props: { onPick: (goal: string) => void }) {
  return null;
}
