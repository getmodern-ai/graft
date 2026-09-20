import { useQuery } from "@tanstack/react-query";

import { AgentDetailsSection } from "@/components/agent/agent-details-section";
import { RetryNotice } from "@/components/retry-notice";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { ToolAnnotations } from "@/components/tool-annotations";
import { Badge } from "@/components/ui/badge";
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
 * Owns its read: `agents.$agentId.tsx` prefetches without awaiting, so this card paints skeleton
 * rows until the set arrives. Pending stays distinct from empty.
 *
 * One line per tool, at the table's 40px rhythm: the description the agent's model wrote follows
 * the wire name in muted text and truncates where the column runs out, rather than taking a
 * second line under it. Below a 42rem content width the two promotion columns step out
 * and the name keeps the room.
 */
export function WorkingSetTable({ agent }: { agent: Agent }) {
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    workingSetQuery(agent.id),
  );
  const entries = data?.workingSet ?? [];

  return (
    <AgentDetailsSection
      title={
        <>
          Working set
          {data ? (
            <Badge variant="secondary">
              {entries.length} of {agent.workingSetCap}
            </Badge>
          ) : null}
        </>
      }
      description={
        <>
          The authored tools currently promoted for this agent in its MCP tool list, beside the
          meta-tools. Idle window {count(agent.idleWindowDays, "day")}.
        </>
      }
    >
      <DataTable layout="grid" className="min-w-96">
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead className="@2xl:w-28 w-24">Asks</TableHead>
            <TableHead className="@2xl:table-cell hidden @2xl:w-32">Promoted by</TableHead>
            <TableHead className="@2xl:table-cell hidden @2xl:w-36">Promoted</TableHead>
            <TableHead className="@2xl:w-36 w-26">Last used</TableHead>
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
              Nothing is promoted yet. A tool arrives here when the agent promotes one it found with{" "}
              <code className="font-mono">find_tool</code>, or publishes one.
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
                <TableCell className="@2xl:table-cell hidden">
                  {PROMOTED_BY[entry.promotedBy]}
                </TableCell>
                <TableCell className="@2xl:table-cell hidden truncate text-muted-foreground">
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
    </AgentDetailsSection>
  );
}
