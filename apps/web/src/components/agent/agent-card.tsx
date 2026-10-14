import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { AgentActions } from "@/components/agent/agent-actions";
import { AgentConnectionDialog } from "@/components/agent/agent-connection-dialog";
import { HarnessMark, IntegrationMark } from "@/components/marks";
import { StatusChip } from "@/components/status-chip";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  agentCanUse,
  agentClientLine,
  agentMark,
  connectAgentTarget,
  requestsLabel,
  toolsReadyLabel,
} from "@/lib/agent-cards";
import type { AgentListItem } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import type { SetupStateData } from "@/lib/setup-queries";
import { agentStatusChip } from "@/lib/status-chips";

/**
 * One agent on the agents screen (GRA-324; Figma "Graft / Agent card"): its mark, name and the
 * client that consented, its status, the integrations its scope reaches, when it last ran and how
 * many tools it keeps ready, and what waits on the person: its open requests, or *Connect its
 * agent* while it awaits its harness (ADR 0024). The menu holds the rest of what the table offered.
 * Composed from `Card`, `Badge`, `Button` and the shared marks (ADR 0017).
 */
export function AgentCard({
  agent,
  connections,
  requests,
  setup,
}: {
  agent: AgentListItem;
  connections: readonly Connection[];
  requests: number;
  setup: SetupStateData | undefined;
}) {
  const canUse = agentCanUse(agent, connections);
  const target = connectAgentTarget(agent, setup);
  const revoked = Boolean(agent.revokedAt);

  return (
    <Card className="gap-4 rounded-lg [--card-spacing:--spacing(5)]">
      <div className="flex items-center gap-3 px-(--card-spacing)">
        <HarnessMark mark={agentMark(agent, setup)} tileSize={40} size={22} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            className="truncate rounded-sm font-medium text-base underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {agent.name}
          </Link>
          <span className="break-words text-muted-foreground text-xs">
            {agentClientLine(agent)}
          </span>
        </div>
        <StatusChip chip={agentStatusChip(agent)} />
        <div className="-mr-2 shrink-0">
          <AgentActions agent={agent} />
        </div>
      </div>

      <div className="flex items-center gap-2 px-(--card-spacing) text-muted-foreground text-xs">
        <span>Can use</span>
        {canUse.shown.length === 0 ? (
          <span>No integrations yet</span>
        ) : (
          <>
            <span className="flex items-center gap-1">
              {canUse.shown.map((connection) => (
                <IntegrationMark
                  key={connection.vendor}
                  slug={connection.vendor}
                  name={connection.displayName}
                  tile="none"
                  className="size-[18px]"
                />
              ))}
            </span>
            <span className="sr-only">
              {canUse.shown.map((connection) => connection.displayName).join(", ")}
            </span>
            {canUse.more > 0 ? <span>+{canUse.more}</span> : null}
          </>
        )}
      </div>

      <div className="mx-(--card-spacing) flex min-h-7 items-center justify-between gap-2 border-t pt-3 text-muted-foreground text-xs">
        <span className="min-w-0">
          {agent.lastActiveAt ? (
            <>
              Active <Time iso={agent.lastActiveAt} />
            </>
          ) : (
            <>
              Created <Time iso={agent.createdAt} />
            </>
          )}
          {" · "}
          <span title={`Up to ${agent.workingSetCap} tools`}>
            {toolsReadyLabel(agent.workingSetCount)}
          </span>
        </span>
        {revoked ? null : target === "setup" ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/setup" search={{ agent: agent.id }} />}
          >
            Connect its agent
          </Button>
        ) : target === "dialog" ? (
          <ConnectItsAgent agent={agent} />
        ) : requests > 0 ? (
          <Badge render={<Link to="/pending" />}>{requestsLabel(requests)}</Badge>
        ) : null}
      </div>
    </Card>
  );
}

function ConnectItsAgent({ agent }: { agent: AgentListItem }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [connecting, setConnecting] = useState(false);
  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-label={`Connect ${agent.name}`}
        onClick={() => setConnecting(true)}
      >
        Connect its agent
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
