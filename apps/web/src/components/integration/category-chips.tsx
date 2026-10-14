import type * as React from "react";
import { useState } from "react";

import { KeyboardArrowDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The directory's category chips (the frames' `Category chip`), shared by Setup's integration step
 * and the Integrations screen's Discover tab (GRA-322): *All* first, with the directory's count
 * beside it where the screen shows one, then the backing's categories, the first `shown` of them
 * until *N more* opens the rest. One scrolling row on a phone, so the tiles are on the first screen
 * (GRA-267). The caller draws nothing when the backing has no categories (the starters).
 */
export function CategoryChips({
  categories,
  value,
  onChange,
  allCount,
  shown = 8,
}: {
  categories: readonly { name: string }[];
  value: string | null;
  onChange: (category: string | null) => void;
  /** Beside *All*, muted: the directory's `total`. */
  allCount?: number;
  shown?: number;
}) {
  const [all, setAll] = useState(false);
  return (
    <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
      <CategoryChip active={value === null} onClick={() => onChange(null)}>
        All
        {allCount !== undefined ? (
          <span className="text-muted-foreground text-xs">{allCount.toLocaleString("en")}</span>
        ) : null}
      </CategoryChip>
      {(all ? categories : categories.slice(0, shown)).map((chip) => (
        <CategoryChip
          key={chip.name}
          active={value === chip.name}
          onClick={() => onChange(chip.name)}
        >
          {chip.name}
        </CategoryChip>
      ))}
      {!all && categories.length > shown ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
          <KeyboardArrowDownIcon />
          {categories.length - shown} more
        </Button>
      ) : null}
    </div>
  );
}

/** A category chip: outline, the chosen one in the primary's border over its wash. */
function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={active}
      className={cn("shrink-0 rounded-full", active ? "border-primary bg-primary/5" : null)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
