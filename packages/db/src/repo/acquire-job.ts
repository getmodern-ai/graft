import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { acquireJob, type NewAcquireJobRow } from "../schema/acquire-job";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for `acquire` jobs (CONTEXT.md, *Acquire*; ADR 0012 for why every line is kept).
 * Agent-scoped through `scopedAgentIds`: `acquire_status` answers for the agent that asked.
 */

export type AcquireJobRow = typeof acquireJob.$inferSelect;
export type AcquireJobPatch = Partial<
  Pick<AcquireJobRow, "status" | "attempts" | "tokenSpend" | "result" | "traceRef">
>;

export async function insertAcquireJob(
  db: DbOrTx,
  input: NewAcquireJobRow,
): Promise<AcquireJobRow> {
  const [row] = await db.insert(acquireJob).values(input).returning();
  if (!row) throw new Error("Insert of acquire job returned no row");
  return row;
}

export async function findAcquireJob(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .select()
    .from(acquireJob)
    .where(and(eq(acquireJob.id, id), inArray(acquireJob.agentId, scopedAgentIds(db, scope))))
    .limit(1);
  return row ?? null;
}

export async function listAcquireJobs(
  db: DbOrTx,
  scope: AgentScope,
  limit: number,
): Promise<AcquireJobRow[]> {
  return db
    .select()
    .from(acquireJob)
    .where(inArray(acquireJob.agentId, scopedAgentIds(db, scope)))
    .orderBy(desc(acquireJob.createdAt), desc(acquireJob.id))
    .limit(limit);
}

export async function updateAcquireJob(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  patch: AcquireJobPatch,
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set(patch)
    .where(and(eq(acquireJob.id, id), inArray(acquireJob.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}

/**
 * One more attempt and its token spend, incremented in the statement for the same reason
 * `appendAcquireJobProgress` concatenates there: two reports at once must both count.
 */
export async function recordAcquireJobAttempt(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  tokens: number,
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set({
      attempts: sql`${acquireJob.attempts} + 1`,
      tokenSpend: sql`${acquireJob.tokenSpend} + ${tokens}`,
    })
    .where(and(eq(acquireJob.id, id), inArray(acquireJob.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}

/**
 * Append progress lines in the database rather than read-modify-write, so two attempts reporting
 * at once cannot lose each other's lines. `jsonb || jsonb` concatenates arrays.
 */
export async function appendAcquireJobProgress(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  lines: readonly string[],
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set({ progress: sql`${acquireJob.progress} || ${JSON.stringify(lines)}::jsonb` })
    .where(and(eq(acquireJob.id, id), inArray(acquireJob.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}
