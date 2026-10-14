import { FilterListIcon } from "@/components/icons";
import { HarnessMark } from "@/components/marks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { harnessMark } from "@/lib/marks";
import type { AgentFilterOption } from "@/lib/requests-filter";

const ALL = "all";

/**
 * Requests' "All agents" menu (GRA-312; the Figma frame "03a Requests > Filter by agent"): a radio
 * group over the active agents, each with its open count when `counts` is on (the Open tab; Done's
 * rows are paged, so it shows no count it cannot know). The label sits inside the radio group,
 * since Base UI's `Menu.GroupLabel` throws outside one (`account-menu.tsx`).
 */
export function AgentFilterMenu({
  options,
  selected,
  total,
  counts,
  onSelect,
}: {
  options: readonly AgentFilterOption[];
  selected: AgentFilterOption | null;
  /** Every open request, for the "All agents" line. */
  total: number | null;
  counts: boolean;
  onSelect: (agentId: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <FilterListIcon />
        <span className="max-w-40 truncate">{selected ? selected.name : "All agents"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup
          value={selected?.id ?? ALL}
          onValueChange={(value: string) => onSelect(value === ALL ? null : value)}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            Show requests from
          </DropdownMenuLabel>
          <DropdownMenuRadioItem value={ALL} closeOnClick>
            <span className="flex-1 truncate">All agents</span>
            {counts && total !== null ? <Count n={total} /> : null}
          </DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
              <HarnessMark mark={harnessMark(option.clientName)} tile="none" className="size-4" />
              <span className="flex-1 truncate">{option.name}</span>
              {counts ? <Count n={option.count} /> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Count({ n }: { n: number }) {
  return <span className="text-muted-foreground text-xs">{n}</span>;
}
