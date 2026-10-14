import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { RevokeConnectionDialog } from "@/components/connection/revoke-connection-dialog";
import { MoreHorizIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@/components/page/page-header";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { count } from "@/lib/format";
import { agentsCanUseLine, type IntegrationPage } from "@/lib/integration-page";

type Page = Extract<IntegrationPage, { kind: "integration" }>;

/**
 * The integration page's header (GRA-315; Figma 2044:7001): the mark in a 56px outlined tile, the
 * name, the status chip and one line of facts (since when, the tool count, how many agents can use
 * it). The account label joins the line when GRA-300 provides it; Get a new tool is GRA-320's.
 *
 * The ⋯ menu holds the page's ways out and, for an integration with one live connection, its
 * revoke; with several, each connection's revoke is on the Connection tab beside it.
 */
export function IntegrationHeader({ page }: { page: Page }) {
  const [revoking, setRevoking] = useState(false);
  const liveConnections = page.connections.filter((connection) => connection.state !== "revoked");
  const only = liveConnections.length === 1 ? liveConnections[0] : undefined;

  return (
    <PageHeader className="items-center gap-4">
      <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        <IntegrationMark
          slug={page.vendor}
          name={page.displayName}
          tile="none"
          className="size-8"
        />
      </span>
      <PageHeaderContent>
        <PageHeaderTitle className="truncate text-3xl tracking-tight">
          {page.displayName}
        </PageHeaderTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
          <StatusChip chip={page.chip} />
          <span>
            {page.since.verb} <Time iso={page.since.at} /> · {count(page.toolCount, "tool")} ·{" "}
            {agentsCanUseLine(page.agentCount)}
          </span>
        </div>
      </PageHeaderContent>
      <PageHeaderActions>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="icon" />}
            aria-label={`Actions for ${page.displayName}`}
          >
            <MoreHorizIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max min-w-44 whitespace-nowrap">
            <DropdownMenuItem
              render={
                <Link
                  to="/integrations/$vendor"
                  params={{ vendor: page.vendor }}
                  search={{ tab: "connection" }}
                />
              }
            >
              Connection details
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link to="/connections" />}>All connections</DropdownMenuItem>
            {only ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setRevoking(true)}>
                  Revoke {only.displayName}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeaderActions>
      {only ? (
        <RevokeConnectionDialog connection={only} open={revoking} onOpenChange={setRevoking} />
      ) : null}
    </PageHeader>
  );
}
