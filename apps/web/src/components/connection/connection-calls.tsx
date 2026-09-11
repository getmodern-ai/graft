import { useQuery } from "@tanstack/react-query";

import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { connectionCallsQuery } from "@/lib/connection-queries";
import { CALL_OUTCOME_CHIP, DRY_RUN_CHIP } from "@/lib/status-chips";

const COLUMNS = 5;

/**
 * A connection's recent vendor calls — the ledger's lines for the vendor's tools and the connection's
 * own execute tool, across every agent (GRA-26). The proxy's wide events are not persisted, so what
 * is shown is the invocation the MCP server recorded, not the HTTP exchange; the route comment in
 * `apps/server/src/api.ts` records the gap.
 *
 * Mounted only once the card's disclosure is open, so this is the one table whose skeleton rows a
 * person sees on every visit: the read starts when the button is pressed. Below `md` the agent
 * column steps out and the agent's name follows the tool's in muted text.
 */
export function ConnectionCalls({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    connectionCallsQuery(connectionId),
  );
  const calls = data?.calls ?? [];

  return (
    <DataTable layout="grid">
      <TableHeader>
        <TableRow>
          <TableHead className="w-26 md:w-36">When</TableHead>
          <TableHead className="hidden md:table-cell md:w-40">Agent</TableHead>
          <TableHead>Tool</TableHead>
          <TableHead className="w-20 md:w-24">Outcome</TableHead>
          <TableHead className="w-20 text-right md:w-24">Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isPending ? (
          <TableLoadingRows colSpan={COLUMNS} />
        ) : isError ? (
          <TableBodyNote colSpan={COLUMNS}>
            <RetryNotice
              error={error}
              message="Could not load the recent calls."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </TableBodyNote>
        ) : calls.length === 0 ? (
          <TableBodyNote colSpan={COLUMNS}>No calls against this vendor yet.</TableBodyNote>
        ) : (
          calls.map((call) => (
            <DataTableRow key={call.id}>
              <TableCell className="truncate text-muted-foreground">
                <Time iso={call.createdAt} />
              </TableCell>
              <TableCell className="hidden truncate md:table-cell">{call.agentName}</TableCell>
              <TableCell className="truncate">
                <span className="flex min-w-0 items-center gap-2">
                  <code className="truncate font-mono text-xs" title={call.toolName}>
                    {call.toolName}
                  </code>
                  {call.dryRun ? <StatusChip chip={DRY_RUN_CHIP} /> : null}
                  <span className="truncate text-muted-foreground text-xs md:hidden">
                    {call.agentName}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <StatusChip chip={CALL_OUTCOME_CHIP[call.outcome]} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">
                {call.latencyMs} ms
              </TableCell>
            </DataTableRow>
          ))
        )}
      </TableBody>
    </DataTable>
  );
}
