import { useQuery } from "@tanstack/react-query";

import { AgentDetailsSection } from "@/components/agent/agent-details-section";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { workingSetChangesQuery } from "@/lib/agent-queries";
import { WORKING_SET_CHANGE_CHIP } from "@/lib/status-chips";
import { WORKING_SET_CAUSE } from "@/lib/working-set-cause";

const COLUMNS = 4;

/**
 * Every promotion and demotion, newest first — tool-list churn is a first-class event (ADR 0003).
 * Owns its read for the reason `working-set-table.tsx` gives. Below a 42rem content width the cause column steps
 * out and the cause follows the tool name in muted text instead, so the one fact the history
 * exists to show is never off the screen.
 */
export function WorkingSetHistory({ agentId }: { agentId: string }) {
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    workingSetChangesQuery(agentId),
  );
  const changes = data?.changes ?? [];

  return (
    <AgentDetailsSection
      title="History"
      description={
        <>
          Every promotion and demotion with its cause, newest first. A demoted tool is still in the
          toolbox and one <code className="font-mono">find_tool</code> away.
        </>
      }
    >
      <DataTable layout="grid" className="min-w-96">
        <TableHeader>
          <TableRow>
            <TableHead className="@2xl:w-36 w-26">When</TableHead>
            <TableHead className="@2xl:w-28 w-24">Change</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead className="@2xl:table-cell hidden @2xl:w-56">Cause</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isPending ? (
            <TableLoadingRows colSpan={COLUMNS} />
          ) : isError ? (
            <TableBodyNote colSpan={COLUMNS}>
              <RetryNotice
                error={error}
                message="Could not load the history."
                onRetry={() => void refetch()}
                retrying={isFetching}
              />
            </TableBodyNote>
          ) : changes.length === 0 ? (
            <TableBodyNote colSpan={COLUMNS}>No changes yet.</TableBodyNote>
          ) : (
            changes.map((change) => (
              <DataTableRow key={change.id}>
                <TableCell className="truncate text-muted-foreground">
                  <Time iso={change.createdAt} />
                </TableCell>
                <TableCell>
                  <StatusChip chip={WORKING_SET_CHANGE_CHIP[change.change]} />
                </TableCell>
                <TableCell className="truncate">
                  <span className="flex min-w-0 items-baseline gap-2">
                    {change.tool ? (
                      <code className="shrink-0 font-mono text-xs">
                        {change.tool.vendor}__{change.tool.name}
                      </code>
                    ) : (
                      <span className="truncate text-muted-foreground">
                        A tool no longer in the toolbox
                      </span>
                    )}
                    <span className="@2xl:hidden truncate text-muted-foreground text-xs">
                      {WORKING_SET_CAUSE[change.cause]}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="@2xl:table-cell hidden text-muted-foreground">
                  {WORKING_SET_CAUSE[change.cause]}
                </TableCell>
              </DataTableRow>
            ))
          )}
        </TableBody>
      </DataTable>
    </AgentDetailsSection>
  );
}
