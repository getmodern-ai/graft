import {
  type AcquireJobDeps,
  type AgentDeps,
  type ApprovalDeps,
  type ConnectionDeps,
  getAcquireJob,
  getAgent,
  getConnection,
  getSetupState,
  isStarterVendorId,
  moveSetupBuild,
  orNotFound,
  type Principal,
  type ServiceContext,
  ServiceError,
  type SetupDeps,
  type SetupState,
  type StarterVendorId,
  starterVendorFor,
  startSetupBuild,
} from "@graft/core";
import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import {
  ACQUIRE_UNCONFIGURED,
  type AcquireStatus,
  acquireConfigured,
  acquireStatusOf,
  type McpDeps,
} from "@graft/mcp";

/**
 * Setup's goal, build and building steps on the server (GRA-207; ADR 0024, *The console is a
 * second caller of `acquire`* and *Build is the build approval*). The routes in `api.ts` are thin
 * over these:
 *
 * - `setupGoalContext`: what the goal step draws, the connection the record names, the starter's
 *   curated goal (`starterVendorFor`, empty for another vendor), and whether Build is available at
 *   all, which is the `acquire` door's own model check (`acquireConfigured`).
 * - `buildSetupTool`: Build, as `@graft/core`'s `startSetupBuild` (the build approval, the job, the
 *   record, one transaction), then the runner woken. Refused with the door's reason when no model
 *   can author, so the console's sentence and the MCP refusal are one decision. Unlike `acquire`,
 *   it does not answer `similar_tools_exist`: the person chose this goal on this page, and a retry
 *   must build.
 * - `learnSetupBuild`: on every read of the state, a job the record waits on that succeeded names
 *   its tool on the record (`building` to `result`, or the tool noted on `finish`). A failed job
 *   leaves the record on `building`, where the step shows the failure from the job route.
 * - `retrySetupGoal` and `continueSetupBuild`: *Change the goal* after a failure, and *Continue
 *   while it builds*.
 * - `readAgentAcquireJob`: one job of one of the person's agents in `acquire_status`'s shape, general
 *   in shape so a later screen may read any job; another person's agent or job is not found.
 */

/** The seams Setup's build shares with the MCP endpoint: the model, the job's record and the runner. */
export type SetupAcquireDeps = Pick<McpDeps, "model" | "acquireJob" | "acquireRunner">;

export type SetupBuildRouteDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  connection: ConnectionDeps;
  approval: ApprovalDeps;
  acquireJob: AcquireJobDeps;
  model?: SetupAcquireDeps["model"];
  acquireRunner?: SetupAcquireDeps["acquireRunner"];
};

/**
 * What the goal step's Build says when no model can author: the variables the operator sets, as
 * `@graft/env` and the README name them. The console shows it and disables Build.
 */
export const SETUP_BUILD_UNCONFIGURED_MESSAGE =
  "This deployment has no model configured, so Graft cannot build a tool yet. Whoever runs this Graft sets GRAFT_MODEL_BACKEND=provider with GRAFT_MODEL_PROVIDER and GRAFT_MODEL_API_KEY, then restarts it.";

/** The line a Setup job carries before the runner has said anything: the console's, not the model's. */
export const SETUP_FIRST_PROGRESS_LINE =
  "Queued: Graft's model will read the vendor's documentation, write a small module, check it, prove it with reads, publish it and dry-run it.";

export type SetupBuildAvailability =
  | { available: true }
  | { available: false; reason: typeof ACQUIRE_UNCONFIGURED; message: string };

/** `GET /api/setup/goal`: what the goal step draws. GRA-209 adds the suggested goals beside `goal`. */
export type SetupGoalContext = {
  connection: { id: string; vendor: string; displayName: string } | null;
  /** The starter vendor the connection's vendor is, or null for another vendor. */
  starterId: StarterVendorId | null;
  /** The starter's curated read-only goal, or empty for another vendor. */
  goal: string;
  build: SetupBuildAvailability;
};

function availability(deps: Pick<SetupBuildRouteDeps, "model">): SetupBuildAvailability {
  return acquireConfigured(deps)
    ? { available: true }
    : { available: false, reason: ACQUIRE_UNCONFIGURED, message: SETUP_BUILD_UNCONFIGURED_MESSAGE };
}

async function recordConnection(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string | null | undefined,
  deps: Pick<SetupBuildRouteDeps, "connection">,
) {
  if (!connectionId) return null;
  return getConnection(ctx, principal, connectionId, deps.connection);
}

export async function setupGoalContext(
  ctx: ServiceContext,
  principal: Principal,
  deps: SetupBuildRouteDeps,
): Promise<SetupGoalContext> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  const connection = await recordConnection(ctx, principal, record?.connectionId, deps);
  const starter = connection ? starterVendorFor(connection.vendor) : null;
  return {
    connection: connection
      ? { id: connection.id, vendor: connection.vendor, displayName: connection.displayName }
      : null,
    starterId: starter && isStarterVendorId(starter.id) ? starter.id : null,
    goal: starter?.goal ?? "",
    build: availability(deps),
  };
}

export async function buildSetupTool(
  ctx: ServiceContext,
  principal: Principal,
  input: { goal: string },
  deps: SetupBuildRouteDeps,
): Promise<SetupState> {
  const build = availability(deps);
  if (!build.available) {
    throw new ServiceError("CONFLICT", build.message, { details: { reason: build.reason } });
  }
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  const connection = await recordConnection(ctx, principal, record?.connectionId, deps);
  const starter = connection ? starterVendorFor(connection.vendor) : null;
  const { state } = await startSetupBuild(
    ctx,
    principal,
    {
      goal: input.goal,
      // The starter's documentation, as an agent would hint it; another vendor's model finds its own.
      hints: starter ? `The vendor's documentation starts at ${starter.docsUrl}.` : null,
      firstProgressLine: SETUP_FIRST_PROGRESS_LINE,
    },
    deps,
  );
  // After the commit, so the runner's claim sees the row (`acquire` wakes it the same way).
  deps.acquireRunner?.kick();
  return state;
}

/** The job the record waits on, read as its agent; null when there is none or it is gone. */
async function recordJob(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "acquireJob">,
): Promise<{ jobId: string; job: AcquireJobRow | null } | null> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  if (!record?.acquireJobId || !record.agentId) return null;
  const job = await getAcquireJob(
    ctx,
    { personId: principal.personId, agentId: record.agentId },
    record.acquireJobId,
    deps.acquireJob,
  );
  return { jobId: record.acquireJobId, job };
}

/** What a read did, so the route can count the build step completing where it is learned. */
export type SetupBuildResult = { state: SetupState; built: boolean };

export async function learnSetupBuild(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "agent" | "acquireJob">,
): Promise<SetupBuildResult> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  const waiting =
    (record?.step === "building" || record?.step === "finish") &&
    record.acquireJobId !== null &&
    record.toolId === null;
  const read = waiting ? await recordJob(ctx, principal, deps) : null;
  const toolId = read?.job?.status === "succeeded" ? read.job.toolId : null;
  if (!read || !toolId) {
    return { state: await getSetupState(ctx, principal, deps.setup, deps.agent), built: false };
  }
  const state = await moveSetupBuild(
    ctx,
    principal,
    { kind: "built", acquireJobId: read.jobId, toolId },
    deps.setup,
    deps.agent,
  );
  return { state, built: state.setup?.toolId === toolId };
}

/** The record's job while it stands on `building`, refused `CONFLICT` otherwise. */
async function buildingJob(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "acquireJob">,
): Promise<{ jobId: string; job: AcquireJobRow | null }> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  const read = record?.step === "building" ? await recordJob(ctx, principal, deps) : null;
  if (!read) {
    throw new ServiceError("CONFLICT", "Setup is not building a tool", {
      details: { reason: "setup_step", step: record?.step ?? null },
    });
  }
  return read;
}

/**
 * *Change the goal*: back to the goal step, only once the job failed, so a running job is never
 * left behind by a second one. A job that is gone (its agent revoked) counts as failed.
 */
export async function retrySetupGoal(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "agent" | "acquireJob">,
): Promise<SetupState> {
  const { jobId, job } = await buildingJob(ctx, principal, deps);
  if (job && job.status !== "failed") {
    throw new ServiceError(
      "CONFLICT",
      job.status === "succeeded"
        ? "The tool is built; there is no failure to change the goal for"
        : "The tool is still being built; wait for it, or continue while it builds",
      { details: { reason: "job_not_failed", status: job.status } },
    );
  }
  return moveSetupBuild(
    ctx,
    principal,
    { kind: "retry", acquireJobId: jobId },
    deps.setup,
    deps.agent,
  );
}

/** *Continue while it builds*: on to the finish step, the job kept so its tool is still learned. */
export async function continueSetupBuild(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "agent" | "acquireJob">,
): Promise<SetupState> {
  const { jobId } = await buildingJob(ctx, principal, deps);
  return moveSetupBuild(
    ctx,
    principal,
    { kind: "continue", acquireJobId: jobId },
    deps.setup,
    deps.agent,
  );
}

/** `GET /api/agents/:id/acquire-jobs/:jobId`: `acquire_status`'s shape, read at once, never held. */
export async function readAgentAcquireJob(
  ctx: ServiceContext,
  principal: Principal,
  ids: { agentId: string; jobId: string },
  deps: { agent: AgentDeps; acquireJob: AcquireJobDeps },
): Promise<AcquireStatus> {
  const agent = orNotFound(
    await getAgent(ctx, principal, ids.agentId, deps.agent),
    "Agent not found",
  );
  const job = orNotFound(
    await getAcquireJob(
      ctx,
      { personId: principal.personId, agentId: agent.id },
      ids.jobId,
      deps.acquireJob,
    ),
    "Acquire job not found",
  );
  return acquireStatusOf(job);
}
