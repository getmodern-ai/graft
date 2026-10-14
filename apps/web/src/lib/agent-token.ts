import type { Agent } from "./agent-queries";

/**
 * Whether the agent page offers *Rotate token* (GRA-306): an active agent reached by a static
 * token and connected by no client. The server's `rotateAgentToken` holds the same rule; this only
 * decides whether the button is drawn, so an agent a client connected, one awaiting its first
 * token (*Connect a harness* issues that) and a revoked one show none.
 */
export function tokenRotatable(
  agent: Pick<Agent, "revokedAt" | "tokenPrefix" | "connectedVia">,
): boolean {
  return agent.revokedAt === null && agent.tokenPrefix !== null && agent.connectedVia === null;
}
