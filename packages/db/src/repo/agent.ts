import { and, asc, eq, exists, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent, agentConnection, type NewAgent } from "../schema/agent";
import { connection } from "../schema/connection";
import { workingSet } from "../schema/working-set";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the agent aggregate: the agent row and its scope (ADR 0007). Every read and
 * write takes the person's id in the SQL; the token lookup, the sweep's roster and the blob pass's
 * read of whose a directory is (`listAgentPersonIds`) are the three deliberate exceptions, and
 * each says why.
 */

export type AgentRow = typeof agent.$inferSelect;
export type AgentListRow = AgentRow & { workingSetCount: number };
export type AgentPatch = Partial<
  Pick<AgentRow, "name" | "workingSetCap" | "idleWindowDays" | "scopeMode">
>;

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

/**
 * `findAgent` with the row locked (`SELECT … FOR UPDATE`): what a scope write reads first, so two
 * writes on one agent's scope serialise on the row — a narrowing that materialises the resolved
 * scope and a grant that decides "no list row, the agent is on `all`" cannot interleave, and the
 * list a narrowing writes is the scope as it stands when it commits (Greptile on #88). Only
 * meaningful inside a transaction; outside one the lock is released as the statement ends.
 */
export async function findAgentForUpdate(
  db: DbOrTx,
  personId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const [row] = await db
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.personId, personId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** Every agent of a person, revoked ones included, oldest first. */
export async function listAgents(db: DbOrTx, personId: string): Promise<AgentListRow[]> {
  return db
    .select({
      ...getTableColumns(agent),
      // The count follows the person-scoped agent in this statement (ADR 0007).
      workingSetCount: db.$count(workingSet, eq(workingSet.agentId, agent.id)),
    })
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

/** An agent's id and its person's, as `listAgentPersonIds` answers them. */
export type AgentPersonId = { agentId: string; personId: string };

/**
 * Whose agents these are: the person of every id in `agentIds` that names an agent row, revoked or
 * not. The blob pass's read for a directory the blob store lists under an agent that has no
 * unremoved row (GRA-195): a revoked agent whose blobs were all removed, or a run killed before
 * its row landed. **Deliberately unscoped**, and pinned by name in `scope.test.ts` beside the
 * roster above: the sweep has no person until this answers, and an id with no row here is an agent
 * deleted by hand, whose directories are nobody's. It answers the pair and nothing else of the row;
 * what the pass does next is a statement under that pair. No ids is no statement.
 */
export async function listAgentPersonIds(
  db: DbOrTx,
  agentIds: readonly string[],
): Promise<AgentPersonId[]> {
  if (agentIds.length === 0) return [];
  // One array parameter (`= any($1)`), not `in ($1, $2, ...)`: the list is every agent the store has
  // a directory for and no row, which is unbounded, and Postgres refuses a statement past its
  // parameter limit (Greptile on #152). `sql.param` hands the array to the driver whole; a bare
  // array in the template expands to `($1, $2, ...)`. The rendered form is pinned in `scope.test.ts`.
  return db
    .select({ agentId: agent.id, personId: agent.personId })
    .from(agent)
    .where(sql`${agent.id} = any(${sql.param([...agentIds])})`)
    .orderBy(asc(agent.id));
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

/**
 * The rows in `agent_connection` for an agent — its **list**, which is its whole scope under
 * `listed` and nothing under `all` (ADR 0007 as amended 2026-09-19). The scope as a caller should
 * read it is `listScopeConnectionIds`; this is what the service edits when a list is set or grown.
 */
export async function listAgentConnectionIds(db: DbOrTx, scope: AgentScope): Promise<string[]> {
  const rows = await db
    .select({ connectionId: agentConnection.connectionId })
    .from(agentConnection)
    .where(inArray(agentConnection.agentId, scopedAgentIds(db, scope)))
    .orderBy(asc(agentConnection.connectionId));
  return rows.map((row) => row.connectionId);
}

/**
 * The **scope** resolved to connection ids, in one statement under the person, whatever the mode
 * (ADR 0007 as amended 2026-09-19): every connection of the person's when the agent named by the
 * pair is on `all`, and the connections its list names when it is on `listed`. Both branches take
 * the pair — the `all` branch as an `exists` over the agent row, the `listed` branch as
 * `scopedAgentIds` — so an agent that is not the person's answers nothing under either. Revoked
 * rows are in the set on both branches: a listed grant survives a revoke on purpose (GRA-69, so a
 * reconnection needs no second step), and `all` says "every connection of theirs"; each caller
 * that must not use a revoked row already checks `revoked_at` on the row it holds.
 */
export async function listScopeConnectionIds(db: DbOrTx, scope: AgentScope): Promise<string[]> {
  const rows = await db
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.personId, scope.personId),
        or(
          exists(
            db
              .select({ id: agent.id })
              .from(agent)
              .where(
                and(
                  eq(agent.id, scope.agentId),
                  eq(agent.personId, scope.personId),
                  eq(agent.scopeMode, "all"),
                ),
              ),
          ),
          inArray(
            connection.id,
            db
              .select({ connectionId: agentConnection.connectionId })
              .from(agentConnection)
              .where(inArray(agentConnection.agentId, scopedAgentIds(db, scope))),
          ),
        ),
      ),
    )
    .orderBy(asc(connection.id));
  return rows.map((row) => row.id);
}

/**
 * The person's agents whose scope reaches a connection: the lists a revoke of it changes, since
 * each loses the connection's execute tool (GRA-69) — every agent on `all`, and every agent whose
 * list names the row (ADR 0007 as amended 2026-09-19). Under the person in the statement, so a
 * grant to another person's agent, which the service never writes, would not be answered either.
 */
export async function listAgentIdsForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: agent.id })
    .from(agent)
    .where(
      and(
        eq(agent.personId, personId),
        or(
          eq(agent.scopeMode, "all"),
          inArray(
            agent.id,
            db
              .select({ agentId: agentConnection.agentId })
              .from(agentConnection)
              .where(eq(agentConnection.connectionId, connectionId)),
          ),
        ),
      ),
    )
    .orderBy(asc(agent.id));
  return rows.map((row) => row.id);
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
