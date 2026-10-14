import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { AgentCard, type ConnectAgent } from "@/components/agent/agent-card";
import { AddIcon, InfoIcon, KeyboardArrowDownIcon, KeyboardArrowUpIcon } from "@/components/icons";
import { HarnessMark } from "@/components/marks";
import { RetryNotice } from "@/components/retry-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { groupAgents, requestCounts } from "@/lib/agent-cards";
import type { AgentListItem } from "@/lib/agent-queries";
import type { Connection } from "@/lib/connection-queries";
import type { HarnessMarkId } from "@/lib/marks";
import type { PendingAction } from "@/lib/pending-action-queries";
import type { SetupStateData } from "@/lib/setup-queries";

// Three across only where a card keeps room for its name beside the longest chip, *Not connected yet*.
const GRID = "grid gap-4 md:grid-cols-2 2xl:grid-cols-3";

/** The marks on the tile: the harnesses the marketing site and Setup lead with. */
const TILE_MARKS: readonly HarnessMarkId[] = ["claude", "chatgpt", "hermes", "openclaw"];

/**
 * The agents screen's body (GRA-324; Figma "Agents"): a card per active agent, a dashed tile that
 * adds one, the note on running one agent per device, and the revoked agents under a disclosure
 * below (GRA-287, item 3), each still opening its read-only page. Loading is skeleton cards and a
 * failed read the inline Retry, in the grid's place; an empty screen is the `Empty` primitive with
 * the offer of Setup to a person who skipped it (GRA-47, ADR 0024).
 */
export function AgentCards({
  agents,
  connections,
  connectionsFailed = false,
  pendingActions,
  setup,
  isPending,
  isError,
  error,
  retrying,
  onRetry,
  onAdd,
  onConnectAgent,
  offerSetup = false,
}: {
  agents: readonly AgentListItem[];
  /** Undefined until read: each card then draws its marks as loading, or as failed. */
  connections: readonly Connection[] | undefined;
  connectionsFailed?: boolean;
  pendingActions: readonly PendingAction[];
  setup: SetupStateData | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  onAdd: () => void;
  /** Opens the screen's *Connect an agent*, held above the cards (GRA-336). */
  onConnectAgent: ConnectAgent;
  /** A person who skipped Setup (ADR 0024) is offered it again from the empty screen. */
  offerSetup?: boolean;
}) {
  if (isPending) {
    return (
      <div className={GRID} aria-busy="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-40 rounded-lg" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <RetryNotice
        error={error}
        message="Could not load your agents."
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  }
  if (agents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            Add an agent to connect it to Graft
            {offerSetup ? ", or let Setup walk you through a first connection and tool." : "."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {offerSetup ? (
            <Button variant="outline" nativeButton={false} render={<Link to="/setup" />}>
              Set up Graft
            </Button>
          ) : null}
          <Button onClick={onAdd}>
            <AddIcon />
            Add an agent
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const { active, revoked } = groupAgents(agents);
  const requests = requestCounts(pendingActions);
  const card = (agent: AgentListItem) => (
    <AgentCard
      key={agent.id}
      agent={agent}
      connections={connections}
      connectionsFailed={connectionsFailed}
      requests={requests.get(agent.id) ?? 0}
      setup={setup}
      onConnectAgent={onConnectAgent}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <div className={GRID}>
        {active.map(card)}
        <AddAgentTile onAdd={onAdd} />
      </div>

      <Alert role="note" className="border-transparent bg-secondary px-4 py-3">
        <InfoIcon />
        <AlertTitle>Same agent on two devices?</AlertTitle>
        <AlertDescription>
          Connect each one as its own agent, with its own access, so a work laptop can use different
          integrations from a personal one. Name each after where it runs.
        </AlertDescription>
      </Alert>

      {revoked.length > 0 ? (
        <RevokedAgents count={revoked.length}>{revoked.map(card)}</RevokedAgents>
      ) : null}
    </div>
  );
}

function AddAgentTile({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-5 text-center">
      <div className="flex items-center gap-2">
        {TILE_MARKS.map((mark) => (
          <HarnessMark key={mark} mark={mark} tile="outline" tileSize={32} size={18} />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-medium text-sm">Connect another agent</span>
        <span className="text-muted-foreground text-xs">
          Works with Claude, ChatGPT, Hermes, OpenClaw and other agents that speak MCP.
        </span>
      </div>
      <Button variant="outline" size="sm" onClick={onAdd}>
        <AddIcon />
        Add an agent
      </Button>
    </div>
  );
}

function RevokedAgents({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        Revoked ({count})
      </Button>
      {open ? (
        <div id={id} className={GRID}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
