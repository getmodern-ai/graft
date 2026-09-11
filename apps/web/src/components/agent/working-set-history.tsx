import { useQuery } from "@tanstack/react-query";

import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type WorkingSetChange, workingSetChangesQuery } from "@/lib/agent-queries";
import { WORKING_SET_CHANGE_CHIP } from "@/lib/status-chips";

/**
 * Why the working set changed, in the person's words (ADR 0009: expansion has an author, and
 * contraction now has two — the agent, and the rule). The cause is the record's own word; this is
 * the sentence beside it.
 */
const CAUSE: Record<WorkingSetChange["cause"], string> = {
  agent: "The agent asked",
  publish: "Published by the agent",
  idle: "Unused past the idle window",
  cap: "Over the working-set cap",
  revoke: "Its connection was revoked",
};

const COLUMNS = 4;

/**
 * Every promotion and demotion, newest first — tool-list churn is a first-class event (ADR 0003).
 * Owns its read for the reason `working-set-table.tsx` gives. Below `md` the cause column steps
 * out and the cause follows the tool name in muted text instead, so the one fact the history
 * exists to show is never off the screen.
 */
export function WorkingSetHistory({ agentId }: { agentId: string }) {
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    workingSetChangesQuery(agentId),
  );
  const changes = data?.changes ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>
          Every promotion and demotion with its cause, newest first. A demoted tool is still in the
          toolbox and one <code className="font-mono">find_tool</code> away.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable layout="grid">
          <TableHeader>
            <TableRow>
              <TableHead className="w-26 md:w-36">When</TableHead>
              <TableHead className="w-24 md:w-28">Change</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead className="hidden md:table-cell md:w-56">Cause</TableHead>
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
                      <span className="truncate text-muted-foreground text-xs md:hidden">
                        {CAUSE[change.cause]}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {CAUSE[change.cause]}
                  </TableCell>
                </DataTableRow>
              ))
            )}
          </TableBody>
        </DataTable>
      </CardContent>
    </Card>
  );
}
