import {
  type ConnectionOutput,
  type ConnectionState,
  connectionStateOf,
  toConnectionOutput,
} from "../connection/connection.service";
import type { ServiceContext } from "../context";
import type { Principal } from "../tenancy";
import type { IntegrationDeps } from "./integration.deps";

/**
 * The integrations list (GRA-291): one row per vendor the person holds a live connection of, for
 * the console's Integrations screen and Home. A revoked connection is left out of its row, and a
 * vendor whose every connection is revoked has no row: the list is what is connected, and the
 * connections screen is still where a revoked row is reconnected (ADR 0007).
 */

/** A connection on its integration's row: the public shape, and where it stands. */
export type IntegrationConnectionOutput = ConnectionOutput & {
  state: Exclude<ConnectionState, "revoked">;
};

/** An active agent whose scope reaches one of the row's connections, and its harness (ADR 0018). */
export type IntegrationAgentOutput = { id: string; name: string; harness: string | null };

/** Why a row needs the person, from its worst connection. */
export type IntegrationAttentionReason = Exclude<ConnectionState, "connected" | "revoked">;

export type IntegrationOutput = {
  vendor: string;
  /** The oldest live connection's name. */
  displayName: string;
  /** The live connections of the vendor, oldest first. */
  connections: IntegrationConnectionOutput[];
  /** Every active agent whose scope reaches any of them, once each, oldest agent first. */
  agents: IntegrationAgentOutput[];
  /**
   * Every tool the integration offers the person (GRA-345): their tools of the vendor with a
   * current version, and the stock tools of it they hold no tool of the name of. The count of what
   * the integration's tools read lists (GRA-293).
   */
  toolCount: number;
  /**
   * Of those, the ones in the person's toolbox: every tool of theirs with a current version. A
   * stock tool enters the toolbox when it is first reached for (ADR 0025), so this is the tools
   * used at least once, plus the ones an agent wrote, which exist because an agent asked for them.
   */
  inUseToolCount: number;
  /** The last call by any of the person's agents, by `GET /connections/:id/usage`'s rule; null when never. */
  lastUsedAt: Date | null;
  /** Null when every connection is connected; otherwise the worst one's reason and id. */
  needsAttention: { reason: IntegrationAttentionReason; connectionId: string } | null;
};

/**
 * Worst first: a vendor that refused the consent (the person is signed out), a consent never
 * finished, a credential never entered, then a provider the deployment stopped enabling, which is
 * the operator's to fix and not the person's.
 */
const ATTENTION_ORDER: readonly IntegrationAttentionReason[] = [
  "consent_required",
  "awaiting_consent",
  "awaiting_credential",
  "provider_unavailable",
];

export function worstAttention(
  connections: readonly IntegrationConnectionOutput[],
): IntegrationOutput["needsAttention"] {
  let worst: IntegrationOutput["needsAttention"] = null;
  for (const connection of connections) {
    if (connection.state === "connected") continue;
    if (
      worst === null ||
      ATTENTION_ORDER.indexOf(connection.state) < ATTENTION_ORDER.indexOf(worst.reason)
    ) {
      worst = { reason: connection.state, connectionId: connection.id };
    }
  }
  return worst;
}

/**
 * Four statements whatever the person holds: the connections, the agent reach, the tool counts and
 * the last call per vendor. Both tool counts come from one statement, so a stock tool copied in
 * mid-read is counted once, as in use or as offered stock, never twice or not at all (GRA-345).
 * Rows come in the order of each vendor's oldest connection; the console sorts. `executeToolName` is `@graft/mcp`'s, passed in as the usage route passes it, since a
 * connection's execute tool has no toolbox row and is matched by its wire name.
 */
export async function listIntegrations(
  ctx: ServiceContext,
  principal: Principal,
  input: { executeToolName: (connectionId: string) => string },
  deps: IntegrationDeps,
): Promise<IntegrationOutput[]> {
  const rows = (await deps.listConnections(ctx.db, principal.personId)).map(toConnectionOutput);
  // Every connection's execute tool, revoked ones included: a call made before the revoke was
  // still a call to the vendor, as the usage route counts it.
  const vendorOfToolName = new Map(rows.map((row) => [input.executeToolName(row.id), row.vendor]));
  const [reach, toolCounts, lastUsed] = await Promise.all([
    deps.listActiveAgentReach(ctx.db, principal.personId),
    deps.countToolsByVendor(ctx.db, principal.personId),
    deps.lastUsedAtByVendor(ctx.db, principal.personId, {
      toolNames: [...vendorOfToolName.keys()],
    }),
  ]);

  const byVendor = new Map<string, IntegrationConnectionOutput[]>();
  const vendorOfConnection = new Map<string, string>();
  for (const row of rows) {
    const state = connectionStateOf(row, deps.providers);
    if (state === "revoked") continue;
    const connections = byVendor.get(row.vendor) ?? [];
    connections.push({ ...row, state });
    byVendor.set(row.vendor, connections);
    vendorOfConnection.set(row.id, row.vendor);
  }

  // The reach is in agent order, so the first pair naming an agent places it.
  const agentsOf = new Map<string, Map<string, IntegrationAgentOutput>>();
  for (const pair of reach) {
    const vendor = vendorOfConnection.get(pair.connectionId);
    if (!vendor) continue;
    const agents = agentsOf.get(vendor) ?? new Map<string, IntegrationAgentOutput>();
    if (!agents.has(pair.agentId)) {
      agents.set(pair.agentId, {
        id: pair.agentId,
        name: pair.agentName,
        harness: pair.connectedViaClientName,
      });
    }
    agentsOf.set(vendor, agents);
  }

  const toolCountOf = new Map(toolCounts.map((row) => [row.vendor, row]));
  const lastUsedOf = new Map<string, Date>();
  for (const row of lastUsed) {
    const vendor = row.vendor ?? (row.toolName ? vendorOfToolName.get(row.toolName) : undefined);
    if (!vendor) continue;
    const seen = lastUsedOf.get(vendor);
    if (!seen || row.lastUsedAt > seen) lastUsedOf.set(vendor, row.lastUsedAt);
  }

  return [...byVendor].map(([vendor, connections]) => ({
    vendor,
    displayName: connections[0]?.displayName ?? vendor,
    connections,
    agents: [...(agentsOf.get(vendor)?.values() ?? [])],
    toolCount: toolCountOf.get(vendor)?.offered ?? 0,
    inUseToolCount: toolCountOf.get(vendor)?.inUse ?? 0,
    lastUsedAt: lastUsedOf.get(vendor) ?? null,
    needsAttention: worstAttention(connections),
  }));
}
