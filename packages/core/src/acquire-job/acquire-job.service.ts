import type {
  AcquireAttemptRow,
  AcquireJobRow,
  AcquireTraceRow,
  RunnableAcquireJob,
} from "@graft/db/repo/acquire-job";
import type {
  AcquireAttemptFile,
  AcquireAttemptOutcome,
  AcquireTraceKind,
} from "@graft/db/schema/acquire-job";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import type { AcquireJobDeps } from "./acquire-job.deps";
import { withoutNul } from "./json-safe";
import { type RedactionRule, redactText, redactValue } from "./redaction";

/**
 * `acquire` jobs (CONTEXT.md; ADR 0012): the rows the meta-tool creates and `acquire_status` reads,
 * and the writes the inner loop makes as it goes — progress lines, token spend, an attempt opened
 * and closed, a trace line, the result. The loop itself is `@graft/mcp`'s (`acquire/job.ts`); this
 * is its record, and the one door every record passes through, which is where the redaction sits
 * (`./redaction.ts`): nothing reaches `acquire_trace` or an attempt's diagnosis without it.
 */

export const GOAL_MAX_LENGTH = 4000;
export const HINTS_MAX_LENGTH = 4000;

/** How many trace lines one read returns at most; a job's trace is bounded by its budgets, not unbounded. */
export const TRACE_READ_LIMIT = 1000;

export async function createAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  input: { connectionId: string; goal: string; hints?: string | null; firstProgressLine?: string },
  deps: AcquireJobDeps,
): Promise<AcquireJobRow> {
  const goal = input.goal.trim();
  if (goal.length === 0 || goal.length > GOAL_MAX_LENGTH) {
    throw new ServiceError("BAD_REQUEST", `A goal is 1 to ${GOAL_MAX_LENGTH} characters`);
  }
  const hints = input.hints?.trim() || null;
  if (hints !== null && hints.length > HINTS_MAX_LENGTH) {
    throw new ServiceError("BAD_REQUEST", `Hints are at most ${HINTS_MAX_LENGTH} characters`);
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
    hints,
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
  assertTokens(tokens);
  return deps.recordAcquireJobAttempt(ctx.db, scope, id, tokens);
}

/** One model turn's cost, added as it happens, so the ceiling is held against the database's figure. */
export async function recordAcquireJobTokens(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  usage: { inputTokens: number; outputTokens: number },
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  assertTokens(usage.inputTokens);
  assertTokens(usage.outputTokens);
  return deps.addAcquireJobTokenSpend(ctx.db, scope, id, usage.inputTokens + usage.outputTokens);
}

function assertTokens(tokens: number): void {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new ServiceError("BAD_REQUEST", "Token spend is a whole number of tokens");
  }
}

/** The runner saying it is still on the job. */
export async function heartbeatAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  return deps.heartbeatAcquireJob(ctx.db, scope, id, deps.now());
}

/** The end: the published tool's identity, or the last diagnostics and what was tried. */
export async function completeAcquireJob(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  outcome: {
    status: "succeeded" | "failed";
    result: Record<string, unknown>;
    toolId?: string | null;
    traceRef?: string | null;
  },
  deps: AcquireJobDeps,
): Promise<AcquireJobRow | null> {
  return deps.updateAcquireJob(ctx.db, scope, id, {
    status: outcome.status,
    // The result carries the diagnostics' proof-read bodies; the same rule as the trace (GRA-201).
    result: withoutNul(outcome.result),
    finishedAt: deps.now(),
    ...(outcome.toolId === undefined ? {} : { toolId: outcome.toolId }),
    ...(outcome.traceRef === undefined ? {} : { traceRef: outcome.traceRef }),
  });
}

/**
 * What a runner may take right now, taken: the roster read and, per job, the claim — each claim its
 * own statement, so a job another runner took between the two answers null and is skipped rather
 * than run twice (GRA-1, "No Temporal": the in-process runner's one concurrency rule).
 */
export async function claimRunnableAcquireJobs(
  ctx: ServiceContext,
  args: { staleAfterMs: number; limit: number },
  deps: AcquireJobDeps,
): Promise<RunnableAcquireJob[]> {
  if (args.limit <= 0) return [];
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - args.staleAfterMs);
  const candidates = await deps.listRunnableAcquireJobs(ctx.db, { staleBefore, limit: args.limit });
  const claimed: RunnableAcquireJob[] = [];
  for (const candidate of candidates) {
    const job = await deps.claimAcquireJob(ctx.db, candidate.job.id, { now, staleBefore });
    if (job) claimed.push({ job, personId: candidate.personId });
  }
  return claimed;
}

export type StartAcquireAttemptInput = {
  /** Where the draft was written in the toolbox — `.drafts/<jobId>/a<N>`, from `attemptNumber` the caller computes after this returns. */
  draftPath: (attemptNumber: number) => string;
  files: readonly AcquireAttemptFile[];
  /** The model's line on this draft — what it changed since the last one; redacted like a trace. */
  diagnosis?: string | null;
  redaction?: RedactionRule;
};

/**
 * Open an attempt: the job's count moves in the same transaction as the row is written, so the row's
 * number and the job's count cannot disagree, and `acquire_status`'s `attempts` is the console's.
 */
export async function startAcquireAttempt(
  ctx: ServiceContext,
  scope: AgentScope,
  jobId: string,
  input: StartAcquireAttemptInput,
  deps: AcquireJobDeps,
): Promise<AcquireAttemptRow> {
  return ctx.db.transaction(async (tx) => {
    const job = orNotFound(
      await deps.recordAcquireJobAttempt(tx, scope, jobId, 0),
      "Acquire job not found",
    );
    const attemptNumber = job.attempts;
    const diagnosis = input.diagnosis ? redactText(input.diagnosis, input.redaction).text : null;
    return deps.insertAcquireAttempt(tx, {
      id: deps.newId(),
      jobId,
      agentId: scope.agentId,
      attemptNumber,
      draftPath: input.draftPath(attemptNumber),
      files: redactValue([...input.files], input.redaction).value,
      diagnosis,
    });
  });
}

export type FinishAcquireAttemptInput = {
  outcome: Exclude<AcquireAttemptOutcome, "running">;
  checkOutput?: Record<string, unknown> | null;
  versionId?: string | null;
  diagnosis?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  redaction?: RedactionRule;
};

/** Close an attempt with where it stopped, what the check or publish said, and what it cost. */
export async function finishAcquireAttempt(
  ctx: ServiceContext,
  scope: AgentScope,
  attemptId: string,
  input: FinishAcquireAttemptInput,
  deps: AcquireJobDeps,
): Promise<AcquireAttemptRow | null> {
  if (input.usage) {
    assertTokens(input.usage.inputTokens);
    assertTokens(input.usage.outputTokens);
  }
  return deps.updateAcquireAttempt(ctx.db, scope, attemptId, {
    outcome: input.outcome,
    finishedAt: deps.now(),
    ...(input.checkOutput === undefined
      ? {}
      : {
          checkOutput:
            input.checkOutput === null
              ? null
              : redactValue(input.checkOutput, input.redaction).value,
        }),
    ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    ...(input.diagnosis === undefined
      ? {}
      : {
          diagnosis:
            input.diagnosis === null ? null : redactText(input.diagnosis, input.redaction).text,
        }),
    ...(input.usage
      ? { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens }
      : {}),
  });
}

export async function listAcquireAttempts(
  ctx: ServiceContext,
  scope: AgentScope,
  jobId: string,
  deps: AcquireJobDeps,
): Promise<AcquireAttemptRow[]> {
  return deps.listAcquireAttempts(ctx.db, scope, jobId);
}

export type AppendAcquireTraceInput = {
  attemptNumber?: number | null;
  kind: AcquireTraceKind;
  text: string;
  data?: Record<string, unknown> | null;
  /** What to redact beyond the shapes every line is checked for — `./redaction.ts`. */
  redaction?: RedactionRule;
};

/** How much of a trace line's text is kept. A vendor's error body is bounded here, not at the vendor. */
export const TRACE_TEXT_MAX_LENGTH = 8_000;

/**
 * One line of the inner-loop trace (ADR 0012), redacted on the way in — text and payload both — and
 * marked when the redaction changed anything, so a `[redacted]` in the console is known to be ours.
 */
export async function appendAcquireTrace(
  ctx: ServiceContext,
  scope: AgentScope,
  jobId: string,
  input: AppendAcquireTraceInput,
  deps: AcquireJobDeps,
): Promise<AcquireTraceRow> {
  const bounded =
    input.text.length > TRACE_TEXT_MAX_LENGTH
      ? `${input.text.slice(0, TRACE_TEXT_MAX_LENGTH)}…`
      : input.text;
  const text = redactText(bounded, input.redaction);
  const data =
    input.data === undefined || input.data === null
      ? { value: null, redacted: false }
      : redactValue(input.data, input.redaction);
  // No U+0000 reaches the jsonb column, whatever a vendor's body carried (GRA-201; `./json-safe.ts`).
  return deps.insertAcquireTrace(ctx.db, {
    id: deps.newId(),
    jobId,
    agentId: scope.agentId,
    attemptNumber: input.attemptNumber ?? null,
    kind: input.kind,
    text: withoutNul(text.text),
    data: withoutNul(data.value),
    redacted: text.redacted || data.redacted,
  });
}

export async function listAcquireTraces(
  ctx: ServiceContext,
  scope: AgentScope,
  jobId: string,
  limit: number,
  deps: AcquireJobDeps,
): Promise<AcquireTraceRow[]> {
  return deps.listAcquireTraces(ctx.db, scope, jobId, Math.min(limit, TRACE_READ_LIMIT));
}
