import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { FilterListIcon, InfoIcon, KeyboardArrowDownIcon } from "@/components/icons";
import { HarnessMark, IntegrationMark } from "@/components/marks";
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
import {
  ACTIVITY_SCREEN_OUTCOME_LABELS,
  ACTIVITY_SCREEN_OUTCOMES,
  type ActivityApproval,
  type ActivityRow,
  type ActivityScreenOutcome,
  type ActivityScreenSearch,
  activityAnswerCopy,
  activityIntegrationName,
  activityRows,
  activityScreenQuery,
  type FilterItem,
  type IntegrationNames,
  integrationFilterItems,
  isFiltered,
} from "@/lib/activity-screen";
import { agentMark } from "@/lib/agent-cards";
import { type AgentListItem, agentsQuery } from "@/lib/agent-queries";
import { connectionsQuery } from "@/lib/connection-queries";
import {
  type ActivityRun,
  ALL,
  activityToolLabel,
  refusalSentence,
  timeTakenLabel,
} from "@/lib/integration-activity";
import { integrationsQuery } from "@/lib/integration-queries";
import { ACTIVITY_ANSWER_CHIP, ACTIVITY_OUTCOME_CHIP } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

/**
 * The body's states (GRA-47) spanning the columns actually shown: three below `md`, where Agent,
 * Integration and Time taken step out, and six from `md`. Under `table-fixed` a span wider than
 * the header adds an auto column, so each state carries one cell per breakpoint, as the
 * integration page's Activity tab does.
 */
function StateCells({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <>
      <TableCell colSpan={3} className={cn("whitespace-normal md:hidden", className)}>
        {children}
      </TableCell>
      <TableCell colSpan={6} className={cn("hidden whitespace-normal md:table-cell", className)}>
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
      {[0, 1, 2, 3, 4].map((row) => (
        <DataTableRow key={row}>
          <StateCells className="px-4">
            <Skeleton className="h-5 w-full" />
          </StateCells>
        </DataTableRow>
      ))}
    </>
  );
}

const OUTCOME_ITEMS: FilterItem[] = [
  { value: ALL, label: "All outcomes" },
  ...ACTIVITY_SCREEN_OUTCOMES.map((value) => ({
    value,
    label: ACTIVITY_SCREEN_OUTCOME_LABELS[value],
  })),
];

/** A filter's `Select`, `items` on the root so the closed trigger shows the option's label. */
function FilterSelect({
  label,
  value,
  items,
  icon,
  onChange,
}: {
  label: string;
  value: string;
  items: FilterItem[];
  icon?: boolean;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) =>
        onChange(typeof next === "string" && next !== ALL ? next : undefined)
      }
    >
      <SelectTrigger size="sm" aria-label={label}>
        {icon ? <FilterListIcon /> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The Activity screen's table (GRA-330; the integration page's Activity table, Figma 2095:10473,
 * across every integration): calls and the person's answers, newest first, from the activity read
 * (GRA-308). The three filters are the route's search, so they survive a reload and change the
 * server's query rather than hiding rows already loaded; "Show older" fetches the next page by the
 * read's cursor.
 */
export function ActivityTable({
  filters,
  onFiltersChange,
}: {
  filters: ActivityScreenSearch;
  onFiltersChange: (next: ActivityScreenSearch) => void;
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
  } = useInfiniteQuery(activityScreenQuery(filters));
  const { data: agentData } = useQuery(agentsQuery);
  const { data: integrationData } = useQuery(integrationsQuery);
  const { data: connectionData } = useQuery(connectionsQuery);

  const agents = agentData?.agents ?? [];
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const connections = connectionData?.connections ?? [];
  const names: IntegrationNames = {
    byVendor: new Map(
      (integrationData?.integrations ?? []).map((row) => [row.vendor, row.displayName]),
    ),
    byConnection: new Map(connections.map((row) => [row.id, row.displayName])),
  };
  const rows = activityRows(data?.pages);
  // `isError` is also set when an older page or a background refetch fails; the rows already
  // loaded stay, and only a read with nothing to show takes the body to the retry notice.
  const failedOutright = isError && data === undefined;

  const agentItems: FilterItem[] = [
    { value: ALL, label: "All agents" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  // An agent the list does not hold (another person's id pasted into the URL) still shows what
  // the table filters by rather than a blank trigger.
  if (filters.agent && !agentsById.has(filters.agent)) {
    agentItems.push({ value: filters.agent, label: "Another agent" });
  }
  const integrationItems: FilterItem[] = [
    { value: ALL, label: "All integrations" },
    ...integrationFilterItems(connections, names, filters.vendor),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Integration"
          icon
          value={filters.vendor ?? ALL}
          items={integrationItems}
          onChange={(vendor) => onFiltersChange({ ...filters, vendor })}
        />
        <FilterSelect
          label="Agent"
          value={filters.agent ?? ALL}
          items={agentItems}
          onChange={(agent) => onFiltersChange({ ...filters, agent })}
        />
        <FilterSelect
          label="Outcome"
          value={filters.outcome ?? ALL}
          items={OUTCOME_ITEMS}
          onChange={(outcome) =>
            onFiltersChange({
              ...filters,
              outcome:
                outcome && (ACTIVITY_SCREEN_OUTCOMES as readonly string[]).includes(outcome)
                  ? (outcome as ActivityScreenOutcome)
                  : undefined,
            })
          }
        />
        <p className="ml-auto hidden text-muted-foreground text-xs sm:block">
          Every tool call and every answer you gave, newest first
        </p>
      </div>
      <Card className="gap-0 py-0">
        <DataTable layout="grid">
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28 px-4 md:w-36">When</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Agent</TableHead>
              <TableHead className="hidden md:table-cell md:w-36">Integration</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead className="w-24 pr-4 md:w-28 md:pr-2">Outcome</TableHead>
              <TableHead className="hidden pr-4 text-right md:table-cell md:w-24">
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
                  message="Could not load your activity."
                  onRetry={() => void refetch()}
                  retrying={isFetching}
                />
              </StateNote>
            ) : rows.length === 0 ? (
              <StateNote>
                {isFiltered(filters)
                  ? "Nothing matches these filters."
                  : "Nothing has happened yet. Tool calls and your answers appear here as your agents work."}
              </StateNote>
            ) : (
              rows.map((row) => (
                <ActivityTableRow
                  key={row.key}
                  row={row}
                  agent={agentsById.get(row.agent.id)}
                  integrationName={activityIntegrationName(row, names)}
                />
              ))
            )}
          </TableBody>
        </DataTable>
        {/* Below the table rather than a row of it, as the integration tab's: a full-span row
            would need a cell per breakpoint for the columns that step out below `md`. */}
        {hasNextPage && !failedOutright ? (
          <div className="flex items-center gap-3 border-border border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading older activity" : "Show older"}
              <KeyboardArrowDownIcon />
            </Button>
            {isFetchNextPageError && !isFetchingNextPage ? (
              <span className="text-muted-foreground text-xs">
                Could not load older activity. Try again.
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
      <p className="flex gap-2 text-muted-foreground text-xs">
        <InfoIcon className="mt-px size-3.5 shrink-0" />
        <span>
          Graft records which tool ran, for which agent, how it ended and how long it took, and what
          you answered. It never records what a tool read from or sent to an integration.
        </span>
      </p>
    </div>
  );
}

function ActivityTableRow({
  row,
  agent,
  integrationName,
}: {
  row: ActivityRow;
  agent: AgentListItem | undefined;
  integrationName: string | null;
}) {
  return (
    <DataTableRow>
      <TableCell className="whitespace-normal px-4 text-muted-foreground md:truncate md:whitespace-nowrap">
        <Time iso={row.at} />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="flex min-w-0 items-center gap-2">
          <HarnessMark
            mark={agent ? agentMark(agent, undefined) : "generic"}
            tile="none"
            className="size-4"
          />
          <span className="truncate">{row.agent.name}</span>
        </span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {row.vendor ? (
          <Link
            to="/integrations/$vendor"
            params={{ vendor: row.vendor }}
            className="flex min-w-0 items-center gap-2 rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <IntegrationMark
              slug={row.vendor}
              name={integrationName}
              tile="none"
              className="size-4"
            />
            <span className="truncate">{integrationName}</span>
          </Link>
        ) : (
          <span className="text-muted-foreground">Not recorded</span>
        )}
      </TableCell>
      {row.kind === "run" ? (
        <RunCells run={row} integrationName={integrationName} />
      ) : (
        <AnswerCells approval={row} integrationName={integrationName} />
      )}
    </DataTableRow>
  );
}

function RunCells({ run, integrationName }: { run: ActivityRun; integrationName: string | null }) {
  const chip = ACTIVITY_OUTCOME_CHIP[run.outcome];
  const why = run.outcome === "refused" ? refusalSentence(run.reason) : null;
  const tool = activityToolLabel(run.tool.wireName);
  const compact = [run.agent.name, integrationName, timeTakenLabel(run)]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <TableCell>
        <span className="flex min-w-0 flex-col">
          <span className="truncate" title={run.tool.wireName}>
            {tool}
          </span>
          {/* Below `md` Agent, Integration and Time taken step out and follow the tool. */}
          <span className="truncate text-muted-foreground text-xs md:hidden">{compact}</span>
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
    </>
  );
}

/**
 * An answer's row: the sentence in the Tool column, since it names the tool (or the integration)
 * it was about, and the answer's chip. Nothing ran, so Time taken is empty. Below `md` the
 * sentence wraps to two lines rather than cutting at a few words, since it is the row's whole fact.
 */
function AnswerCells({
  approval,
  integrationName,
}: {
  approval: ActivityApproval;
  integrationName: string | null;
}) {
  const copy = activityAnswerCopy(approval, integrationName);
  return (
    <>
      <TableCell>
        <span
          className="line-clamp-2 whitespace-normal md:block md:truncate md:whitespace-nowrap"
          title={copy.sentence}
        >
          {copy.sentence}
        </span>
      </TableCell>
      <TableCell className="pr-4 md:pr-2">
        <StatusChip chip={ACTIVITY_ANSWER_CHIP[copy.outcome]} />
      </TableCell>
      <TableCell className="hidden md:table-cell" />
    </>
  );
}
