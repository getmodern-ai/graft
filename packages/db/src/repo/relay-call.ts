import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { relayCallCount } from "../schema/relay-call";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the relay budget's count (GRA-349). The daily read names the person in its
 * predicate (ADR 0007), the write carries both ids of the scope the proxy verified off the
 * capability token, and the prune is the sweep's, unscoped by nature and pinned by name in
 * `repo/scope.test.ts` beside the other rosters.
 */

export type RelayCallBucketRow = { agentId: string; hourStart: Date; calls: number };

/**
 * Every hour of this person's relayed calls from `since` on, across their agents, in one
 * statement: what the budget judges a call against (`@graft/core`'s `judgeRelayBudget`).
 */
export async function listRelayCallBuckets(
  db: DbOrTx,
  personId: string,
  since: Date,
): Promise<RelayCallBucketRow[]> {
  return db
    .select({
      agentId: relayCallCount.agentId,
      hourStart: relayCallCount.hourStart,
      calls: relayCallCount.calls,
    })
    .from(relayCallCount)
    .where(and(eq(relayCallCount.personId, personId), gte(relayCallCount.hourStart, since)))
    .orderBy(asc(relayCallCount.hourStart));
}

/**
 * Count one relayed call in the agent's hour: the row made at one, or incremented in place, in one
 * statement, so two calls landing together both count.
 */
export async function recordRelayCall(
  db: DbOrTx,
  scope: AgentScope,
  hourStart: Date,
): Promise<void> {
  await db
    .insert(relayCallCount)
    .values({ agentId: scope.agentId, personId: scope.personId, hourStart, calls: 1 })
    .onConflictDoUpdate({
      target: [relayCallCount.agentId, relayCallCount.hourStart],
      set: { calls: sql`${relayCallCount.calls} + 1`, updatedAt: sql`now()` },
    });
}

/**
 * Delete every hour older than `before`, whoever's: the sweep's prune, unscoped by nature. Answers
 * how many rows went.
 */
export async function deleteRelayCallCountsBefore(db: DbOrTx, before: Date): Promise<number> {
  const deleted = await db
    .delete(relayCallCount)
    .where(lt(relayCallCount.hourStart, before))
    .returning({ agentId: relayCallCount.agentId });
  return deleted.length;
}
