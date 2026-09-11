import { StatusChip } from "@/components/status-chip";
import { toolAnnotationChip } from "@/lib/status-chips";

/**
 * A tool's annotations as the check derived them (ADR 0008): read-only passes without asking, a
 * write asks once, destructive asks every call until relaxed. Shown wherever a tool is named, because
 * the annotation is what decides whether the person will hear from it. The three chips come from
 * `lib/status-chips.ts`, beside every other status the console draws.
 */
export function ToolAnnotations({
  readOnly,
  destructive,
}: {
  readOnly: boolean;
  destructive: boolean;
}) {
  return <StatusChip chip={toolAnnotationChip(readOnly, destructive)} />;
}
