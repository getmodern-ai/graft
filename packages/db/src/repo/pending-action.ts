import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";

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
