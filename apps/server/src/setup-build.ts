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
  setupBuildHints,
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
import { GOAL_PROPOSAL_MAX, type GoalProposalOutcome } from "@graft/model";

/**
 * Setup's goal, build and building steps on the server (GRA-207; ADR 0024, *The console is a
 * second caller of `acquire`* and *Build is the build approval*). The routes in `api.ts` are thin
 * over these:
 *
 * - `setupGoalContext`: what the goal step draws, the connection the record names, the starter's
 *   curated goal (`starterVendorFor`, empty for another vendor), and whether Build is available at
 *   all, which is the `acquire` door's own model check (`acquireConfigured`).
 * - `setupGoalSuggestions`: the chips above the goal field (GRA-209), the model's `proposeGoals`
 *   through the same per-person routing, on a route of its own so the step draws at once.
 * - `buildSetupTool`: Build, as `@graft/core`'s `startSetupBuild` (the build approval, the job, the
 *   record, one transaction), then the runner woken. Refused with the door's reason when no model
 *   can author, so the console's sentence and the MCP refusal are one decision. Unlike `acquire`,
 *   it does not answer `similar_tools_exist`: the person chose this goal on this page, and a retry
 *   must start a job.
 * - `learnSetupBuild`: on every read of the state, a job the record waits on that succeeded names
 *   its tool on the record (`building` to `result`, or the tool noted on `finish`, or on `completed`
 *   when the person finished before it landed). A failed job leaves the record on `building`,
 *   where the step shows the failure from the job route.
 * - `retrySetupGoal` and `continueSetupBuild`: *Change the goal* after a failure, and *Continue
 *   while it runs*.
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
  "This deployment has no model configured, so Graft cannot acquire a tool yet. Whoever runs this Graft sets GRAFT_MODEL_BACKEND=provider with GRAFT_MODEL_PROVIDER and GRAFT_MODEL_API_KEY, then restarts it.";

/** The line a Setup job carries before the runner has said anything: the console's, not the model's. */
export const SETUP_FIRST_PROGRESS_LINE =
  "Queued: Graft's model will read the vendor's documentation, write a small module, check it, prove it with reads, publish it and dry-run it.";

export type SetupBuildAvailability =
  | { available: true }
  | { available: false; reason: typeof ACQUIRE_UNCONFIGURED; message: string };

/**
 * `GET /api/setup/goal`: what the goal step draws, at once. The suggested goals are a model call
 * and arrive after, from `GET /api/setup/goal/suggestions` (`SetupGoalSuggestions`).
 */
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

/** `GET /api/setup/goal/suggestions`: the goal step's chips, up to three, or none. */
export type SetupGoalSuggestions = { suggestions: string[] };

/** What a proposal did, for the request's wide event; never the goals or the vendor's words. */
export type SetupGoalSuggestionsResult = SetupGoalSuggestions & {
  outcome: GoalProposalOutcome | "not_asked";
  error?: string;
  /** True when the answer is the memo's, from an earlier call for the same connection. */
  cached?: boolean;
};

/** How long one person's proposal for one connection is answered again without a model call. */
export const GOAL_SUGGESTION_MEMO_TTL_MS = 60 * 60 * 1000;
/**
 * How long an outcome other than `proposed` is answered again: a timeout, a failure, a decline or
 * an unusable answer. Long enough that concurrent and immediate re-reads share the one call, short
 * enough that a provider's bad minute does not hide the chips for the hour.
 */
export const GOAL_SUGGESTION_MEMO_FAILURE_TTL_MS = 2 * 60 * 1000;
/** How many proposals the memo holds before the oldest is dropped. */
export const GOAL_SUGGESTION_MEMO_MAX = 1000;

/**
 * The server's once-per-connection bound on the model call behind the chips (Greptile on #165):
 * the route is a read, and reads are outside the `api` rate-limit bucket (`rate-limit.ts`), so
 * without it a person could make the deployment's model, or their own key, propose on every
 * request. One proposal per person and connection is held, in flight or settled: a `proposed`
 * answer for `GOAL_SUGGESTION_MEMO_TTL_MS`, any other outcome (or a throw) for
 * `GOAL_SUGGESTION_MEMO_FAILURE_TTL_MS` from when it settled, so a timeout is asked again minutes
 * later rather than an hour later, and still never on every read. Held in this process alone, as
 * `in-flight.ts`'s registry is, so two replicas ask at most once each.
 */
export type GoalSuggestionMemo = {
  run(
    key: string,
    propose: () => Promise<SetupGoalSuggestionsResult>,
  ): Promise<SetupGoalSuggestionsResult>;
};

export function createGoalSuggestionMemo(
  options: { ttlMs?: number; failureTtlMs?: number; max?: number; now?: () => number } = {},
): GoalSuggestionMemo {
  const ttlMs = options.ttlMs ?? GOAL_SUGGESTION_MEMO_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? GOAL_SUGGESTION_MEMO_FAILURE_TTL_MS;
  const max = options.max ?? GOAL_SUGGESTION_MEMO_MAX;
  const now = options.now ?? Date.now;
  const held = new Map<
    string,
    { expiresAt: number; answer: Promise<SetupGoalSuggestionsResult> }
  >();
  return {
    async run(key, propose) {
      const hit = held.get(key);
      if (hit && now() < hit.expiresAt) return { ...(await hit.answer), cached: true };
      held.delete(key);
      while (held.size >= max) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      const entry = { expiresAt: now() + ttlMs, answer: propose() };
      held.set(key, entry);
      // Settled short of a proposal, the entry is cut to the failure window from then, so the
      // hour holds only goals worth showing.
      const shorten = () => {
        entry.expiresAt = Math.min(entry.expiresAt, now() + failureTtlMs);
      };
      entry.answer.then((result) => {
        if (result.outcome !== "proposed") shorten();
      }, shorten);
      return entry.answer;
    },
  };
}

/**
 * The goal step's suggested goals (GRA-209; GRA-202, *The goal step*): the deployment's model's
 * `proposeGoals`, given the record's connection and the starter's curated goal, routed as the
 * person's jobs are (`@graft/model`'s router, ADR 0014), so a person's own key sends their
 * vendor's name to their provider and nobody else's. None, and no call, where Build is
 * unavailable (no model), where the record is not on an open goal step (skipped, completed or on
 * another step: the chips are drawn there alone), where its connection is gone or revoked, or
 * where the adapter cannot propose; none where the proposal answered none or threw. Asked once
 * per person and connection inside the memo's window (`GoalSuggestionMemo`). It never refuses:
 * the step is never blocked on it.
 */
export async function setupGoalSuggestions(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "connection" | "model"> & {
    goalSuggestions: GoalSuggestionMemo;
  },
): Promise<SetupGoalSuggestionsResult> {
  const notAsked: SetupGoalSuggestionsResult = { suggestions: [], outcome: "not_asked" };
  const model = deps.model;
  const propose = model?.proposeGoals?.bind(model);
  if (!acquireConfigured(deps) || !propose) return notAsked;
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  if (record?.step !== "goal" || record.skippedAt || record.completedAt) return notAsked;
  const connection = await recordConnection(ctx, principal, record.connectionId, deps);
  if (!connection || connection.revokedAt) return notAsked;
  const starter = starterVendorFor(connection.vendor);
  return deps.goalSuggestions.run(`${principal.personId}:${connection.id}`, async () => {
    try {
      const proposal = await propose({
        personId: principal.personId,
        traceId: `setup:${principal.personId}`,
        vendor: connection.vendor,
        displayName: connection.displayName,
        primaryHost: connection.primaryHost,
        docsUrl: starter?.docsUrl ?? null,
        curatedGoal: starter?.goal ?? null,
      });
      return {
        suggestions: proposal.goals.slice(0, GOAL_PROPOSAL_MAX),
        outcome: proposal.outcome,
        ...(proposal.error ? { error: proposal.error } : {}),
      };
    } catch (error) {
      // Reading the person's key, or a backing that throws: the step goes on without chips.
      return {
        suggestions: [],
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
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
      // The starter's documentation, and its curated detail for its curated goal unchanged, as an
      // agent would hint them; another vendor's model finds its own.
      hints: setupBuildHints(starter, input.goal),
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
    (record?.step === "building" || record?.step === "finish" || record?.step === "completed") &&
    record.acquireJobId !== null &&
    record.toolId === null;
  const read = waiting ? await recordJob(ctx, principal, deps) : null;
  const toolId = read?.job?.status === "succeeded" ? read.job.toolId : null;
  if (!read || !toolId) {
    return { state: await getSetupState(ctx, principal, deps.setup, deps.agent), built: false };
  }
  const { state, moved } = await moveSetupBuild(
    ctx,
    principal,
    { kind: "built", acquireJobId: read.jobId, toolId },
    deps.setup,
    deps.agent,
  );
  // Counted by the read whose move named the tool: two reads of one pass both end on `result`.
  return { state, built: moved };
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
    throw new ServiceError("CONFLICT", "Setup is not waiting on a job", {
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
        ? "The tool has landed; there is no failure to change the goal for"
        : "The job is still acquiring the tool; wait for it, or continue while it runs",
      { details: { reason: "job_not_failed", status: job.status } },
    );
  }
  const { state } = await moveSetupBuild(
    ctx,
    principal,
    { kind: "retry", acquireJobId: jobId },
    deps.setup,
    deps.agent,
  );
  return state;
}

/** *Continue while it runs*: on to the finish step, the job kept so its tool is still learned. */
export async function continueSetupBuild(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupBuildRouteDeps, "setup" | "agent" | "acquireJob">,
): Promise<SetupState> {
  const { jobId } = await buildingJob(ctx, principal, deps);
  const { state } = await moveSetupBuild(
    ctx,
    principal,
    { kind: "continue", acquireJobId: jobId },
    deps.setup,
    deps.agent,
  );
  return state;
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
