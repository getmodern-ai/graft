import type { AcquireJobRow } from "@graft/db/repo/acquire-job";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import type { AcquireJobDeps } from "./acquire-job.deps";

/**
 * `acquire` jobs (CONTEXT.md; ADR 0012): the rows the meta-tool creates and `acquire_status` reads,
 * and the writes the inner loop makes as it goes — progress lines, attempts, token spend, the
 * result. The loop itself is GRA-29's; this is its record.
 */

export const GOAL_MAX_LENGTH = 4000;

export async function createAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  input: { connectionId: string; goal: string; firstProgressLine?: string },
  deps: AcquireJobDeps,
): Promise<AcquireJobRow> {
  const goal = input.goal.trim();
  if (goal.length === 0 || goal.length > GOAL_MAX_LENGTH) {
    throw new ServiceError("BAD_REQUEST", `A goal is 1 to ${GOAL_MAX_LENGTH} characters`);
  }
  orNotFound(
    await deps.findConnection(ctx.db, scope.personId, input.connectionId),
    "Connection not found",
  );
  return deps.insertAcquireJob(ctx.db, {
    id: deps.newId(),
    agentId: scope.agentId,
    connectionId: input.connectionId,
    goal,
    progress: input.firstProgressLine ? [input.firstProgressLine] : [],
  });
}

export async function getAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  return deps.findAcquireJob(ctx.db, scope, id);
}

export async function listAcquireJobs(
  ctx: ServiceContext,
  scope: AgentScope,
  limit: number,
  deps: AcquireJobDeps,
): Promise<AcquireJobRow[]> {
  return deps.listAcquireJobs(ctx.db, scope, limit);
}

/** A line the agent relays to the person (GRA-1, user story 31). */
export async function appendAcquireJobProgress(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  lines: readonly string[],
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  if (lines.length === 0) return deps.findAcquireJob(ctx.db, scope, id);
  return deps.appendAcquireJobProgress(ctx.db, scope, id, lines);
}

export async function startAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  return deps.updateAcquireJob(ctx.db, scope, id, { status: "running" });
}

/** One more attempt and its tokens, counted in the database so parallel reports cannot lose each other. */
export async function recordAcquireJobAttempt(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  tokens: number,
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new ServiceError("BAD_REQUEST", "Token spend is a whole number of tokens");
  }
  return deps.recordAcquireJobAttempt(ctx.db, scope, id, tokens);
}

/** The end: the published tool's identity, or the last diagnostics and what was tried. */
export async function completeAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  outcome: {
    status: "succeeded" | "failed";
    result: Record<string, unknown>;
    traceRef?: string | null;
  },
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  return deps.updateAcquireJob(ctx.db, scope, id, {
    status: outcome.status,
    result: outcome.result,
    ...(outcome.traceRef === undefined ? {} : { traceRef: outcome.traceRef }),
  });
}
