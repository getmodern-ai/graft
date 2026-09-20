import { Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { AgentActions } from "@/components/agent/agent-actions";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { DataTable, DataTableRow, DataTableSubHeader } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Agent } from "@/lib/agent-queries";
import { count } from "@/lib/format";
import { agentStatusChip } from "@/lib/status-chips";

const COLUMNS = 8;

/**
 * The recorded OAuth client names the harness (ADR 0018); static tokens record no client.
 * Compact widths keep that name below the agent link. The remaining facts live in the drawer.
 * Cando's members-panel.tsx supplies the group bands (ADR 0017).
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
          <TableHead className="hidden md:table-cell md:w-36">Harness</TableHead>
          <TableHead className="hidden xl:table-cell xl:w-36">Token</TableHead>
          <TableHead className="hidden lg:table-cell lg:w-24">Cap</TableHead>
          <TableHead className="hidden lg:table-cell lg:w-28">Idle window</TableHead>
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
                        id={`agent-link-${agent.id}`}
                        aria-haspopup="dialog"
                        to="/agents/$agentId"
                        params={{ agentId: agent.id }}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {agent.name}
                      </Link>
                      <span className="block truncate text-muted-foreground text-xs md:hidden">
                        {agent.connectedVia?.clientName ?? "Not recorded"}
                      </span>
                    </TableCell>
                    <TableCell
                      className="hidden truncate md:table-cell"
                      title={agent.connectedVia?.clientName}
                    >
                      {agent.connectedVia?.clientName ?? (
                        <span className="text-muted-foreground">Not recorded</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      {agent.tokenPrefix ? (
                        <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
                      ) : (
                        <span className="text-muted-foreground">OAuth</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {count(agent.workingSetCap, "tool")}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
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
