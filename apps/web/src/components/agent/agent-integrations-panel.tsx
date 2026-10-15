import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AddIcon, ArrowForwardIcon } from "@/components/icons";
import { IntegrationMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { SettingsCard, SettingsRowGroup } from "@/components/settings/settings-card";
import { SettingsToggleRow } from "@/components/settings/settings-row";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  type AgentIntegrationConnection,
  type AgentIntegrationRow,
  agentIntegrationRows,
  laterSwitchCopy,
} from "@/lib/agent-integrations";
import {
  type Agent,
  agentKeys,
  grantConnectionToAgent,
  removeConnectionFromAgent,
  setAgentScope,
} from "@/lib/agent-queries";
import { approvalsQuery, vendorApprovalsQuery } from "@/lib/approval-queries";
import { type Connection, toolsQuery } from "@/lib/connection-queries";
import { integrationKeys, integrationsQuery } from "@/lib/integration-queries";
import {
  type ScopeState,
  type ScopeToggleOutcome,
  type ScopeToggleWrite,
  scopeStateOf,
  turnConnection,
  turnLater,
} from "@/lib/scope-toggles";
import { CONNECTION_STATUS_CHIP, RECONNECT_CHIP } from "@/lib/status-chips";
import { cn } from "@/lib/utils";

/**
 * *Integrations X can use* (GRA-326; Figma 2047:7614): one row per integration with the line
 * `lib/agent-integrations.ts` words, a Reconnect chip where a connection needs the person, *Tools*
 * to the integration's page, and a switch per connection; at the foot, *Give X integrations I
 * connect later*. The switches are a view of the scope (ADR 0007 as amended 2026-09-19) through
 * GRA-294's `scope-toggles.ts`: each turn is the one write it names, and the page holds the scope
 * that write leaves until the server's answer replaces it, so no position exists the scope cannot.
 *
 * One write at a time: every switch is disabled while one is in flight, since a second turn
 * computed from the first's guessed state could land on a scope the person never saw.
 */
export function AgentIntegrationsPanel({
  agent,
  connectionIds,
  connections,
}: {
  agent: Agent;
  /** The scope as `GET /agents/:id` resolves it under the agent's mode. */
  connectionIds: readonly string[];
  connections: readonly Connection[];
}) {
  const queryClient = useQueryClient();
  const toolbox = useQuery(toolsQuery);
  const approvals = useQuery(approvalsQuery(agent.id));
  const vendorApprovals = useQuery(vendorApprovalsQuery(agent.id));
  const integrations = useQuery(integrationsQuery);
  const [pending, setPending] = useState<ScopeState | null>(null);
  const saved = scopeStateOf({ agent, connectionIds });
  const scope = pending ?? saved;
  const frozen = agent.revokedAt !== null;

  const write = useMutation({
    mutationFn: (request: Exclude<ScopeToggleWrite, { kind: "none" }>) => {
      switch (request.kind) {
        case "scope":
          return setAgentScope(agent.id, request.body);
        case "grant":
          return grantConnectionToAgent(request.connectionId, agent.id);
        case "remove":
          return removeConnectionFromAgent(request.connectionId, agent.id);
      }
    },
    onSuccess: async (answer) => {
      queryClient.setQueryData(agentKeys.one(agent.id), {
        agent: answer.agent,
        connectionIds: answer.connectionIds,
      });
      // The list's scope column and the integrations' agent counts read the same scope.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        queryClient.invalidateQueries({ queryKey: integrationKeys.all }),
      ]);
    },
    onSettled: () => setPending(null),
  });

  const apply = (outcome: ScopeToggleOutcome, success: string) => {
    if (outcome.write.kind === "none") return;
    setPending(outcome.next);
    write.mutate(outcome.write, {
      onSuccess: () =>
        toast.success(success, {
          description: outcome.stopsLater
            ? `Integrations you connect later won't reach ${agent.name} until you turn them on here.`
            : `In effect on ${agent.name}'s next call.`,
        }),
    });
  };

  const turnOne = (entry: AgentIntegrationConnection, on: boolean) =>
    apply(
      turnConnection(scope, entry.connection.id, on),
      on
        ? `${agent.name} can use ${entry.connection.displayName}`
        : `${agent.name} can no longer use ${entry.connection.displayName}`,
    );

  const live = connections.filter((connection) => connection.revokedAt === null);
  const reads = [toolbox, approvals, vendorApprovals, integrations];
  // The access line waits on these four reads; the switches do not, since the scope and the
  // connections are the page's own (a failed read must never take away the way to turn one off).
  const access =
    toolbox.data && approvals.data && vendorApprovals.data && integrations.data
      ? {
          tools: toolbox.data.tools,
          approvals: approvals.data.approvals,
          vendorApprovals: vendorApprovals.data.vendorApprovals,
          toolCounts: integrations.data.integrations,
        }
      : null;
  const failed = reads.find((read) => read.isError);
  const rows = agentIntegrationRows({ agentName: agent.name, connections, scope, access });
  const later = laterSwitchCopy(agent.name);
  const busy = frozen || write.isPending;

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-heading font-medium text-lg">Integrations {agent.name} can use</h2>
          <p className="text-muted-foreground text-sm">
            {agent.name} only sees tools for integrations that are on. Changes still ask first.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/integrations" search={{ tab: "discover" }} />}
        >
          <AddIcon data-icon="inline-start" />
          Connect an integration
        </Button>
      </div>
      <SettingsCard>
        <SettingsRowGroup>
          {failed ? (
            <div className="px-4 py-3.5">
              <RetryNotice
                error={failed.error}
                message="Could not load what this agent can run without asking."
                retrying={reads.some((read) => read.isFetching)}
                onRetry={() => {
                  for (const read of reads) if (read.isError) void read.refetch();
                }}
              />
            </div>
          ) : null}
          {rows.length === 0 ? (
            <p className="px-4 py-3.5 text-muted-foreground text-sm">
              No integrations connected yet.
            </p>
          ) : (
            rows.map((row) => (
              <IntegrationRow
                key={row.vendor}
                row={row}
                agentName={agent.name}
                loading={access === null && !failed}
                disabled={busy}
                onTurn={turnOne}
              />
            ))
          )}
          <SettingsToggleRow
            className="bg-muted/50"
            title={later.title}
            description={later.description}
            checked={scope.mode === "all"}
            disabled={busy}
            onCheckedChange={(on) =>
              apply(
                turnLater(
                  scope,
                  on,
                  live.map((connection) => connection.id),
                ),
                on
                  ? `${agent.name} gets integrations you connect later`
                  : `${agent.name} keeps the integrations it has`,
              )
            }
          />
        </SettingsRowGroup>
      </SettingsCard>
    </section>
  );
}

/**
 * One integration. Its one connection's switch sits on the row; an integration with several lists
 * them under it, each with its own, since a switch is one connection (GRA-294).
 */
function IntegrationRow({
  row,
  agentName,
  loading,
  disabled,
  onTurn,
}: {
  row: AgentIntegrationRow;
  agentName: string;
  /** The access line's reads are in flight: a skeleton stands where the line will be. */
  loading: boolean;
  disabled: boolean;
  onTurn: (entry: AgentIntegrationConnection, on: boolean) => void;
}) {
  const [only] = row.connections;
  const single = row.connections.length === 1 ? only : undefined;
  const dim = !row.connections.some((entry) => entry.on);
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <IntegrationMark
          slug={row.vendor}
          name={row.displayName}
          tile="outline"
          tileSize={36}
          className={cn(dim && "opacity-60")}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-sm">{row.displayName}</span>
            {row.needsReconnect ? (
              <Link
                to="/integrations/$vendor"
                params={{ vendor: row.vendor }}
                search={{ tab: "connection" }}
                className="rounded-4xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <StatusChip chip={RECONNECT_CHIP} />
              </Link>
            ) : null}
          </div>
          {loading ? (
            <Skeleton className="h-4 w-48 max-w-full" />
          ) : (
            <span className="text-muted-foreground text-xs">{row.line}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/integrations/$vendor" params={{ vendor: row.vendor }} />}
          aria-label={`${row.displayName} tools`}
        >
          Tools
          <ArrowForwardIcon data-icon="inline-end" />
        </Button>
        {single ? (
          <Switch
            aria-label={`${agentName} can use ${row.displayName}`}
            checked={single.on}
            disabled={disabled}
            onCheckedChange={(on) => onTurn(single, on)}
          />
        ) : null}
      </div>
      {single ? null : (
        <ul className="ml-12 flex flex-col gap-2">
          {row.connections.map((entry) => (
            <ConnectionLine
              key={entry.connection.id}
              entry={entry}
              agentName={agentName}
              disabled={disabled}
              onTurn={onTurn}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionLine({
  entry,
  agentName,
  disabled,
  onTurn,
}: {
  entry: AgentIntegrationConnection;
  agentName: string;
  disabled: boolean;
  onTurn: (entry: AgentIntegrationConnection, on: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm">{entry.connection.displayName}</span>
        <span className="hidden truncate text-muted-foreground text-xs sm:inline">
          {entry.connection.primaryHost}
        </span>
        {entry.status === "connected" ? null : (
          <StatusChip chip={CONNECTION_STATUS_CHIP[entry.status]} />
        )}
      </div>
      <Switch
        aria-label={`${agentName} can use ${entry.connection.displayName}`}
        checked={entry.on}
        disabled={disabled}
        onCheckedChange={(on) => onTurn(entry, on)}
      />
    </li>
  );
}
