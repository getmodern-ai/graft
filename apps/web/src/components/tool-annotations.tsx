import { Badge } from "@/components/ui/badge";

/**
 * A tool's annotations as the check derived them (ADR 0008): read-only passes without asking, a
 * write asks once, destructive asks every call until relaxed. Shown wherever a tool is named, because
 * the annotation is what decides whether the person will hear from it.
 */
export function ToolAnnotations({
  readOnly,
  destructive,
}: {
  readOnly: boolean;
  destructive: boolean;
}) {
  if (readOnly) {
    return <Badge variant="secondary">read-only</Badge>;
  }
  if (destructive) {
    return <Badge variant="destructive">destructive</Badge>;
  }
  return <Badge variant="outline">write</Badge>;
}
