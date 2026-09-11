import type * as React from "react";
import { Table, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The design system's table — `data-slot="table"` in Figma, published in three layouts.
 *
 * This is the `<table>` itself and nothing else. The toolbar and the pagination are siblings
 * the caller places around it (Cando's `DataTableToolbar` and `DataTablePagination`, not ported
 * to the console), which is why they
 * carry their own `pb-4` / `pt-4` rather than a gap living here: composing them is a plain
 * stack, and a table that renders neither is still a whole table.
 *
 * Two of Figma's three layouts differ only in how columns are sized, and the third adds a row:
 *
 * - **default** — `table-auto`; columns follow their content.
 * - **grid** — `table-fixed`; columns take the widths the header cells declare (the design's
 *   are `w-9`, `w-50`, auto, `w-50`, `w-12`) and stop reflowing as content changes.
 * - **sub header** — the grid layout plus a `DataTableSubHeader` row inside the body. It is not
 *   a third value here because nothing about the table element changes; the row is the layout.
 *
 * `table-fixed` rather than a real CSS grid on purpose. Figma draws that variant as a grid
 * because Figma has no table, but `display: grid` would cost the `<table>` semantics that make
 * a row navigable to a screen reader, and column widths are the only thing the design actually
 * asks for.
 *
 * `data-slot` stays `table`, inherited from the primitive: that is what the Figma component
 * names, and callers style rows and cells through the same slots either way. The layout is
 * legible in the DOM as `data-layout` instead.
 */
function DataTable({
  className,
  layout = "default",
  ...props
}: React.ComponentProps<typeof Table> & {
  layout?: "default" | "grid";
}) {
  return (
    <Table
      data-layout={layout}
      className={cn(layout === "grid" ? "table-fixed" : "table-auto", className)}
      {...props}
    />
  );
}

/**
 * A body row at the design's 40px rhythm.
 *
 * `TableRow` leaves height to its cells, and `p-2` around a 20px line gives 36 — close enough
 * to look deliberate and wrong enough to accumulate over ten rows. On a `<tr>` the height acts
 * as a minimum, so a cell that wraps still grows.
 */
function DataTableRow({ className, ...props }: React.ComponentProps<typeof TableRow>) {
  return <TableRow className={cn("h-10", className)} {...props} />;
}

/**
 * The banded row the sub-header layout inserts between the header and the body — one cell
 * spanning the table, its contents centred.
 *
 * `colSpan` is required. A short span leaves the band ending mid-table, which reads as a
 * rendering glitch rather than as a missing prop, and no default can know the column count.
 *
 * `hover:bg-muted` repeats the resting fill deliberately: `TableRow` hovers to `bg-muted/50`,
 * which over this band would *lighten* it on hover. The band is not a row you act on.
 *
 * The `pr-2` undoes `TableCell`'s `pr-0`, which exists to close the gap in a narrow checkbox
 * column and, applied to a band whose whole width is one cell, instead pulls its centred
 * contents 4px off centre. Same variant, so tailwind-merge resolves it to this one.
 */
function DataTableSubHeader({
  className,
  children,
  colSpan,
  ...props
}: Omit<React.ComponentProps<typeof TableCell>, "colSpan"> & { colSpan: number }) {
  return (
    <TableRow data-slot="data-table-sub-header" className="h-10 bg-muted hover:bg-muted">
      <TableCell
        colSpan={colSpan}
        className={cn("p-2 [&:has([role=checkbox])]:pr-2", className)}
        {...props}
      >
        <div className="flex items-center justify-center gap-2">{children}</div>
      </TableCell>
    </TableRow>
  );
}

export { DataTable, DataTableRow, DataTableSubHeader };
