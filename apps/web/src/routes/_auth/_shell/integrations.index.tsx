import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { AddConnectionDialog } from "@/components/connection/add-connection-dialog";
import { ConnectionCard } from "@/components/connection/connection-card";
import {
  AddIcon,
  FilterListIcon,
  KeyboardArrowDownIcon,
  KeyboardArrowUpIcon,
  SearchIcon,
} from "@/components/icons";
import { IntegrationsTable } from "@/components/integration/integrations-table";
import { SuggestedBanner } from "@/components/integration/suggested-banner";
import { PageContainer } from "@/components/page/page-container";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { useScreenTitle } from "@/components/shell/screen-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { connectionsQuery, toolsOfConnection, toolsQuery } from "@/lib/connection-queries";
import { integrationsQuery, suggestedIntegrationsQuery } from "@/lib/integration-queries";
import {
  INTEGRATIONS_SORT_ITEMS,
  type IntegrationsListTab,
  type IntegrationsSort,
  integrationsListOf,
  readIntegrationsListSearch,
  readIntegrationsSort,
  suggestedVendorsOf,
} from "@/lib/integrations-list";
import { cn } from "@/lib/utils";

/**
 * The Integrations screen (GRA-321; Figma 2059:7655): what the person has connected, one row per
 * integration (GRA-291), with Connected and Discover tabs. Discover is GRA-322's; until it lands
 * `?tab=discover` is a placeholder that keeps Add connection, so the banner's link and the tab
 * have somewhere to go. `/connections` redirects here.
 *
 * Revoked connections are on no row (GRA-291), and this is still where one is reconnected or its
 * provider's release retried (ADR 0007, ADR 0019), so they stay below the table as the connection
 * cards they were, behind a disclosure.
 *
 * The loader starts the reads and awaits none, so the table paints its own pending rows (the
 * agents table's reasoning, `agents.index.tsx`).
 */
export const Route = createFileRoute("/_auth/_shell/integrations/")({
  validateSearch: readIntegrationsListSearch,
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(integrationsQuery);
    void context.queryClient.prefetchQuery(suggestedIntegrationsQuery);
  },
  component: IntegrationsRoute,
});

function IntegrationsRoute() {
  const { tab = "connected" } = Route.useSearch();
  const integrations = useQuery(integrationsQuery);
  const [adding, setAdding] = useState(false);
  const rows = integrations.data?.integrations ?? [];

  useScreenTitle("Integrations");

  return (
    // `large`: the frame's 1120 column. `gap-4` between the header and the list (GRA-47).
    <PageContainer size="large" className="gap-4">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Integrations</PageHeaderTitle>
          <PageHeaderDescription>
            Sign in once and your agents can use it. They never see your password.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          {/* Until Discover lands (GRA-322), the way to connect one with no agent asking. */}
          <Button onClick={() => setAdding(true)}>
            <AddIcon />
            Add connection
          </Button>
        </PageHeaderActions>
      </PageHeader>

      <div className="flex flex-col gap-6">
        <ListTabs current={tab} connected={integrations.data ? rows.length : undefined} />
        {tab === "connected" ? (
          <ConnectedTab
            rows={rows}
            isPending={integrations.isPending}
            isError={integrations.isError}
            error={integrations.error}
            retrying={integrations.isFetching}
            onRetry={() => void integrations.refetch()}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            The integrations you can connect, and the ones your agents asked about, will be listed
            here. Until then, Add connection connects one by its address.
          </p>
        )}
      </div>

      <AddConnectionDialog open={adding} onOpenChange={setAdding} />
    </PageContainer>
  );
}

const TAB_LABELS: Record<IntegrationsListTab, string> = {
  connected: "Connected",
  discover: "Discover",
};

/**
 * The tab bar, as the integration page's (`integration-tabs.tsx`): links over a rule, the open tab
 * foreground on a 2px primary underline, so a tab is a deep link and Back steps through them.
 */
function ListTabs({
  current,
  connected,
}: {
  current: IntegrationsListTab;
  /** Undefined until the integrations read lands, so the badge never reads 0 while loading. */
  connected: number | undefined;
}) {
  return (
    <nav aria-label="Integrations sections" className="flex gap-5 border-border border-b">
      {(["connected", "discover"] as const).map((tab) => {
        const active = tab === current;
        return (
          <Link
            key={tab}
            to="/integrations"
            search={tab === "discover" ? { tab } : {}}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1 rounded-t-md border-b-2 px-1.5 pb-1 font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {TAB_LABELS[tab]}
            {tab === "connected" && connected !== undefined ? (
              <Badge variant="secondary">{connected}</Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function ConnectedTab({
  rows,
  ...state
}: {
  rows: Parameters<typeof integrationsListOf>[0];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<IntegrationsSort>("attention");
  const suggestions = useQuery(suggestedIntegrationsQuery);
  const shown = integrationsListOf(rows, { query, sort });
  // A failed suggestions read hides the banner: it is a nudge, never what the screen is for.
  const suggested = suggestedVendorsOf(suggestions.data?.suggestions ?? [], rows);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="w-full sm:w-80">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search your integrations"
            placeholder="Search your integrations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <Select
          value={sort}
          items={INTEGRATIONS_SORT_ITEMS}
          onValueChange={(next) => {
            const read = readIntegrationsSort(next);
            if (read) setSort(read);
          }}
        >
          <SelectTrigger aria-label="Sort" className="sm:ml-auto">
            <FilterListIcon />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {INTEGRATIONS_SORT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <IntegrationsTable
        rows={shown}
        {...state}
        empty={
          rows.length === 0
            ? "Nothing connected yet. An agent asks when it needs an integration, or add one yourself."
            : `No integration matches "${query.trim()}".`
        }
      />

      <SuggestedBanner suggested={suggested} />

      <RevokedConnections />
    </>
  );
}

/**
 * The person's revoked connections, as the connection cards that reconnect them (re-enter the
 * credential, Reconnect, Retry release); closed until asked for, and absent when there are none.
 */
function RevokedConnections() {
  const [open, setOpen] = useState(false);
  const connections = useQuery(connectionsQuery);
  const tools = useQuery({ ...toolsQuery, enabled: open });
  const revoked = (connections.data?.connections ?? []).filter(
    (connection) => connection.revokedAt !== null,
  );
  if (revoked.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2.5 self-start"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        Revoked connections ({revoked.length})
      </Button>
      {open ? (
        <div className="flex flex-col gap-4">
          {revoked.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              tools={toolsOfConnection(tools.data?.tools ?? [], connection)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
