import { Badge } from "@/components/ui/badge";
import type { StatusChip as StatusChipValue } from "@/lib/status-chips";

/**
 * A status as a `Badge`, drawn from the one map in `lib/status-chips.ts` — the variant and the
 * words arrive together, so no call site can pair a red chip with a reassuring label.
 */
export function StatusChip({ chip, className }: { chip: StatusChipValue; className?: string }) {
  return (
    <Badge variant={chip.variant} className={className}>
      {chip.label}
    </Badge>
  );
}
