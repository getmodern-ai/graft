import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { type NewPendingActionRow, pendingAction } from "../schema/pending-action";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for pending actions (ADR 0006). Two readers, two scopes: the waiting meta-tool
 * holds an `AgentScope` and reads its own agent's actions; the console holds a person and answers
 * any of their agents' — the person-scoped statements go through `agent.person_id`.
 */

export type PendingActionRow = typeof pendingAction.$inferSelect;

/** The agent ids a person owns — the person-scoped statements' subquery. */
function personAgentIds(db: DbOrTx, personId: string) {
  return db.select({ id: agent.id }).from(agent).where(eq(agent.personId, personId));
}

export async function insertPendingAction(
  db: DbOrTx,
  input: NewPendingActionRow,
): Promise<PendingActionRow> {
  const [row] = await db.insert(pendingAction).values(input).returning();
  if (!row) throw new Error("Insert of pending action returned no row");
  return row;
}

export async function findPendingAction(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
): Promise<PendingActionRow | null> {
  const [row] = await db
    .select()
    .from(pendingAction)
    .where(and(eq(pendingAction.id, id), inArray(pendingAction.agentId, scopedAgentIds(db, scope))))
    .limit(1);
  return row ?? null;
}

export async function findPendingActionForPerson(
  db: DbOrTx,
  personId: string,
  id: string,
): Promise<PendingActionRow | null> {
  const [row] = await db
    .select()
    .from(pendingAction)
    .where(
      and(eq(pendingAction.id, id), inArray(pendingAction.agentId, personAgentIds(db, personId))),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The console's list: the person's unanswered actions that have not yet expired, newest first.
 * `now` is a parameter so the statement and the caller agree on the clock.
 */
export async function listOpenPendingActions(
  db: DbOrTx,
  personId: string,
  now: Date,
): Promise<PendingActionRow[]> {
  return db
    .select()
    .from(pendingAction)
    .where(
      and(
        inArray(pendingAction.agentId, personAgentIds(db, personId)),
        isNull(pendingAction.answeredAt),
        gt(pendingAction.expiresAt, now),
      ),
    )
    .orderBy(desc(pendingAction.createdAt), desc(pendingAction.id));
}

/**
 * The person's answer. The statement refuses an action already answered and one past its expiry
 * — both predicates in the SQL, so an answer that arrives late lands nowhere rather than on a call
 * that has already returned its refusal. Null is "nothing to answer": unknown, not theirs,
 * answered, or expired, which the service reports as one refusal.
 */
export async function answerPendingAction(
  db: DbOrTx,
  personId: string,
  id: string,
  args: { answer: Record<string, unknown>; answeredAt: Date },
): Promise<PendingActionRow | null> {
  const [row] = await db
    .update(pendingAction)
    .set({ answer: args.answer, answeredAt: args.answeredAt })
    .where(
      and(
        eq(pendingAction.id, id),
        inArray(pendingAction.agentId, personAgentIds(db, personId)),
        isNull(pendingAction.answeredAt),
        gt(pendingAction.expiresAt, args.answeredAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The waiting tool takes the answer, once: answered and not yet consumed, in the predicate, so two
 * pollers cannot both act on one yes. Null is "no answer to take yet", or already taken.
 */
export async function consumePendingAction(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  consumedAt: Date,
): Promise<PendingActionRow | null> {
  const [row] = await db
    .update(pendingAction)
    .set({ consumedAt })
    .where(
      and(
        eq(pendingAction.id, id),
        inArray(pendingAction.agentId, scopedAgentIds(db, scope)),
        isNotNull(pendingAction.answeredAt),
        isNull(pendingAction.consumedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The agent's actions of one kind that a waiting meta-tool may still act on: unconsumed and not yet
 * expired, answered or not, newest first. This is how a call finds the action a previous call left
 * behind — answered while the agent was away, or still open — rather than creating a second one for
 * the same ask (ADR 0006: the record is durable so the person can answer hours later; GRA-23 is
 * where a later identical call takes that answer). The target inside `payload` is the caller's to
 * match; this statement narrows by kind and leaves the JSON unread, as the table's header says.
 */
export async function listPendingActionsByKind(
  db: DbOrTx,
  scope: AgentScope,
  kind: string,
  now: Date,
): Promise<PendingActionRow[]> {
  return db
    .select()
    .from(pendingAction)
    .where(
      and(
        inArray(pendingAction.agentId, scopedAgentIds(db, scope)),
        eq(pendingAction.kind, kind),
        isNull(pendingAction.consumedAt),
        gt(pendingAction.expiresAt, now),
      ),
    )
    .orderBy(desc(pendingAction.createdAt), desc(pendingAction.id));
}

/**
 * A revoke's third sweep (ADR 0007): every open ask about the connection, across every agent of
 * the person — a tool's ask, a build ask, a credential re-entry — closed in one statement, under the
 * person through the agent's owner like the other person-scoped statements here. Found by the
 * `connection_id` column, never by the payload, as the table's header says.
 *
 * Both clocks are stamped, because the two doors read different predicates. `expires_at` is what
 * the console's answer and its list read, so the person can no longer answer a closed ask; but the
 * take (`consumePendingAction`) reads no clock at all — an answer may be taken after its expiry,
 * which is the whole point of a durable record (ADR 0006) — so a per-call yes already given would
 * still be grantable after reconnection unless `consumed_at` is stamped too (GRA-23's known edge,
 * closed by GRA-28). A closed ask therefore reads as expired to the console and as taken to the
 * agent; the next call asks afresh, which after a revoke is right.
 */
export async function expirePendingActionsForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
  at: Date,
): Promise<PendingActionRow[]> {
  return db
    .update(pendingAction)
    .set({ expiresAt: at, consumedAt: at })
    .where(
      and(
        eq(pendingAction.connectionId, connectionId),
        inArray(pendingAction.agentId, personAgentIds(db, personId)),
        isNull(pendingAction.consumedAt),
        gt(pendingAction.expiresAt, at),
      ),
    )
    .returning();
}

/**
 * Spend every answered, untaken `tool` ask about one tool for one agent (ADR 0008, amendment of
 * 2026-09-15). A yes given while the tool was set to ask every time waits, answered and unconsumed,
 * for the agent's next call; when the console then changes the state it was given under — the
 * setting, or the row itself on a withdraw — that yes is stamped taken here, so no later call finds
 * it and applies it as if just said. `consumed_at` alone: that is the predicate the agent's lookup
 * (`listPendingActionsByKind`) and the take (`consumePendingAction`) both read, and the console's
 * card then says the answer was taken, which for the person's purposes it was. The tool is matched
 * on the payload because a tool ask names its tool there and nowhere else (the table's header);
 * the row's scope stays the agent's, as every agent-scoped write here does (ADR 0007).
 */
export async function settleAnsweredToolActions(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
  consumedAt: Date,
): Promise<PendingActionRow[]> {
  return db
    .update(pendingAction)
    .set({ consumedAt })
    .where(
      and(
        inArray(pendingAction.agentId, scopedAgentIds(db, scope)),
        eq(pendingAction.kind, "tool"),
        sql`${pendingAction.payload} ->> 'toolId' = ${toolId}`,
        isNotNull(pendingAction.answeredAt),
        isNull(pendingAction.consumedAt),
      ),
    )
    .returning();
}
