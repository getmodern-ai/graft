import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent, agentConnection, type NewAgent } from "../schema/agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the agent aggregate: the agent row and its scope (ADR 0007). Every read and
 * write takes the person's id in the SQL; the token lookup and the sweep's roster are the two
 * deliberate exceptions, and each says why.
 */

export type AgentRow = typeof agent.$inferSelect;
export type AgentPatch = Partial<Pick<AgentRow, "name" | "workingSetCap" | "idleWindowDays">>;

/** The MCP client an agent was connected from (ADR 0018) — written once, at the consent that bound them. */
export type AgentConnectedVia = { clientId: string; clientName: string };

/**
 * The agent ids an `AgentScope` names — one, when the agent is the person's, none otherwise. Every
 * agent-scoped repo (`working-set`, `approval`, `pending-action`, `acquire-job`, `usage`) puts
 * this in its `WHERE` as `agent_id IN (...)`, which is how a table carrying only `agent_id` still
 * takes both ids of the scope in the statement (`repo/scope.ts`). A revoked agent is still its
 * person's: the console reads its history, and `requireAgent` is what refuses its token.
 */
export function scopedAgentIds(db: DbOrTx, scope: AgentScope) {
  return db
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.id, scope.agentId), eq(agent.personId, scope.personId)));
}

export async function insertAgent(db: DbOrTx, input: NewAgent): Promise<AgentRow> {
  const [row] = await db.insert(agent).values(input).returning();
  if (!row) throw new Error("Insert of agent returned no row");
  return row;
}

/**
 * The bearer token's agent, by the hash of the token — unscoped by nature, because the token *is*
 * the scope: nothing else identifies the caller of an MCP request. A revoked agent answers null
 * here, in the statement, so a revoked token and an unknown one are the same refusal and the
 * service never holds a revoked row it might forget to check.
 */
export async function findAgentByTokenHash(
  db: DbOrTx,
  tokenHash: string,
): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.tokenHash, tokenHash), isNull(agent.revokedAt)))
    .limit(1);
  return row ?? null;
}

export async function findAgent(
  db: DbOrTx,
  personId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.personId, personId)))
    .limit(1);
  return row ?? null;
}

/** Every agent of a person, revoked ones included, oldest first. */
export async function listAgents(db: DbOrTx, personId: string): Promise<AgentRow[]> {
  return db
    .select()
    .from(agent)
    .where(eq(agent.personId, personId))
    .orderBy(asc(agent.createdAt), asc(agent.id));
}

/**
 * Every agent whose token still resolves, across every person, oldest first — the sweep's roster
 * (ADR 0009). Unscoped by nature, like the token lookup: the sweep is the system's own pass and has
 * no person to scope by. It answers agent rows and nothing of theirs, so what the sweep does next —
 * the working-set read, each demotion — is a statement under that agent's own pair, exactly as the
 * agent's own call would be (`repo/working-set.ts`).
 */
export async function listAllActiveAgents(db: DbOrTx): Promise<AgentRow[]> {
  return db
    .select()
    .from(agent)
    .where(isNull(agent.revokedAt))
    .orderBy(asc(agent.createdAt), asc(agent.id));
}

export async function updateAgent(
  db: DbOrTx,
  personId: string,
  agentId: string,
  patch: AgentPatch,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agent)
    .set(patch)
    .where(and(eq(agent.id, agentId), eq(agent.personId, personId)))
    .returning();
  return row ?? null;
}

/**
 * Record which MCP client an existing agent was connected from, when the consent named an agent the
 * person already had (ADR 0018). `connected_via_client_id IS NULL` in the predicate keeps the first
 * client: an agent minted by one client and later lent to another keeps saying where it came from,
 * and the tokens in `mcp_token` say who holds it now.
 */
export async function setAgentConnectedVia(
  db: DbOrTx,
  personId: string,
  agentId: string,
  via: AgentConnectedVia,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agent)
    .set({ connectedViaClientId: via.clientId, connectedViaClientName: via.clientName })
    .where(
      and(eq(agent.id, agentId), eq(agent.personId, personId), isNull(agent.connectedViaClientId)),
    )
    .returning();
  return row ?? null;
}

/**
 * Revoke: the row stays, the token stops resolving. `revoked_at IS NULL` in the predicate makes a
 * second revoke match nothing rather than moving the timestamp, so the recorded moment is the
 * first one.
 */
export async function revokeAgent(
  db: DbOrTx,
  personId: string,
  agentId: string,
  at: Date,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agent)
    .set({ revokedAt: at })
    .where(and(eq(agent.id, agentId), eq(agent.personId, personId), isNull(agent.revokedAt)))
    .returning();
  return row ?? null;
}

/** The connection ids in an agent's scope. */
export async function listAgentConnectionIds(db: DbOrTx, scope: AgentScope): Promise<string[]> {
  const rows = await db
    .select({ connectionId: agentConnection.connectionId })
    .from(agentConnection)
    .where(inArray(agentConnection.agentId, scopedAgentIds(db, scope)))
    .orderBy(asc(agentConnection.connectionId));
  return rows.map((row) => row.connectionId);
}

/**
 * The person's agents whose scope names a connection: the lists a revoke of it changes, since each
 * loses the connection's execute tool (GRA-69). Under the person through the agent, so a grant to
 * another person's agent, which the service never writes, would not be answered either.
 */
export async function listAgentIdsForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: agentConnection.agentId })
    .from(agentConnection)
    .where(
      and(
        eq(agentConnection.connectionId, connectionId),
        inArray(
          agentConnection.agentId,
          db.select({ id: agent.id }).from(agent).where(eq(agent.personId, personId)),
        ),
      ),
    )
    .orderBy(asc(agentConnection.agentId));
  return rows.map((row) => row.agentId);
}

/**
 * Add one connection to the scope, idempotently: `INSERT … ON CONFLICT DO NOTHING` on the table's
 * `(agent_id, connection_id)` primary key, so two grants of the same connection leave one row and a
 * grant beside another agent-page edit loses nothing — never a read of the list and a rewrite of the
 * whole (Greptile on #87, GRA-104). One statement on `scope.agentId` alone, like the insert half of
 * `replaceAgentConnections`: the service has verified the agent is the person's and the connection
 * theirs before calling this.
 */
export async function addAgentConnection(
  db: DbOrTx,
  scope: AgentScope,
  connectionId: string,
): Promise<void> {
  await db
    .insert(agentConnection)
    .values({ agentId: scope.agentId, connectionId })
    .onConflictDoNothing();
}

/**
 * Replace the scope wholesale: delete what is there, insert what was given. Two statements, so the
 * caller runs it in a transaction; the delete is scoped by the pair, so a mis-scoped call clears
 * nothing and the insert that follows it lands only on an agent the caller has already verified is
 * the person's — the service checks ownership of the connections before calling this.
 */
export async function replaceAgentConnections(
  db: DbOrTx,
  scope: AgentScope,
  connectionIds: readonly string[],
): Promise<void> {
  await db
    .delete(agentConnection)
    .where(inArray(agentConnection.agentId, scopedAgentIds(db, scope)));
  if (connectionIds.length === 0) return;
  await db
    .insert(agentConnection)
    .values(connectionIds.map((connectionId) => ({ agentId: scope.agentId, connectionId })));
}
