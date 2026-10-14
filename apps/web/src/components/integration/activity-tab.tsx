import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { InfoIcon, KeyboardArrowDownIcon } from "@/components/icons";
import { HarnessMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentMark } from "@/lib/agent-cards";
import { type AgentListItem, agentsQuery } from "@/lib/agent-queries";
import {
  ACTIVITY_OUTCOME_FILTERS,
  ACTIVITY_OUTCOME_LABELS,
  type ActivityFilters,
  type ActivityOutcomeFilter,
  type ActivityRun,
  ALL,
  activityFootnote,
  activityRuns,
  activityToolLabel,
  integrationActivityQuery,
  refusalSentence,
  timeTakenLabel,
} from "@/lib/integration-activity";
import { ACTIVITY_OUTCOME_CHIP } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

/**
 * The body's states (GRA-47) spanning the columns actually shown: three below `md`, where Agent and Time taken
 * steps out, and five from `md`. Under `table-fixed` a span wider than the header adds an auto
 * column and squeezes Tool, so each state carries one cell per breakpoint, as the Tools tab's do.
 */
function StateCells({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <>
      <TableCell colSpan={3} className={cn("whitespace-normal md:hidden", className)}>
        {children}
      </TableCell>
      <TableCell colSpan={5} className={cn("hidden whitespace-normal md:table-cell", className)}>
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

const OUTCOME_ITEMS = [
  { value: ALL, label: "All outcomes" },
  ...ACTIVITY_OUTCOME_FILTERS.map((value) => ({ value, label: ACTIVITY_OUTCOME_LABELS[value] })),
];

/**
 * The integration page's Activity tab (GRA-319; Figma 2095:10473): every run of one of the
 * vendor's tools, newest first, from the person's activity read (GRA-308) with `vendor` and
 * `kind=run`. The two filters are the route's search (`readActivityFilters`), so they survive a
 * reload and change the server's query rather than hiding rows already loaded; "Show older calls"
 * fetches the next page by the read's cursor.
 */
export function ActivityTab({
  vendor,
  integrationName,
  filters,
  onFiltersChange,
}: {
  vendor: string;
  integrationName: string;
  filters: ActivityFilters;
  onFiltersChange: (next: ActivityFilters) => void;
}) {
  const {
    data,
    isPending,
    isError,
    error,
    isFetching,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery(integrationActivityQuery(vendor, filters));
  const { data: agentData } = useQuery(agentsQuery);
  const agents = agentData?.agents ?? [];
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const runs = activityRuns(data?.pages);
  // `isError` is also set when an older page or a background refetch fails; the rows already
  // loaded stay, and only a read with nothing to show takes the body to the retry notice.
  const failedOutright = isError && data === undefined;
  const filtered = filters.agent !== undefined || filters.outcome !== undefined;

  const agentItems = [
    { value: ALL, label: "All agents" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  // A filter naming an agent the list does not hold (revoked and gone, or another person's id
  // pasted into the URL) still shows what it filters by rather than a blank trigger.
  if (filters.agent && !agentsById.has(filters.agent)) {
    agentItems.push({ value: filters.agent, label: "Another agent" });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={filters.agent ?? ALL}
          items={agentItems}
          onValueChange={(next) =>
            onFiltersChange({
              ...filters,
              agent: typeof next === "string" && next !== ALL ? next : undefined,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.outcome ?? ALL}
          items={OUTCOME_ITEMS}
          onValueChange={(next) =>
            onFiltersChange({
              ...filters,
              outcome:
                typeof next === "string" &&
                (ACTIVITY_OUTCOME_FILTERS as readonly string[]).includes(next)
                  ? (next as ActivityOutcomeFilter)
                  : undefined,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="ml-auto hidden text-muted-foreground text-xs sm:block">
          Every {integrationName} tool call, newest first
        </p>
      </div>
      <Card className="gap-0 py-0">
        <DataTable layout="grid">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28 px-4 md:w-32">When</TableHead>
              <TableHead className="hidden md:table-cell md:w-48">Agent</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead className="w-22 pr-4 md:w-32 md:pr-2">Outcome</TableHead>
              <TableHead className="hidden pr-4 text-right md:table-cell md:w-28">
                Time taken
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <StateLoadingRows />
            ) : failedOutright ? (
              <StateNote>
                <RetryNotice
                  error={error}
                  message={`Could not load the ${integrationName} activity.`}
                  onRetry={() => void refetch()}
                  retrying={isFetching}
                />
              </StateNote>
            ) : runs.length === 0 ? (
              <StateNote>
                {filtered
                  ? "No calls match these filters."
                  : `No ${integrationName} tool has run yet. Calls appear here as your agents make them.`}
              </StateNote>
            ) : (
              runs.map((run) => (
                <RunRow key={run.key} run={run} agent={agentsById.get(run.agent.id)} />
              ))
            )}
          </TableBody>
        </DataTable>
        {/* Below the table rather than a row of it, as the Tools tab's disclosure is: a full-span
            row would need a cell per breakpoint for the columns that step out below `md`. */}
        {hasNextPage && !failedOutright ? (
          <div className="flex items-center gap-3 border-border border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading older calls" : "Show older calls"}
              <KeyboardArrowDownIcon />
            </Button>
            {isFetchNextPageError && !isFetchingNextPage ? (
              <span className="text-muted-foreground text-xs">
                Could not load older calls. Try again.
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
      <p className="flex gap-2 text-muted-foreground text-xs">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        <span>{activityFootnote(integrationName)}</span>
      </p>
    </div>
  );
}

function RunRow({ run, agent }: { run: ActivityRun; agent: AgentListItem | undefined }) {
  const chip = ACTIVITY_OUTCOME_CHIP[run.outcome];
  const why = run.outcome === "refused" ? refusalSentence(run.reason) : null;
  const tool = activityToolLabel(run.tool.wireName);
  return (
    <DataTableRow>
      <TableCell className="truncate px-4 text-muted-foreground">
        <Time iso={run.at} />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="flex min-w-0 items-center gap-2">
          <HarnessMark
            mark={agent ? agentMark(agent, undefined) : "generic"}
            tile="none"
            className="size-4"
          />
          <span className="truncate">{run.agent.name}</span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex min-w-0 flex-col">
          <span className="truncate" title={run.tool.wireName}>
            {tool}
          </span>
          {/* Below `md` Agent and Time taken step out and follow the tool. */}
          <span className="truncate text-muted-foreground text-xs md:hidden">{`${run.agent.name} · ${timeTakenLabel(run)}`}</span>
        </span>
      </TableCell>
      <TableCell className="pr-4 md:pr-2">
        {why ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`${chip.label}: ${why}`}
                  className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              }
            >
              <StatusChip chip={chip} />
            </TooltipTrigger>
            <TooltipContent>{why}</TooltipContent>
          </Tooltip>
        ) : (
          <StatusChip chip={chip} />
        )}
      </TableCell>
      <TableCell className="hidden truncate pr-4 text-right text-muted-foreground tabular-nums md:table-cell">
        {timeTakenLabel(run)}
      </TableCell>
    </DataTableRow>
  );
}
