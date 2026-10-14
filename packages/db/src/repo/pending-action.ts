import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { connection } from "../schema/connection";
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

/**
 * Serialise "find the open ask for this key, or make one" across concurrent calls of one agent: a
 * transaction-scoped advisory lock on the hash of `agent:kind:key`, released with the transaction,
 * so two identical `request_connection` calls that both find no open ask cannot both insert one
 * (Greptile on #87, GRA-104). Only meaningful inside a transaction that also runs the lookup and the
 * insert; the table has no uniqueness constraint over the payload, and this stands in for one
 * without a migration. `hashtext` folds the key to an `int4`; a collision between two keys costs a
 * needless wait, never a wrong answer.
 */
export async function lockPendingActionKey(
  db: DbOrTx,
  scope: AgentScope,
  kind: string,
  key: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${scope.agentId}:${kind}:${key}`}))`,
  );
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
 * One suggestion's row (`listSuggestedConnectionAsks`): the latest connection ask of a vendor, the
 * agent that made it, and the three clocks the caller reads its state from. The payload's
 * `displayName` and `docsUrl` come out of the JSON; nothing else of it does.
 */
export type SuggestedConnectionAskRow = {
  id: string;
  agentId: string;
  agentName: string;
  vendor: string;
  displayName: string | null;
  docsUrl: string | null;
  createdAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
  consumedAt: Date | null;
};

/**
 * "Your agents asked for these" (ADR 0001 as amended 2026-10-14): per vendor, the newest `connection`
 * ask any of the person's live agents made, kept when it was not answered with a connection (so it
 * is open, declined or expired) and the person holds no unrevoked connection of that vendor; newest
 * first, at most `limit`. One statement under the person on both tables: the ask through
 * `agent.person_id`, the connection through its own `person_id`. The newest ask decides alone, so a
 * vendor the person connected from an agent's ask and later revoked is not suggested again from an
 * older one. The vendor is read off the payload, as `request_connection` wrote it.
 */
export async function listSuggestedConnectionAsks(
  db: DbOrTx,
  personId: string,
  limit: number,
): Promise<SuggestedConnectionAskRow[]> {
  const vendor = sql<string>`${pendingAction.payload} ->> 'vendor'`;
  const latest = db
    .selectDistinctOn([vendor], {
      id: pendingAction.id,
      agentId: pendingAction.agentId,
      agentName: sql<string>`${agent.name}`.as("agent_name"),
      vendor: vendor.as("vendor"),
      displayName: sql<string | null>`${pendingAction.payload} ->> 'displayName'`.as(
        "display_name",
      ),
      docsUrl: sql<string | null>`${pendingAction.payload} ->> 'docsUrl'`.as("docs_url"),
      answeredWith: sql<string | null>`${pendingAction.answer} ->> 'connectionId'`.as(
        "answered_with",
      ),
      createdAt: pendingAction.createdAt,
      expiresAt: pendingAction.expiresAt,
      answeredAt: pendingAction.answeredAt,
      consumedAt: pendingAction.consumedAt,
    })
    .from(pendingAction)
    .innerJoin(agent, eq(agent.id, pendingAction.agentId))
    .where(
      and(
        eq(agent.personId, personId),
        isNull(agent.revokedAt),
        eq(pendingAction.kind, "connection"),
        sql`${vendor} is not null`,
        notExists(
          db
            .select({ id: connection.id })
            .from(connection)
            .where(
              and(
                eq(connection.personId, personId),
                eq(connection.vendor, vendor),
                isNull(connection.revokedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(vendor, desc(pendingAction.createdAt), desc(pendingAction.id))
    .as("latest");
  const rows = await db
    .select()
    .from(latest)
    .where(isNull(latest.answeredWith))
    .orderBy(desc(latest.createdAt), desc(latest.id))
    .limit(limit);
  return rows.map(({ answeredWith: _, ...row }) => row);
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
 * The ask's payload rewritten while it is still open (GRA-147): the provider-link fallback moves a
 * connection ask from a link provider onto the keyring when the provider could not start its link,
 * so the same row — same id, same handoff URL, same agent — is answered by Graft's own form. Open
 * and in time in the predicate, as an answer is; null is "nothing to rewrite".
 */
export async function updatePendingActionPayload(
  db: DbOrTx,
  personId: string,
  id: string,
  args: {
    payload: Record<string, unknown>;
    now: Date;
    /**
     * Optimistic concurrency: the write lands only while the row still names this provider and has
     * not been written since the caller read it — two doors starting the same ask at once (the
     * console's button and the chat card) cannot have the failing one rewrite what the succeeding
     * one just recorded. Null is "someone else wrote first".
     */
    expect: { provider: string; updatedAt: Date };
  },
): Promise<PendingActionRow | null> {
  const [row] = await db
    .update(pendingAction)
    .set({ payload: args.payload, updatedAt: args.now })
    .where(
      and(
        eq(pendingAction.id, id),
        inArray(pendingAction.agentId, personAgentIds(db, personId)),
        isNull(pendingAction.answeredAt),
        gt(pendingAction.expiresAt, args.now),
        eq(pendingAction.updatedAt, args.expect.updatedAt),
        sql`${pendingAction.payload} ->> 'provider' = ${args.expect.provider}`,
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

/**
 * The open `tool` asks about one tool for one agent: unanswered, untaken and in time, in id order
 * (GRA-302). Read twice by an answer set from the console: once plain, for the connections the asks
 * name, which it locks first as answering an ask does (`recordApprovalAnswer`), and once with
 * `forUpdate` after those locks and before the tool row's, which is that path's order (connection,
 * action, tool), so the two cannot deadlock. The tool is matched on the payload, as
 * `settleAnsweredToolActions` matches it.
 */
export async function listOpenToolActions(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
  at: Date,
  options: { forUpdate?: boolean } = {},
): Promise<PendingActionRow[]> {
  const query = db
    .select()
    .from(pendingAction)
    .where(
      and(
        inArray(pendingAction.agentId, scopedAgentIds(db, scope)),
        eq(pendingAction.kind, "tool"),
        sql`${pendingAction.payload} ->> 'toolId' = ${toolId}`,
        isNull(pendingAction.answeredAt),
        isNull(pendingAction.consumedAt),
        gt(pendingAction.expiresAt, at),
      ),
    )
    .orderBy(pendingAction.id);
  return options.forUpdate ? query.for("update") : query;
}

/**
 * Answer the named open `tool` asks of one agent with the answer the console just set outright,
 * and mark each taken (ADR 0008 as amended 2026-10-14; GRA-302). The standing row now carries the
 * answer in full, so the ask is answered and spent at once, as `recordApprovalAnswer` spends an
 * answer the row carries: the inbox no longer offers an answer already given, and a call still
 * waiting on the ask reads it as taken and judges the rule again. Only `ids`, the rows the caller
 * locked (`listOpenToolActions`), so the statement takes no row lock out of order; open and in
 * time in the predicate, as an answer is.
 */
export async function answerOpenToolActions(
  db: DbOrTx,
  scope: AgentScope,
  args: { ids: readonly string[]; answer: Record<string, unknown>; at: Date },
): Promise<PendingActionRow[]> {
  if (args.ids.length === 0) return [];
  return db
    .update(pendingAction)
    .set({ answer: args.answer, answeredAt: args.at, consumedAt: args.at })
    .where(
      and(
        inArray(pendingAction.id, [...args.ids]),
        inArray(pendingAction.agentId, scopedAgentIds(db, scope)),
        eq(pendingAction.kind, "tool"),
        isNull(pendingAction.answeredAt),
        isNull(pendingAction.consumedAt),
        gt(pendingAction.expiresAt, args.at),
      ),
    )
    .returning();
}
