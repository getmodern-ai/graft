import { Link } from "@tanstack/react-router";

import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import { count } from "@/lib/format";
import { agentStatusChip } from "@/lib/status-chips";

const COLUMNS = 6;

/**
 * The agents list — one row per harness connected to Graft (CONTEXT.md, *Agent*).
 *
 * Grid layout, so the five fact columns hold their widths and a long name cannot move the dates
 * (Cando's `connections-table.tsx`). The name is the auto-sized column: it is the only prose in
 * the row and the way into the agent, drawn as plain text that underlines on hover, the dress of
 * every inline link in Cando's tables.
 *
 * **Below `md` the cap and the idle window step out.** Six columns in 358px is a horizontal
 * scroll or truncation past reading, and those two are the least load-bearing facts on the row —
 * both editable on the agent's page, which the name opens. Cando's mobile frame for its own table
 * narrows every column rather than scrolling (its CAN-360); with two more columns than that
 * frame, narrowing alone does not get there.
 *
 * Loading, failed and empty are the body's own rows (`table-body-states.tsx`); the screen-level
 * empty — no agents at all — is the route's `Empty`, because it carries the one action that
 * changes it.
 */
export function AgentsTable({
  agents,
  isPending,
  isError,
  error,
  retrying,
  onRetry,
}: {
  agents: readonly Agent[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <DataTable layout="grid">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead className="w-28 md:w-40">Token</TableHead>
          <TableHead className="hidden md:table-cell md:w-24">Cap</TableHead>
          <TableHead className="hidden md:table-cell md:w-28">Idle window</TableHead>
          <TableHead className="w-26 md:w-36">Created</TableHead>
          <TableHead className="w-20 md:w-24">Status</TableHead>
        </TableRow>
      </TableHeader>
      {/* A rule under the last row: this table stands alone on the page, with no card to close it. */}
      <TableBody className="[&_tr:last-child]:border-b">
        {isPending ? (
          <TableLoadingRows colSpan={COLUMNS} />
        ) : isError ? (
          <TableBodyNote colSpan={COLUMNS}>
            <RetryNotice
              error={error}
              message="Could not load your agents."
              onRetry={onRetry}
              retrying={retrying}
            />
          </TableBodyNote>
        ) : (
          agents.map((agent) => (
            <DataTableRow key={agent.id}>
              <TableCell className="truncate">
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: agent.id }}
                  className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {agent.name}
                </Link>
              </TableCell>
              <TableCell>
                <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {count(agent.workingSetCap, "tool")}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {count(agent.idleWindowDays, "day")}
              </TableCell>
              <TableCell className="truncate text-muted-foreground">
                <Time iso={agent.createdAt} />
              </TableCell>
              <TableCell>
                <StatusChip chip={agentStatusChip(agent)} />
              </TableCell>
            </DataTableRow>
          ))
        )}
      </TableBody>
    </DataTable>
  );
}
