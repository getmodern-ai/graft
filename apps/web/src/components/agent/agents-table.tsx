import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { AgentActions } from "@/components/agent/agent-actions";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { DataTable, DataTableRow, DataTableSubHeader } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import { count } from "@/lib/format";
import { agentStatusChip } from "@/lib/status-chips";

const COLUMNS = 7;

/**
 * The agents list — one row per harness connected to Graft (CONTEXT.md, *Agent*).
 *
 * Grid layout, so the five fact columns hold their widths and a long name cannot move the dates
 * (Cando's `connections-table.tsx`). The name is the auto-sized column: it is the only prose in
 * the row and the way into the agent, drawn as plain text that underlines on hover, the dress of
 * every inline link in Cando's tables.
 *
 * Below `md` the token, cap and idle window step out to keep the name and Actions readable.
 * The agent's detail page still shows those facts (ADR 0017: compose from the table pattern).
 *
 * **An agent an MCP client connected wears the client's name as a chip beside its own** (ADR
 * 0018) — an outline `Badge`, dynamic text like the vendor badge in the connection picker, not a
 * status from `status-chips.ts`. Its Token cell says "OAuth" when it holds no static token: the
 * client holds the tokens, and there is no prefix to show.
 *
 * Loading, failed and empty are the body's own rows (`table-body-states.tsx`), following
 * Cando's `connections-table.tsx` BodyNote. The header and the page's New agent action stay put.
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
  const groups = [
    { label: "Active", agents: agents.filter((agent) => !agent.archivedAt && !agent.revokedAt) },
    { label: "Revoked", agents: agents.filter((agent) => !agent.archivedAt && agent.revokedAt) },
    { label: "Archived", agents: agents.filter((agent) => agent.archivedAt) },
  ];

  return (
    <DataTable layout="grid">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead className="hidden md:table-cell md:w-40">Token</TableHead>
          <TableHead className="hidden md:table-cell md:w-24">Cap</TableHead>
          <TableHead className="hidden md:table-cell md:w-28">Idle window</TableHead>
          <TableHead className="w-26 md:w-36">Created</TableHead>
          <TableHead className="w-20 md:w-24">Status</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">Actions</span>
          </TableHead>
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
        ) : agents.length === 0 ? (
          <TableBodyNote colSpan={COLUMNS} className="text-center">
            No agents yet. Create one to connect your harness.
          </TableBodyNote>
        ) : (
          groups.map((group) =>
            group.agents.length > 0 ? (
              <Fragment key={group.label}>
                {/* Cando's members-panel.tsx BandRow: a full-width child left-aligns the label. */}
                <DataTableSubHeader colSpan={COLUMNS}>
                  <span className="w-full font-medium">{group.label}</span>
                </DataTableSubHeader>
                {group.agents.map((agent) => (
                  <DataTableRow key={agent.id}>
                    <TableCell className="truncate">
                      <Link
                        to="/agents/$agentId"
                        params={{ agentId: agent.id }}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {agent.name}
                      </Link>
                      {agent.connectedVia ? (
                        <Badge variant="outline" className="ml-2 align-middle">
                          {agent.connectedVia.clientName}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {agent.tokenPrefix ? (
                        <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
                      ) : (
                        <span className="text-muted-foreground">OAuth</span>
                      )}
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
                    <TableCell className="p-0">
                      <div className="flex justify-end px-2">
                        <AgentActions agent={agent} />
                      </div>
                    </TableCell>
                  </DataTableRow>
                ))}
              </Fragment>
            ) : null,
          )
        )}
      </TableBody>
    </DataTable>
  );
}
