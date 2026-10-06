import { Link } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";

import { AgentActions } from "@/components/agent/agent-actions";
import { AgentConnectionDialog } from "@/components/agent/agent-connection-dialog";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableRow, DataTableSubHeader } from "@/components/ui/data-table";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AgentListItem } from "@/lib/agent-queries";
import { count } from "@/lib/format";
import { agentStatusChip } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

const COLUMNS = 8;

export type AgentTableRow = AgentListItem;

/**
 * The recorded OAuth client names the harness (ADR 0018); static tokens record no client.
 * Compact widths keep that name below the agent name.
 * Cando's members-panel.tsx supplies the group bands (ADR 0017).
 */
export function AgentsTable({
  agents,
  isPending,
  isError,
  error,
  retrying,
  onRetry,
  offerSetup = false,
}: {
  agents: readonly AgentTableRow[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  /** A person who skipped Setup (ADR 0024) is offered it again from the empty table. */
  offerSetup?: boolean;
}) {
  const groups = [
    { label: "Active", agents: agents.filter((agent) => !agent.revokedAt) },
    { label: "Revoked", agents: agents.filter((agent) => agent.revokedAt) },
  ];

  return (
    <DataTable layout="grid">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead className="hidden md:table-cell md:w-36 xl:w-60">Harnesses</TableHead>
          <TableHead className="hidden xl:table-cell xl:w-36">Token</TableHead>
          <TableHead className="hidden lg:table-cell lg:w-32">Working set</TableHead>
          <TableHead className="hidden lg:table-cell lg:w-28">Idle window</TableHead>
          <TableHead className="w-26 md:w-36">Created</TableHead>
          {/* Wide enough for the longest chip, *Awaiting harness* (ADR 0024). */}
          <TableHead className="w-30 md:w-36">Status</TableHead>
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
            No agents yet. Create one to connect your harness
            {offerSetup ? (
              <>
                , or let Setup walk you through a first connection and tool.{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 text-info"
                  nativeButton={false}
                  render={<Link to="/setup" />}
                >
                  Set up Graft
                </Button>
              </>
            ) : (
              "."
            )}
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
                        className="rounded-sm text-info underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {agent.name}
                      </Link>
                      <div className="mt-1 md:hidden">
                        <AgentHarnesses agent={agent} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <AgentHarnesses agent={agent} />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      {agent.tokenPrefix ? (
                        <code className="font-mono text-xs">{agent.tokenPrefix}…</code>
                      ) : (
                        // No token: an OAuth agent's, or one awaiting its harness (ADR 0024),
                        // whose token is issued at Setup's finish step if its harness takes one.
                        <span className="text-muted-foreground">
                          {agent.connectedVia ? "OAuth" : "Not issued"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span
                        className="flex items-center gap-2"
                        title={`${agentStatusChip(agent).label} · ${agent.workingSetCount} tools in working set, cap ${agent.workingSetCap}`}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            agent.revokedAt ? "bg-destructive" : "bg-success",
                          )}
                        />
                        <span className="tabular-nums">
                          <span className="sr-only">Working set: </span>
                          {agent.workingSetCount}
                          <span aria-hidden="true">/</span>
                          <span className="sr-only"> tools, cap </span>
                          {agent.workingSetCap}
                        </span>
                      </span>
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

function AgentHarnesses({ agent }: { agent: AgentTableRow }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [connecting, setConnecting] = useState(false);
  const active = !agent.revokedAt;
  // The recorded OAuth client (ADR 0018); a static-token agent records no harness, so its cell is
  // a prompt to set one up and never a claim about whether it is connected (GRA-168).
  const names = agent.connectedVia ? [agent.connectedVia.clientName] : [];
  if (names.length === 0) {
    if (!active) return <span className="text-muted-foreground">Not recorded</span>;
    return (
      <>
        <Button
          ref={trigger}
          variant="link"
          className="h-auto p-0 text-info"
          aria-label={`Set up harness for ${agent.name}`}
          onClick={() => setConnecting(true)}
        >
          Set up harness
        </Button>
        {connecting ? (
          <AgentConnectionDialog
            agent={agent}
            onClose={() => setConnecting(false)}
            returnFocus={trigger}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} variant="outline">
          {name}
        </Badge>
      ))}
    </div>
  );
}
