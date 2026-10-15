/**
 * Requests' search and its filter by agent (GRA-312; the Figma frame "03a Requests > Filter by
 * agent"). Client-side over the reads already on the page: the menu offers the active agents
 * alone, each with its open count, since a revoked agent's asks are closed with it (ADR 0007).
 */

export type RequestsTab = "open" | "done";

export type RequestsSearch = { tab?: "done"; agent?: string };

/**
 * The route's search: `tab` only when it is `done` and `agent` only when it is a non-empty
 * string, so `/pending` is the Open tab over every agent and a stray value never sticks.
 */
export function readRequestsSearch(search: Record<string, unknown>): RequestsSearch {
  const out: RequestsSearch = {};
  if (search.tab === "done") out.tab = "done";
  if (typeof search.agent === "string" && search.agent !== "") out.agent = search.agent;
  return out;
}

export type AgentFilterOption = {
  id: string;
  name: string;
  clientName: string | null;
  count: number;
};

/** The menu's agents: active ones in the agents read's order, each with its open requests. */
export function agentFilterOptions(
  agents: readonly {
    id: string;
    name: string;
    revokedAt: string | null;
    connectedVia: { clientName: string | null } | null;
  }[],
  open: readonly { agentId: string }[],
): AgentFilterOption[] {
  const counts = new Map<string, number>();
  for (const action of open) counts.set(action.agentId, (counts.get(action.agentId) ?? 0) + 1);
  return agents
    .filter((agent) => agent.revokedAt === null)
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      clientName: agent.connectedVia?.clientName ?? null,
      count: counts.get(agent.id) ?? 0,
    }));
}

/**
 * The agent the list is filtered to: the search's, once the agents read names it among the active
 * ones. Null for every agent, and for an id that is no active agent of the person's (a revoked or
 * stale link), so the list never filters to an agent the menu cannot show.
 */
export function selectedAgent(
  agentId: string | undefined,
  options: readonly AgentFilterOption[],
): AgentFilterOption | null {
  if (!agentId) return null;
  return options.find((option) => option.id === agentId) ?? null;
}

/**
 * The agent id the rows are filtered by: the search's own until the agents read lands, so a link
 * from an agent's card never flashes every agent's rows first, then `selectedAgent`'s verdict.
 */
export function filterAgentId(
  agentId: string | undefined,
  options: readonly AgentFilterOption[] | undefined,
): string | null {
  if (!options) return agentId ?? null;
  return selectedAgent(agentId, options)?.id ?? null;
}

/** The rows of one agent, or every row. */
export function filterByAgent<T extends { agentId: string }>(
  rows: readonly T[],
  agentId: string | null,
): readonly T[] {
  return agentId ? rows.filter((row) => row.agentId === agentId) : rows;
}
