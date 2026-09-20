import { useQuery } from "@tanstack/react-query";

import { RetryNotice } from "@/components/retry-notice";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Agent, type WorkingSetEntry, workingSetQuery } from "@/lib/agent-queries";
import { count } from "@/lib/format";

const PROMOTED_BY: Record<WorkingSetEntry["promotedBy"], string> = {
  agent: "The agent",
  publish: "A publish",
  rule: "The rule",
};

const COLUMNS = 5;

/**
 * The working set as the harness sees it (ADR 0003): exactly these tools are in the agent's MCP
 * list beside the meta-tools. "Last used" is the contraction rule's clock (ADR 0009).
 *
 * Owns its read rather than taking rows from the route: the agent's page awaits the agent alone
 * and only starts this query (`agents.$agentId.tsx`), so the card paints at once with skeleton
 * rows and fills when the set arrives — pending is its own state, never the empty branch.
 *
 * One line per tool, at the table's 40px rhythm: the description the agent's model wrote follows
 * the wire name in muted text and truncates where the column runs out, rather than taking a
 * second line under it. Below `md` the two promotion columns step out and the name keeps the room.
 */
export function WorkingSetTable({ agent }: { agent: Agent }) {
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    workingSetQuery(agent.id),
  );
  const entries = data?.workingSet ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Working set
          {data ? (
            <Badge variant="secondary">
              {entries.length} of {agent.workingSetCap}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          The authored tools currently promoted for this agent — its MCP tool list, beside the
          meta-tools. Idle window {count(agent.idleWindowDays, "day")}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable layout="grid">
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="w-24 md:w-28">Asks</TableHead>
              <TableHead className="hidden md:table-cell md:w-32">Promoted by</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Promoted</TableHead>
              <TableHead className="w-26 md:w-36">Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableLoadingRows colSpan={COLUMNS} />
            ) : isError ? (
              <TableBodyNote colSpan={COLUMNS}>
                <RetryNotice
                  error={error}
                  message="Could not load the working set."
                  onRetry={() => void refetch()}
                  retrying={isFetching}
                />
              </TableBodyNote>
            ) : entries.length === 0 ? (
              <TableBodyNote colSpan={COLUMNS}>
                Nothing is promoted yet — a tool arrives here when the agent promotes one it found
                with <code className="font-mono">find_tool</code>, or publishes one.
              </TableBodyNote>
            ) : (
              entries.map((entry) => (
                <DataTableRow key={entry.toolId}>
                  <TableCell className="truncate">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <code className="shrink-0 font-mono text-xs">
                        {entry.tool.vendor}__{entry.tool.name}
                      </code>
                      <span
                        className="truncate text-muted-foreground text-xs"
                        title={entry.tool.description}
                      >
                        {entry.tool.description}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <ToolAnnotations
                      readOnly={entry.tool.readOnly}
                      destructive={entry.tool.destructive}
                    />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {PROMOTED_BY[entry.promotedBy]}
                  </TableCell>
                  <TableCell className="hidden truncate text-muted-foreground md:table-cell">
                    <Time iso={entry.promotedAt} />
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground">
                    {entry.lastUsedAt ? <Time iso={entry.lastUsedAt} /> : "Never"}
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
