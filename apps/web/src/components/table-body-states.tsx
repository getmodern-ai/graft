import type * as React from "react";

import { DataTableRow } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * What a table body draws when it has no rows to draw (GRA-47) — Cando's `BodyNote` and its
 * skeleton rows, which every one of its tables writes for itself, written once for the console's
 * five.
 *
 * Both are rows inside the `<tbody>` rather than a block beside the table, so the header stays
 * put and the columns stay explained while there is nothing under them; and neither is a spinner,
 * because a spinner says only that something is happening while skeleton rows promise the shape
 * of what will land.
 *
 * A note on the tables themselves: under `layout="grid"` a cell whose value outgrows its declared
 * width overflows the table rather than widening the column, and the table's container then
 * scrolls by that much. The time columns carry `truncate` for that reason — Cando's guard at the
 * narrow width (`connections-table.tsx`) — and are sized so the relative form ("10 hours ago")
 * fits at 390px and the dated form fits from `md`.
 */

/**
 * A whole-width sentence in place of rows: the empty state, or the failed one with a
 * `RetryNotice` inside it. `colSpan` is required for the same reason `DataTableSubHeader`'s is —
 * no default can know the column count, and a short span reads as a rendering glitch.
 *
 * `whitespace-normal` undoes `TableCell`'s `nowrap`: a cell is sized for a value, this holds a
 * sentence, and a sentence that cannot wrap scrolls the table sideways below `md`.
 */
export function TableBodyNote({
  colSpan,
  className,
  children,
}: {
  colSpan: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DataTableRow className="hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className={cn("whitespace-normal text-muted-foreground", className)}
      >
        {children}
      </TableCell>
    </DataTableRow>
  );
}

/**
 * Rows at the table's own rhythm while its query is pending, so the chrome does not jump when the
 * data lands. One cell spanning the table per row rather than a skeleton per column — Cando's
 * connections table's shape — because two of the console's tables hide a column below `md`, and a
 * row carrying a cell for every header would carry more cells than the header shows there.
 */
export function TableLoadingRows({ colSpan, rows = 3 }: { colSpan: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <DataTableRow key={row}>
          <TableCell colSpan={colSpan}>
            <Skeleton className="h-5 w-full" />
          </TableCell>
        </DataTableRow>
      ))}
    </>
  );
}
