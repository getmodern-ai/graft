import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import {
  acquireAttempt,
  acquireJob,
  acquireTrace,
  type NewAcquireAttemptRow,
  type NewAcquireJobRow,
  type NewAcquireTraceRow,
} from "../schema/acquire-job";
import { agent } from "../schema/agent";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for `acquire` jobs, their attempts and their traces (CONTEXT.md, *Acquire*;
 * ADR 0012 for why every line is kept). Agent-scoped through `scopedAgentIds`: `acquire_status`
 * answers for the agent that asked, and the loop's writes land under the same pair. Two statements
 * are unscoped by nature and say so — the runner's roster and its claim — because the runner is the
 * system's own pass over every agent's queue and has no person to scope by; each answers the
 * person beside the row, so everything the runner does next is a statement under that agent's pair.
 */

export type AcquireJobRow = typeof acquireJob.$inferSelect;
export type AcquireJobPatch = Partial<
  Pick<
    AcquireJobRow,
    "status" | "attempts" | "tokenSpend" | "result" | "traceRef" | "finishedAt" | "toolId"
  >
>;
export type AcquireAttemptRow = typeof acquireAttempt.$inferSelect;
export type AcquireAttemptPatch = Partial<
  Pick<
    AcquireAttemptRow,
    | "checkOutput"
    | "versionId"
    | "diagnosis"
    | "outcome"
    | "inputTokens"
    | "outputTokens"
    | "finishedAt"
  >
>;
export type AcquireTraceRow = typeof acquireTrace.$inferSelect;

/** A job as the runner takes it: the row and the person the agent belongs to, for the scope. */
export type RunnableAcquireJob = { job: AcquireJobRow; personId: string };

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

/** Tokens alone — one model turn's cost, counted as it happens so the ceiling reads the database. */
export async function addAcquireJobTokenSpend(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  tokens: number,
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set({ tokenSpend: sql`${acquireJob.tokenSpend} + ${tokens}` })
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

/** The runner saying it is still on the job; the claim below reads this back. */
export async function heartbeatAcquireJob(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  at: Date,
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set({ heartbeatAt: at })
    .where(and(eq(acquireJob.id, id), inArray(acquireJob.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}

/** Queued, or running with a heartbeat older than `staleBefore` (or none at all) — what a runner may take. */
function runnable(staleBefore: Date) {
  return or(
    eq(acquireJob.status, "queued"),
    and(
      eq(acquireJob.status, "running"),
      or(isNull(acquireJob.heartbeatAt), lt(acquireJob.heartbeatAt, staleBefore)),
    ),
  );
}

/**
 * The runner's roster — **unscoped by nature**, like the sweep's (`listAllActiveAgents`): every
 * person's queued jobs, and the running ones whose runner has stopped stamping them, oldest first.
 * Joined to the agent for the person, so what the runner does next is under the pair. A job of a
 * revoked agent is still listed: it was asked for while the token stood, and finishing it — or
 * failing it with a clear result — is better than a row that says `running` for ever.
 */
export async function listRunnableAcquireJobs(
  db: DbOrTx,
  args: { staleBefore: Date; limit: number },
): Promise<RunnableAcquireJob[]> {
  const rows = await db
    .select({ job: acquireJob, personId: agent.personId })
    .from(acquireJob)
    .innerJoin(agent, eq(agent.id, acquireJob.agentId))
    .where(runnable(args.staleBefore))
    .orderBy(asc(acquireJob.createdAt), asc(acquireJob.id))
    .limit(args.limit);
  return rows;
}

/**
 * Take one job: the runnable predicate again, in the same statement as the write, so two runners
 * that both listed it cannot both claim it — the second's update matches nothing and answers null.
 * Unscoped for the roster's reason; the row that comes back carries the agent, and the person came
 * with the roster.
 */
export async function claimAcquireJob(
  db: DbOrTx,
  id: string,
  args: { now: Date; staleBefore: Date },
): Promise<AcquireJobRow | null> {
  const [row] = await db
    .update(acquireJob)
    .set({
      status: "running",
      startedAt: sql`coalesce(${acquireJob.startedAt}, ${args.now})`,
      heartbeatAt: args.now,
    })
    .where(and(eq(acquireJob.id, id), runnable(args.staleBefore)))
    .returning();
  return row ?? null;
}

export async function insertAcquireAttempt(
  db: DbOrTx,
  input: NewAcquireAttemptRow,
): Promise<AcquireAttemptRow> {
  const [row] = await db.insert(acquireAttempt).values(input).returning();
  if (!row) throw new Error("Insert of acquire attempt returned no row");
  return row;
}

export async function updateAcquireAttempt(
  db: DbOrTx,
  scope: AgentScope,
  id: string,
  patch: AcquireAttemptPatch,
): Promise<AcquireAttemptRow | null> {
  const [row] = await db
    .update(acquireAttempt)
    .set(patch)
    .where(
      and(eq(acquireAttempt.id, id), inArray(acquireAttempt.agentId, scopedAgentIds(db, scope))),
    )
    .returning();
  return row ?? null;
}

/** A job's attempts, first to last. */
export async function listAcquireAttempts(
  db: DbOrTx,
  scope: AgentScope,
  jobId: string,
): Promise<AcquireAttemptRow[]> {
  return db
    .select()
    .from(acquireAttempt)
    .where(
      and(
        eq(acquireAttempt.jobId, jobId),
        inArray(acquireAttempt.agentId, scopedAgentIds(db, scope)),
      ),
    )
    .orderBy(asc(acquireAttempt.attemptNumber));
}

/**
 * One trace line, numbered in the statement — `max(sequence) + 1` over the job's lines — so a job
 * resumed by another runner continues the count rather than restarting it, and the unique pair
 * refuses a duplicate rather than storing two lines that both claim to be third.
 */
export async function insertAcquireTrace(
  db: DbOrTx,
  input: Omit<NewAcquireTraceRow, "sequence">,
): Promise<AcquireTraceRow> {
  const [row] = await db
    .insert(acquireTrace)
    .values({
      ...input,
      sequence: sql<number>`(select coalesce(max(${acquireTrace.sequence}), 0) + 1 from ${acquireTrace} where ${acquireTrace.jobId} = ${input.jobId})`,
    })
    .returning();
  if (!row) throw new Error("Insert of acquire trace returned no row");
  return row;
}

/** A job's trace, in order, up to `limit` lines. */
export async function listAcquireTraces(
  db: DbOrTx,
  scope: AgentScope,
  jobId: string,
  limit: number,
): Promise<AcquireTraceRow[]> {
  return db
    .select()
    .from(acquireTrace)
    .where(
      and(eq(acquireTrace.jobId, jobId), inArray(acquireTrace.agentId, scopedAgentIds(db, scope))),
    )
    .orderBy(asc(acquireTrace.sequence))
    .limit(limit);
}
