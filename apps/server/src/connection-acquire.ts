import {
  type AcquireJobDeps,
  type AgentDeps,
  type ApprovalDeps,
  type ConnectionDeps,
  getConnection,
  listConnectionAcquireJobs,
  orNotFound,
  type Principal,
  type ServiceContext,
  ServiceError,
  setupBuildHints,
  startConsoleAcquire,
  starterVendorFor,
} from "@graft/core";
import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import { type AcquireStatus, acquireStatusOf } from "@graft/mcp";

import {
  type GoalSuggestionMemo,
  proposeGoalsForConnection,
  SETUP_FIRST_PROGRESS_LINE,
  type SetupAcquireDeps,
  type SetupBuildAvailability,
  type SetupGoalSuggestionsResult,
  setupBuildAvailability,
} from "./setup-build";

/**
 * **An integration's page gets a new tool for an agent the person picked** (GRA-303; ADR 0024 as
 * amended 2026-10-14). The routes in `api.ts` are thin over these:
 *
 * - `startConnectionAcquire`: Create, as `@graft/core`'s `startConsoleAcquire` (the build approval
 *   and the job, one transaction, no Setup record), then the runner woken. Refused with the
 *   `acquire` door's reason and Setup's sentence when no model can author.
 * - `listConnectionJobs`: the connection's recent jobs across the person's agents, so a reload or
 *   a closed dialog finds the job; each is polled after through `GET /agents/:id/acquire-jobs/:jobId`.
 * - `connectionGoalSuggestions`: the chips over the goal field, Setup's proposal keyed by the
 *   connection alone (`proposeGoalsForConnection`), not gated on a Setup record.
 *
 * **No `similar_tools_exist`.** The `acquire` meta-tool answers a goal its toolbox or stock already
 * covers before asking (GRA-154), because an agent reaches for `acquire` before it looks. Here the
 * person asked for a new tool by name on a page that lists the integration's tools beside the
 * button, so Create starts a job, as Setup's Build does (`buildSetupTool`); a retry must too.
 */

export type ConnectionAcquireDeps = {
  agent: AgentDeps;
  connection: ConnectionDeps;
  approval: ApprovalDeps;
  acquireJob: AcquireJobDeps;
  model?: SetupAcquireDeps["model"];
  acquireRunner?: SetupAcquireDeps["acquireRunner"];
};

/**
 * One job as the integration page reads it: `acquire_status`'s shape (`AcquireStatus`) and what
 * the page draws beside it, the agent it builds for, the goal and when it was asked.
 */
export type ConnectionAcquireJob = AcquireStatus & {
  connectionId: string;
  agent: { id: string; name: string; revoked: boolean };
  goal: string;
  createdAt: Date;
};

/** `GET /connections/:id/acquire-jobs`: newest first, the last day's, at most twenty. */
export type ConnectionAcquireJobs = { jobs: ConnectionAcquireJob[] };

/** `GET /connections/:id/goal-suggestions`: up to three goals, or none. */
export type ConnectionGoalSuggestions = {
  suggestions: string[];
  /** Whether Create can start a job at all; the console disables it and shows the message when not. */
  build: SetupBuildAvailability;
};

function jobOf(
  job: AcquireJobRow,
  agent: { id: string; name: string; revokedAt: Date | null },
): ConnectionAcquireJob {
  return {
    ...acquireStatusOf(job),
    connectionId: job.connectionId,
    agent: { id: agent.id, name: agent.name, revoked: agent.revokedAt !== null },
    goal: job.goal,
    createdAt: job.createdAt,
  };
}

export async function startConnectionAcquire(
  ctx: ServiceContext,
  principal: Principal,
  input: { connectionId: string; agentId: string; goal: string },
  deps: ConnectionAcquireDeps,
): Promise<ConnectionAcquireJob> {
  const build = setupBuildAvailability(deps);
  if (!build.available) {
    throw new ServiceError("CONFLICT", build.message, { details: { reason: build.reason } });
  }
  // A starter's documentation, as Setup hints it; another vendor's model finds its own. Read
  // before the transaction for the vendor alone; the service reads the row again under it.
  const connection = await getConnection(ctx, principal, input.connectionId, deps.connection);
  const starter = connection ? starterVendorFor(connection.vendor) : null;
  const { job, agent } = await startConsoleAcquire(
    ctx,
    principal,
    {
      agentId: input.agentId,
      connectionId: input.connectionId,
      goal: input.goal,
      hints: setupBuildHints(starter, input.goal),
      // Setup's line, so the console's building view reads the job's stages the same way.
      firstProgressLine: SETUP_FIRST_PROGRESS_LINE,
    },
    deps,
  );
  // After the commit, so the runner's claim sees the row (`acquire` wakes it the same way).
  deps.acquireRunner?.kick();
  return jobOf(job, { ...agent, revokedAt: null });
}

export async function listConnectionJobs(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: Pick<ConnectionAcquireDeps, "connection" | "acquireJob">,
): Promise<ConnectionAcquireJobs> {
  const rows = await listConnectionAcquireJobs(ctx, principal, connectionId, deps);
  return { jobs: rows.map((row) => jobOf(row.job, row.agent)) };
}

/**
 * The goal field's chips for one of the person's connections, asked once per person and
 * connection inside the memo's window and shared with Setup's. Another person's connection is not
 * found; a revoked one, or a deployment with no model, answers none. Never refused otherwise.
 */
export async function connectionGoalSuggestions(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: Pick<ConnectionAcquireDeps, "connection" | "model"> & {
    goalSuggestions: GoalSuggestionMemo;
  },
): Promise<SetupGoalSuggestionsResult & { build: SetupBuildAvailability }> {
  const connection = orNotFound(
    await getConnection(ctx, principal, connectionId, deps.connection),
    "Connection not found",
  );
  const result = await proposeGoalsForConnection(
    principal,
    connection,
    deps,
    `console:${principal.personId}`,
  );
  return { ...result, build: setupBuildAvailability(deps) };
}
