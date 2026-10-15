import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
import { MoreHorizIcon } from "@/components/icons";
import { SignInButton } from "@/components/integration/sign-in-button";
import { HarnessMark, IntegrationMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { TableBodyNote, TableLoadingRows } from "@/components/table-body-states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableRow } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Integration, IntegrationConnection } from "@/lib/integration-queries";
import {
  attentionSentence,
  integrationSubline,
  signInOf,
  toolsCell,
  usedByLabel,
} from "@/lib/integrations-list";
import { harnessMark } from "@/lib/marks";
import { cn } from "@/lib/utils";

const COLUMNS = 5;

/** How many agents' marks the Used by cell stacks before the count says the rest. */
const STACKED_MARKS = 3;

/**
 * The Connected tab's table (GRA-321; Figma 2059:7655): one row per integration the person holds
 * a live connection of (GRA-291), its mark and name linking to the integration's page (GRA-315).
 * GRA-47's shape: widths on the header cells, the pending, failed and empty states as rows inside
 * the body, and at 390px Used by and Last used step out, the name and the action staying.
 *
 * The action is Sign in where a connection needs the person and the console can sign it in
 * (`signInOf`), by the way its own page does; every other row has the ⋯ menu, whose revoke lists
 * each connection when the integration has several.
 */
export function IntegrationsTable({
  rows,
  isPending,
  isError,
  error,
  retrying,
  onRetry,
  empty,
}: {
  rows: readonly Integration[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  /** The sentence for no rows: nothing connected yet, or nothing matching the search. */
  empty: React.ReactNode;
}) {
  return (
    <DataTable layout="grid">
      <TableHeader>
        <TableRow>
          <TableHead>Integration</TableHead>
          <TableHead className="hidden md:table-cell md:w-44 lg:w-50">Used by</TableHead>
          <TableHead className="w-24 md:w-40">Tools</TableHead>
          <TableHead className="hidden md:table-cell md:w-30">Last used</TableHead>
          <TableHead className="w-24">
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
              message="Could not load your integrations."
              onRetry={onRetry}
              retrying={retrying}
            />
          </TableBodyNote>
        ) : rows.length === 0 ? (
          <TableBodyNote colSpan={COLUMNS} className="text-center">
            {empty}
          </TableBodyNote>
        ) : (
          rows.map((row) => <IntegrationRow key={row.vendor} row={row} />)
        )}
      </TableBody>
    </DataTable>
  );
}

function IntegrationRow({ row }: { row: Integration }) {
  const attention = attentionSentence(row);
  const tools = toolsCell(row);
  return (
    <DataTableRow className="h-16">
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <IntegrationMark slug={row.vendor} name={row.displayName} tile="outline" tileSize={36} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              to="/integrations/$vendor"
              params={{ vendor: row.vendor }}
              className="truncate rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {row.displayName}
            </Link>
            <span
              className={cn(
                "truncate text-xs",
                attention ? "text-destructive" : "text-muted-foreground",
              )}
              title={attention ?? undefined}
            >
              {attention ?? integrationSubline(row)}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <UsedBy row={row} />
      </TableCell>
      <TableCell
        className={cn(
          tools.blocked ? "whitespace-normal text-destructive" : "tabular-nums",
          "text-sm",
        )}
      >
        <div className="flex flex-col gap-0.5">
          <span>{tools.text}</span>
          {tools.inUse ? (
            <span className="text-muted-foreground text-xs">{tools.inUse}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="hidden truncate text-muted-foreground md:table-cell">
        {row.lastUsedAt ? <Time iso={row.lastUsedAt} /> : "Never"}
      </TableCell>
      <TableCell className="p-0">
        <div className="flex justify-end px-2">
          <RowAction row={row} />
        </div>
      </TableCell>
    </DataTableRow>
  );
}

/** The agents' harness marks, overlapped as the frame draws them, and the name or the count. */
function UsedBy({ row }: { row: Integration }) {
  const label = usedByLabel(row);
  if (row.agents.length === 0) return <span className="text-muted-foreground">{label}</span>;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center">
        {row.agents.slice(0, STACKED_MARKS).map((agent, index) => (
          <span
            key={agent.id}
            className={cn(
              "flex size-6 items-center justify-center overflow-hidden rounded-full border border-border bg-card",
              index > 0 && "-ml-1.5",
            )}
            style={{ zIndex: STACKED_MARKS - index }}
          >
            <HarnessMark mark={harnessMark(agent.harness)} tile="none" className="size-3.5" />
          </span>
        ))}
      </span>
      <span className="truncate" title={row.agents.map((agent) => agent.name).join(", ")}>
        {label}
      </span>
    </div>
  );
}

function RowAction({ row }: { row: Integration }) {
  const signIn = signInOf(row);
  return signIn ? (
    <SignInButton connection={signIn.connection} kind={signIn.action.kind} />
  ) : (
    <RowMenu row={row} />
  );
}

/**
 * The row's ways on: the integration's page, its Connection tab, and revoke. With one connection
 * the revoke names it; with several the menu lists each under *Revoke*, so the person picks the
 * one, and the connections screen's own dialog says what goes with it (ADR 0007).
 */
function RowMenu({ row }: { row: Integration }) {
  const [revoking, setRevoking] = useState<IntegrationConnection | null>(null);
  const [only] = row.connections;
  const several = row.connections.length > 1;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label={`Actions for ${row.displayName}`}
        >
          <MoreHorizIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-max min-w-44 whitespace-nowrap">
          <DropdownMenuItem
            render={<Link to="/integrations/$vendor" params={{ vendor: row.vendor }} />}
          >
            Open {row.displayName}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                to="/integrations/$vendor"
                params={{ vendor: row.vendor }}
                search={{ tab: "connection" }}
              />
            }
          >
            Connection details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {several ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Revoke</DropdownMenuLabel>
              {row.connections.map((connection) => (
                <DropdownMenuItem
                  key={connection.id}
                  variant="destructive"
                  onClick={() => setRevoking(connection)}
                >
                  {connection.displayName}
                  {/* Two accounts of one integration often share a name; when each was made tells them apart. */}
                  <span className="ml-auto pl-4 text-muted-foreground text-xs">
                    connected <Time iso={connection.createdAt} />
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ) : only ? (
            <DropdownMenuItem variant="destructive" onClick={() => setRevoking(only)}>
              Revoke {only.displayName}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {revoking ? (
        <RevokeConnectionDialog
          connection={revoking}
          open
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
        />
      ) : null}
    </>
  );
}
