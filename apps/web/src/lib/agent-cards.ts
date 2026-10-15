import { isAwaitingHarness } from "@graft/core/setup/setup.rules";

import type { AgentListItem } from "./agent-queries";
import type { Connection } from "./connection-queries";
import { count } from "./format";
import { type HarnessMarkId, harnessMark, harnessMarkOfSetup } from "./marks";
import type { PendingAction } from "./pending-action-queries";
import type { SetupStateData } from "./setup-queries";

/**
 * What the agents screen's cards say (GRA-324), as pure decisions; `components/agent/agent-card.tsx`
 * draws them. The list read carries each agent's scope as `connectionIds` and its last call as
 * `lastActiveAt` (GRA-290); the request count is the open asks the console already reads.
 */

/** How many integration marks a card draws before "+N". */
export const CAN_USE_MARKS = 3;

/** Active agents first in the server's order, then the revoked ones, which sit under a disclosure. */
export function groupAgents<T extends Pick<AgentListItem, "revokedAt">>(
  agents: readonly T[],
): { active: T[]; revoked: T[] } {
  return {
    active: agents.filter((agent) => !agent.revokedAt),
    revoked: agents.filter((agent) => agent.revokedAt),
  };
}

/**
 * The integrations an agent can use: its scope joined to the person's connections, revoked ones
 * left out, one mark per integration (two accounts of one vendor are one integration), in the
 * order the connections arrive. `shown` is what the card draws and `more` the "+N" beside it.
 */
export function agentCanUse(
  agent: Pick<AgentListItem, "connectionIds">,
  connections: readonly Connection[],
  limit = CAN_USE_MARKS,
): { shown: Connection[]; more: number } {
  const inScope = new Set(agent.connectionIds);
  const byVendor = new Map<string, Connection>();
  for (const connection of connections) {
    if (connection.revokedAt || !inScope.has(connection.id)) continue;
    if (!byVendor.has(connection.vendor)) byVendor.set(connection.vendor, connection);
  }
  const all = [...byVendor.values()];
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** The open asks per agent, from the list the Requests screen and the sidebar's count read. */
export function requestCounts(
  pendingActions: readonly Pick<PendingAction, "agentId">[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const action of pendingActions) {
    counts.set(action.agentId, (counts.get(action.agentId) ?? 0) + 1);
  }
  return counts;
}

/** "1 request", "3 requests": the person-facing word for an open ask (CONTEXT.md, *Request*). */
export function requestsLabel(n: number): string {
  return count(n, "request");
}

/** "1 tool ready", "4 tools ready": the agent's working set. */
export function toolsReadyLabel(n: number): string {
  return `${count(n, "tool")} ready`;
}

/**
 * The card's second line: the client that consented (ADR 0018), or *Not recorded* for a static
 * token, which records none. No device: Graft records none (GRA-287, item 2).
 */
export function agentClientLine(agent: Pick<AgentListItem, "connectedVia">): string {
  return agent.connectedVia ? `Signs in through ${agent.connectedVia.clientName}` : "Not recorded";
}

/**
 * The agent's mark: the consenting client's, else the harness Setup minted this agent for, which
 * the Setup record names while the agent awaits it; otherwise the generic glyph.
 */
export function agentMark(
  agent: Pick<AgentListItem, "id" | "connectedVia">,
  setup: Pick<SetupStateData, "setup" | "agent"> | undefined,
): HarnessMarkId {
  if (agent.connectedVia) return harnessMark(agent.connectedVia.clientName);
  const harness = setup?.agent?.id === agent.id ? setup.setup?.harness : null;
  return harness ? harnessMarkOfSetup(harness) : "generic";
}

/**
 * Where an agent awaiting its harness (ADR 0024) is connected from: Setup, when it is the agent a
 * Setup still running runs as, so the person resumes there; otherwise *Connect an agent*. A
 * skipped Setup is not running: the person said no to it, and an agent's own button that sent them
 * back in is a loop they cannot leave by skipping (GRA-347). *Resume Setup* is the way back, asked
 * for by name. Null for an agent that is not awaiting its harness, which draws no such action.
 */
export function connectAgentTarget(
  agent: Pick<AgentListItem, "id" | "revokedAt" | "tokenPrefix" | "connectedVia">,
  setup: Pick<SetupStateData, "setup" | "agent"> | undefined,
): "setup" | "dialog" | null {
  if (!isAwaitingHarness(agent)) return null;
  const record = setup?.setup;
  const running = record && !record.completedAt && !record.skippedAt;
  if (setup?.agent?.id === agent.id && running) return "setup";
  return "dialog";
}
