import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";

import { InfoIcon, KeyboardArrowDownIcon, KeyboardArrowUpIcon } from "@/components/icons";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toolTitle } from "@/lib/agent-access";
import { connectionAccessQuery, toolsQuery } from "@/lib/connection-queries";
import { count } from "@/lib/format";
import type { PageConnection } from "@/lib/integration-page";
import { type IntegrationToolRow, integrationToolsQuery } from "@/lib/integration-queries";
import {
  agentsWithAccess,
  openToolAsksByTool,
  splitIntegrationTools,
  type ToolApprovalSummary,
  toolApprovalSummary,
  toolStatusLine,
} from "@/lib/integration-tools";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { toolAccessChip } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

/**
 * The body's states (GRA-47), as `table-body-states.tsx` draws them, but spanning the columns
 * actually shown: two below `md`, where Approval steps out, and three from `md`. A span wider than
 * the header under `table-fixed` adds an auto column and squeezes Tool, so each state carries one
 * cell per breakpoint and the browser hides the other.
 */
function StateCells({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <>
      <TableCell colSpan={2} className={cn("whitespace-normal md:hidden", className)}>
        {children}
      </TableCell>
      <TableCell colSpan={3} className={cn("hidden whitespace-normal md:table-cell", className)}>
        {children}
      </TableCell>
    </>
  );
}

function StateNote({ children }: { children: React.ReactNode }) {
  return (
    <DataTableRow className="hover:bg-transparent">
      <StateCells className="px-4 text-muted-foreground">{children}</StateCells>
    </DataTableRow>
  );
}

function StateLoadingRows() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <DataTableRow key={row}>
          <StateCells className="px-4">
            <Skeleton className="h-5 w-full" />
          </StateCells>
        </DataTableRow>
      ))}
    </>
  );
}

/** What the Approval column says on a page whose every connection is revoked (decisions, GRA-282). */
const REVOKED_APPROVAL: ToolApprovalSummary = {
  summary: "Can't run until you reconnect",
  detail: null,
  agentsTab: false,
};

/**
 * The integration page's Tools tab (GRA-317; Figma 2044:7001): every tool of the vendor from the
 * integration's tools read (GRA-293), the person's first and the stock tools not yet copied in
 * behind "Show N more tools". A tool with no current version is never listed; the read leaves it
 * out (GRA-77).
 *
 * The Approval column is a read-only summary across the agents that can use the integration (ADR
 * 0008 as amended 2026-10-14): it links to the Agents tab, where the answers are edited per agent,
 * and a read links nowhere, since it never asks. The agents and their answers come from each live
 * connection's access read (GRA-296), so the column fills after the rows do.
 *
 * Figma draws an "Agents with access" rail beside the table; it is the Agents tab's toggles and
 * GRA-318's, so this tab draws the table at full width and leaves the rail out.
 */
export function ToolsTab({
  vendor,
  integrationName,
  connections,
}: {
  vendor: string;
  integrationName: string;
  connections: PageConnection[];
}) {
  const [showStock, setShowStock] = useState(false);
  const { data, isPending, isError, error, isFetching, refetch } = useQuery(
    integrationToolsQuery(vendor),
  );
  const { data: toolboxData } = useQuery(toolsQuery);
  const { data: pendingData } = useQuery(pendingActionsQuery);
  const live = connections.filter((connection) => connection.state !== "revoked");
  const access = useQueries({
    // Stale at once, so every visit refetches: the agent page's approval edits refresh their own
    // reads and not this one, and the summary must not draw an answer from before them.
    queries: live.map((connection) => ({ ...connectionAccessQuery(connection.id), staleTime: 0 })),
    combine: (results) => ({
      pending: results.some((result) => result.isPending),
      failed: results.some((result) => result.isError),
      agents: agentsWithAccess(
        results.flatMap((result) => (result.data ? [result.data.access] : [])),
      ),
    }),
  });

  const { toolbox, stock } = splitIntegrationTools(data?.tools ?? []);
  const shown = showStock ? [...toolbox, ...stock] : toolbox;
  const openAsks = openToolAsksByTool(pendingData?.pendingActions ?? []);
  const approvalOf = (tool: IntegrationToolRow): ApprovalCell => {
    if (live.length === 0) return { kind: "summary", value: REVOKED_APPROVAL };
    // A read's answer needs no agent, so it never waits on the access read.
    if (tool.annotations.readOnly) return { kind: "summary", value: toolApprovalSummary(tool, []) };
    if (access.pending) return { kind: "pending" };
    if (access.failed) return { kind: "failed" };
    return { kind: "summary", value: toolApprovalSummary(tool, access.agents) };
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-0 py-0">
        <DataTable layout="grid">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Tool</TableHead>
              <TableHead className="w-30 md:w-48">Access</TableHead>
              <TableHead className="hidden md:table-cell md:w-64">Approval</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <StateLoadingRows />
            ) : isError ? (
              <StateNote>
                <RetryNotice
                  error={error}
                  message={`Could not load the ${integrationName} tools.`}
                  onRetry={() => void refetch()}
                  retrying={isFetching}
                />
              </StateNote>
            ) : toolbox.length === 0 && stock.length === 0 ? (
              <StateNote>
                No {integrationName} tools yet. An agent builds one when it needs it.
              </StateNote>
            ) : (
              <>
                {toolbox.length === 0 && !showStock ? (
                  <StateNote>
                    Your agents have not built a {integrationName} tool yet. Ready-made ones are
                    below.
                  </StateNote>
                ) : null}
                {shown.map((tool) => (
                  <ToolRow
                    key={tool.tool}
                    tool={tool}
                    vendor={vendor}
                    status={toolStatusLine(tool, {
                      openAsks,
                      toolbox: toolboxData?.tools ?? [],
                    })}
                    approval={approvalOf(tool)}
                  />
                ))}
              </>
            )}
          </TableBody>
        </DataTable>
        {/* Below the table rather than a row of it: a full-span row on every render would add a
            column below `md`, where the Approval column steps out. */}
        {stock.length > 0 && !isError ? (
          <div className="border-border border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showStock}
              onClick={() => setShowStock((open) => !open)}
            >
              {showStock ? "Show fewer tools" : `Show ${count(stock.length, "more tool")}`}
              {showStock ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </Button>
          </div>
        ) : null}
      </Card>
      <p className="flex gap-2 text-muted-foreground text-xs">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        <span>
          Reads run without asking. A tool that changes data asks each agent the first time, unless
          you allowed it. Change what each agent may run on the{" "}
          <Link
            to="/integrations/$vendor"
            params={{ vendor }}
            search={{ tab: "agents" }}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Agents tab
          </Link>
          .
        </span>
      </p>
    </div>
  );
}

type ApprovalCell =
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "summary"; value: ToolApprovalSummary };

function ToolRow({
  tool,
  vendor,
  status,
  approval,
}: {
  tool: IntegrationToolRow;
  vendor: string;
  status: ReturnType<typeof toolStatusLine>;
  approval: ApprovalCell;
}) {
  return (
    <DataTableRow>
      <TableCell className="whitespace-normal px-4 py-3.5 align-top">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium" title={tool.tool}>
            {toolTitle(tool.name)}
          </span>
          <span className="text-muted-foreground text-xs">{tool.description}</span>
          <span
            className={cn(
              "text-xs",
              status.kind === "waiting" ? "text-primary" : "text-muted-foreground",
            )}
          >
            {status.text}
          </span>
          {/* Below `md` the Approval column steps out and its summary follows the tool. */}
          <span className="pt-1 md:hidden">
            <Approval approval={approval} vendor={vendor} />
          </span>
        </div>
      </TableCell>
      <TableCell className="whitespace-normal py-3.5 align-top">
        <StatusChip
          chip={toolAccessChip({
            readOnlyHint: tool.annotations.readOnly,
            destructiveHint: tool.annotations.destructive,
          })}
        />
      </TableCell>
      <TableCell className="hidden whitespace-normal py-3.5 align-top md:table-cell">
        <Approval approval={approval} vendor={vendor} />
      </TableCell>
    </DataTableRow>
  );
}

/** The Approval column's summary: a link to the Agents tab where an answer can change, text where none can. */
function Approval({ approval, vendor }: { approval: ApprovalCell; vendor: string }) {
  if (approval.kind === "pending") return <Skeleton className="h-4 w-36" />;
  if (approval.kind === "failed") {
    return <span className="text-muted-foreground text-xs">Could not load the agents</span>;
  }
  const { summary, detail, agentsTab } = approval.value;
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {agentsTab ? (
        <Link
          to="/integrations/$vendor"
          params={{ vendor }}
          search={{ tab: "agents" }}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {summary}
        </Link>
      ) : (
        <span className="text-foreground">{summary}</span>
      )}
      {detail ? <span className="text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
