import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent, agentConnection, type NewAgent } from "../schema/agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the agent aggregate: the agent row and its scope (ADR 0007). Every read and
 * write takes the person's id in the SQL; the token lookup is the one deliberate exception, and
 * says so.
 */

export type AgentRow = typeof agent.$inferSelect;
export type AgentPatch = Partial<Pick<AgentRow, "name" | "workingSetCap" | "idleWindowDays">>;

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
