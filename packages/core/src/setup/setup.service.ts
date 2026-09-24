import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import type { AgentRow } from "@graft/db/repo/agent";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import type { AgentScopeMode } from "@graft/db/schema/agent";
import type { SetupHarness, SetupStep } from "@graft/db/schema/setup";

import type { AcquireJobDeps } from "../acquire-job/acquire-job.deps";
import { createAcquireJob } from "../acquire-job/acquire-job.service";
import type { AgentDeps } from "../agent/agent.deps";
import {
  type AgentOutput,
  createAgentAwaitingHarness,
  getAgentScope,
  toAgentOutput,
} from "../agent/agent.service";
import type { ApprovalDeps } from "../approval/approval.deps";
import { grantBuildApproval } from "../approval/approval.service";
import type { ConnectionDeps } from "../connection/connection.deps";
import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { Principal } from "../tenancy";
import { setupHarnessOf } from "./harness";
import type { SetupDeps } from "./setup.deps";
import { currentSetupStep, shouldShowSetup } from "./setup.rules";

/**
 * **Setup** (CONTEXT.md; ADR 0024): the console's guided first run, as a person-scoped record and
 * three verbs over it — read where it stands, start it with a harness, skip it. Every later step
 * (GRA-206 onwards) moves the same record on through `SetupDeps.saveSetup`.
 *
 * **The agent Setup runs as** is decided at the start, from the person's active agents: none, and
 * the start mints one for the harness picked, with no token and no client, so it is *awaiting its
 * harness* (`createAgentAwaitingHarness`); exactly one, and the start adopts it without asking,
 * since a person who consented from a chat product already has the agent the tool should land in
 * (GRA-202, user story 5); several, and the start names the one the person picked, never a guess
 * (user story 6). Adopting an agent records no harness: its harness was connected before Setup
 * showed, and the finish step (GRA-208) reads a null harness as "nothing to connect".
 *
 * **A start is serialised per person** on the record's row (`lockSetup`), and a record that already
 * runs as an agent that stands is answered as it is, with a skip cleared: so a double click, a
 * second tab or a reload never mints a second agent.
 */

export type { SetupHarness, SetupStep };

/** The record as the wire sees it: the row less the person, whose record it is by construction. */
export type SetupOutput = {
  step: SetupStep;
  /** Null when Setup adopted an agent that existed before it. */
  harness: SetupHarness | null;
  agentId: string | null;
  pendingActionId: string | null;
  connectionId: string | null;
  acquireJobId: string | null;
  toolId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  skippedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toSetupOutput(row: SetupRow): SetupOutput {
  return {
    step: row.step,
    harness: row.harness,
    agentId: row.agentId,
    pendingActionId: row.pendingActionId,
    connectionId: row.connectionId,
    acquireJobId: row.acquireJobId,
    toolId: row.toolId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    skippedAt: row.skippedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Where the person's Setup stands, as `GET /api/setup` answers it: the record, the step they are
 * on (`currentSetupStep`), whether the console sends them here (`shouldShowSetup`), the agent the
 * record runs as while it stands, and the person's active agents, from which the harness step
 * decides whether to mint, adopt or ask.
 */
export type SetupState = {
  setup: SetupOutput | null;
  step: SetupStep;
  show: boolean;
  agent: AgentOutput | null;
  activeAgents: AgentOutput[];
};

/** The agent a start mints, under *Advanced options*: the create dialog's fields less a list. */
export type StartSetupAgentInput = {
  /** The harness's own name (`SetupHarnessEntry.agentName`) when absent or blank. */
  name?: string;
  workingSetCap?: number;
  idleWindowDays?: number;
  /** `all` when absent, as a new agent's is (ADR 0007 as amended 2026-09-19). */
  scopeMode?: AgentScopeMode;
};

/**
 * `POST /api/setup/start`. `harness` is required when the person has no active agent, and ignored
 * otherwise, since an adopted agent records no harness; `agentId` names the agent to adopt, and is
 * required among several; `agent` describes the one to mint, and only a start that mints takes it.
 */
export type StartSetupInput = {
  harness?: SetupHarness;
  agentId?: string;
  agent?: StartSetupAgentInput;
};

function activeOf(rows: readonly AgentRow[]): AgentOutput[] {
  return rows.filter((row) => row.revokedAt === null).map(toAgentOutput);
}

function stateOf(
  row: SetupRow | null,
  activeAgents: AgentOutput[],
  work: { connections: number; tools: number },
): SetupState {
  const setup = row ? toSetupOutput(row) : null;
  const agent = setup?.agentId
    ? (activeAgents.find((candidate) => candidate.id === setup.agentId) ?? null)
    : null;
  return {
    setup,
    step: currentSetupStep(setup, agent !== null),
    show: shouldShowSetup(setup, work),
    agent,
    activeAgents,
  };
}

export async function getSetupState(
  ctx: ServiceContext,
  principal: Principal,
  deps: SetupDeps,
  agentDeps: Pick<AgentDeps, "listAgents">,
): Promise<SetupState> {
  const [row, agents, work] = await Promise.all([
    deps.findSetup(ctx.db, principal.personId),
    agentDeps.listAgents(ctx.db, principal.personId),
    deps.countSetupWork(ctx.db, principal.personId),
  ]);
  return stateOf(row, activeOf(agents), work);
}

/**
 * Start Setup, or resume it: mint or adopt the agent (the module's header), record it with the
 * harness, and move the record to the vendor step. The rest of the record (the ask, the
 * connection, the job, the tool) is cleared on a fresh start, since it belonged to an agent that no
 * longer stands. Refused as `CONFLICT` once completed, or when the start names an agent other than
 * the one the record already runs as.
 */
export async function startSetup(
  ctx: ServiceContext,
  principal: Principal,
  input: StartSetupInput,
  deps: SetupDeps,
  agentDeps: AgentDeps,
): Promise<SetupState> {
  if (input.agentId !== undefined && input.agent !== undefined) {
    throw new ServiceError(
      "BAD_REQUEST",
      "agentId names an agent to run as and agent describes one to mint; send one of them",
    );
  }
  await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const record = await deps.lockSetup(tx, principal.personId);
    const active = activeOf(await agentDeps.listAgents(tx, principal.personId));
    const now = deps.now();

    if (record.step === "completed") {
      throw new ServiceError("CONFLICT", "Setup is already complete", {
        details: { reason: "setup_completed" },
      });
    }
    const running = record.agentId
      ? active.find((candidate) => candidate.id === record.agentId)
      : undefined;
    if (running) {
      if (input.agentId !== undefined && input.agentId !== running.id) {
        throw new ServiceError("CONFLICT", `Setup is already running as ${running.name}`, {
          details: { reason: "setup_running", agentId: running.id },
        });
      }
      if (record.skippedAt) await deps.saveSetup(tx, principal.personId, { skippedAt: null });
      return;
    }

    let agentId: string;
    // The harness is recorded only beside the agent minted for it: an adopted agent's harness
    // was connected before Setup showed, and null is what tells the finish step so (the header).
    let harness: SetupHarness | null = null;
    if (input.agentId !== undefined) {
      const named = active.find((candidate) => candidate.id === input.agentId);
      if (!named) throw new ServiceError("NOT_FOUND", "Agent not found, or revoked");
      agentId = named.id;
    } else if (active.length === 0) {
      if (!input.harness) {
        throw new ServiceError("BAD_REQUEST", "Name the harness this agent is for", {
          details: { reason: "harness_required" },
        });
      }
      const entry = setupHarnessOf(input.harness);
      const { agent: minted } = await createAgentAwaitingHarness(
        scoped,
        principal,
        {
          ...input.agent,
          name: input.agent?.name?.trim() ? input.agent.name : entry.agentName,
        },
        agentDeps,
      );
      agentId = minted.id;
      harness = input.harness;
    } else if (input.agent !== undefined) {
      throw new ServiceError(
        "BAD_REQUEST",
        "You already have an agent, and Setup runs as one of yours rather than minting another",
        { details: { reason: "agent_exists" } },
      );
    } else if (active.length === 1 && active[0]) {
      agentId = active[0].id;
    } else {
      throw new ServiceError(
        "BAD_REQUEST",
        "You have several agents; name the one Setup should run as",
        { details: { reason: "agent_required", agentIds: active.map((agent) => agent.id) } },
      );
    }

    const patch: SetupPatch = {
      step: "vendor",
      harness,
      agentId,
      pendingActionId: null,
      connectionId: null,
      acquireJobId: null,
      toolId: null,
      startedAt: now,
      completedAt: null,
      skippedAt: null,
    };
    await deps.saveSetup(tx, principal.personId, patch);
  });
  return getSetupState(ctx, principal, deps, agentDeps);
}

/**
 * *Skip for now* (GRA-202, user story 26): the record is marked skipped, made first when the person
 * skipped before starting, and the show rule answers no from then on. Whatever the record held is
 * kept, so *Set up Graft* resumes rather than restarts where it can. A completed record is left
 * as it is. The skip takes the record's lock as the start does, so it is judged against the record
 * as a start in flight leaves it: a start that lands first is skipped after it, the person's later
 * word, and a record completed meanwhile is never marked.
 */
export async function skipSetup(
  ctx: ServiceContext,
  principal: Principal,
  deps: SetupDeps,
  agentDeps: Pick<AgentDeps, "listAgents">,
): Promise<SetupState> {
  await ctx.db.transaction(async (tx) => {
    const record = await deps.lockSetup(tx, principal.personId);
    if (record.step !== "completed") {
      await deps.saveSetup(tx, principal.personId, { skippedAt: deps.now() });
    }
  });
  return getSetupState(ctx, principal, deps, agentDeps);
}

/**
 * How the connect step moves the record (GRA-206; GRA-202, *The connect step is the agent's own
 * connection ask*). The server decides which move a request or an answered ask makes, since the
 * routing and the ask's answer are `@graft/mcp`'s; this function holds the record to its steps.
 *
 * - `ask`: the agent's own connection (or scope) ask is open; the record names it and is on
 *   `connect`. From `vendor` or `connect`, so a repeat or another starter re-points it.
 * - `connected`: the record names the connection and moves to `goal`. Without `askId`, from
 *   `vendor` or `connect`, for a connection the request made or found (a no-step provider, a row
 *   already in the agent's scope, the ordinary form). With `askId`, learned from that ask's answer
 *   on a read, and only while the record still waits on that ask.
 * - `fromVendorAt`, on `ask` and `connected`: the move lands only on the record as it was seen on
 *   `vendor`, its `updatedAt` unchanged. The connect route's second routing carries it, made after
 *   the ask the first handed back was found answered about a connection that no longer stands and
 *   the record went back to `vendor`: the person's choice is still in flight, so it lands over a
 *   read that reopened the record, and never over a choice another tab made meanwhile, even one
 *   that has since closed and left the record on `vendor` again (every write moves `updatedAt`).
 * - `reopen`: the ask was declined, expired or is gone, or its answer names a connection that is no
 *   longer live and in the agent's scope; back to `vendor` with no ask, only while the record
 *   still waits on it.
 * - `lost`: the connection the record names on `goal` was revoked or left the agent's scope before
 *   anything was built with it; back to `vendor`, only while the record is still on `goal` with it.
 */
export type SetupConnectMove =
  | { kind: "ask"; agentId: string; pendingActionId: string; fromVendorAt?: Date }
  | {
      kind: "connected";
      agentId: string;
      connectionId: string;
      askId?: string;
      fromVendorAt?: Date;
    }
  | { kind: "reopen"; askId: string }
  | { kind: "lost"; connectionId: string };

/**
 * What a move answers: the state as it now stands, and whether this call changed the record. A move
 * learned on a read is a no-op when another read got there first, and the state alone cannot say
 * which of two reads made it, so a caller that counts the step reads `moved`.
 */
export type SetupMoveResult = { state: SetupState; moved: boolean };

/**
 * The agent the connect step acts as: the record's, while it stands, on the vendor or connect
 * step. Refused `CONFLICT` otherwise, so no ask is opened for a Setup that has not started, has
 * moved past connecting, or runs as an agent that was revoked.
 */
export function connectingAgentOf(state: SetupState): AgentOutput {
  if (!state.agent || !state.setup) {
    throw new ServiceError("CONFLICT", "Setup has not started; choose a harness first", {
      details: { reason: "setup_not_started" },
    });
  }
  if (state.step !== "vendor" && state.step !== "connect") {
    throw new ServiceError("CONFLICT", "Setup is past connecting a vendor", {
      details: { reason: "setup_step", step: state.step },
    });
  }
  return state.agent;
}

/**
 * Apply a `SetupConnectMove` under the record's lock, and answer the state and whether it moved.
 *
 * `confirm`, when given, runs under the lock once the move's own guard has passed and before the
 * record is written, with the transaction; answering false leaves the record as it is. It is how a
 * move a read decided is judged again, or its side effect made, against the record as it now
 * stands: a `lost` that a later restore of the same connection has made untrue, or the taking of a
 * stale answer, which two reads would otherwise both attempt.
 */
export async function moveSetupConnect(
  ctx: ServiceContext,
  principal: Principal,
  move: SetupConnectMove,
  deps: SetupDeps,
  agentDeps: Pick<AgentDeps, "listAgents">,
  confirm?: (scoped: ServiceContext) => Promise<boolean>,
): Promise<SetupMoveResult> {
  const moved = await ctx.db.transaction(async (tx) => {
    const record = await deps.lockSetup(tx, principal.personId);
    const askId =
      move.kind === "reopen" ? move.askId : move.kind === "connected" ? move.askId : null;
    if (move.kind === "lost") {
      if (record.step !== "goal" || record.connectionId !== move.connectionId) return false;
    } else if (askId) {
      // Learned on a read, so a stale read (another tab moved on) changes nothing.
      if (record.step !== "connect" || record.pendingActionId !== askId) return false;
    } else if (move.kind !== "reopen" && move.fromVendorAt) {
      if (
        record.agentId !== move.agentId ||
        record.step !== "vendor" ||
        record.updatedAt.getTime() !== move.fromVendorAt.getTime()
      ) {
        return false;
      }
    } else if (
      move.kind !== "reopen" &&
      (record.agentId !== move.agentId || (record.step !== "vendor" && record.step !== "connect"))
    ) {
      throw new ServiceError("CONFLICT", "Setup moved on while this vendor was being connected", {
        details: { reason: "setup_step", step: record.step },
      });
    }
    if (confirm && !(await confirm({ db: tx }))) return false;
    const patch: SetupPatch =
      move.kind === "ask"
        ? { step: "connect", pendingActionId: move.pendingActionId, connectionId: null }
        : move.kind === "connected"
          ? { step: "goal", pendingActionId: null, connectionId: move.connectionId }
          : { step: "vendor", pendingActionId: null, connectionId: null };
    await deps.saveSetup(tx, principal.personId, patch);
    return true;
  });
  return { state: await getSetupState(ctx, principal, deps, agentDeps), moved };
}

/**
 * The build step (GRA-207; ADR 0024, *Build is the build approval*). Pressing Build is the person
 * answering the build ask in the console, so the approval is recorded through the function the
 * pending-action answer calls (`grantBuildApproval`, which answers the standing row on a second
 * grant, since the connection ask's card usually granted it already) and no ask is opened; then
 * the job is created as the record's agent against the record's connection, and the record names
 * it and moves to `building`. One transaction under the record's lock, so a double click opens
 * one job and a Build from a tab that moved on changes nothing. Waking the runner is the caller's,
 * once this returns, since the runner must see the committed row.
 *
 * Refused `CONFLICT` unless the record stands on `goal` with its agent active and a connection
 * named, and as `connection_not_in_scope` when the connection has left the agent's scope, the
 * check `acquire`'s door makes before anything else.
 */
export type StartSetupBuildInput = {
  goal: string;
  hints?: string | null;
  /** The line the job carries before its runner has said anything. */
  firstProgressLine: string;
};

export type SetupBuildDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  /** The connection's row, read under the lock: a revoked row stays in a resolved scope. */
  connection: Pick<ConnectionDeps, "findConnection">;
  approval: ApprovalDeps;
  acquireJob: AcquireJobDeps;
};

export async function startSetupBuild(
  ctx: ServiceContext,
  principal: Principal,
  input: StartSetupBuildInput,
  deps: SetupBuildDeps,
): Promise<{ state: SetupState; job: AcquireJobRow }> {
  const job = await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const record = await deps.setup.lockSetup(tx, principal.personId);
    const active = activeOf(await deps.agent.listAgents(tx, principal.personId));
    const agent = record.agentId
      ? active.find((candidate) => candidate.id === record.agentId)
      : undefined;
    if (!agent || !record.connectionId) {
      throw new ServiceError(
        "CONFLICT",
        "Setup has no agent and connection to acquire a tool with yet",
        {
          details: { reason: "setup_not_started" },
        },
      );
    }
    if (record.step !== "goal") {
      throw new ServiceError("CONFLICT", "Setup is not on the goal step", {
        details: { reason: "setup_step", step: record.step },
      });
    }
    const scope = { personId: principal.personId, agentId: agent.id };
    const connectionId = record.connectionId;
    // Revoked rows stay in a resolved scope (`getAgentScope`), so the row's own state is read too:
    // a job against a revoked connection would only fail in the runner. The next read of the
    // state takes the record back to the vendor step (`SetupConnectMove`'s `lost`).
    const connection = await deps.connection.findConnection(tx, principal.personId, connectionId);
    if (!connection || connection.revokedAt) {
      throw new ServiceError(
        "CONFLICT",
        `${connection?.displayName ?? "The connection"} is revoked, so no tool can be acquired against it; choose a vendor again`,
        { details: { reason: "connection_revoked", connectionId } },
      );
    }
    if (!(await getAgentScope(scoped, scope, deps.agent)).includes(connectionId)) {
      throw new ServiceError(
        "CONFLICT",
        `The connection is no longer in ${agent.name}'s scope, so no tool can be acquired against it`,
        { details: { reason: "connection_not_in_scope", connectionId } },
      );
    }
    await grantBuildApproval(scoped, scope, connectionId, deps.approval);
    const created = await createAcquireJob(
      scoped,
      scope,
      {
        connectionId,
        goal: input.goal,
        hints: input.hints ?? null,
        firstProgressLine: input.firstProgressLine,
      },
      deps.acquireJob,
    );
    await deps.setup.saveSetup(tx, principal.personId, {
      step: "building",
      acquireJobId: created.id,
      toolId: null,
    });
    return created;
  });
  return { state: await getSetupState(ctx, principal, deps.setup, deps.agent), job };
}

/**
 * How the building step moves the record (GRA-207). Each move names the job it is about, so a
 * move about a job the record no longer waits on (another tab pressed Build again) is stale.
 *
 * - `built`: the job succeeded with this tool, learned on a read. From `building` to `result`; on
 *   `finish` (the person continued while it ran) the record names the tool and stays, so the
 *   finish step can say it arrived. A no-op when stale or already named.
 * - `retry`: *Change the goal* after a failure, from `building` back to `goal` with the job
 *   cleared, so the next Build starts a new one. The caller judges that the job failed.
 * - `continue`: *Continue while it runs*, from `building` to `finish` with the job kept, so the
 *   tool is still learned when it lands.
 *
 * `retry` and `continue` are requests, and refuse `CONFLICT` when stale.
 */
export type SetupBuildMove =
  | { kind: "built"; acquireJobId: string; toolId: string }
  | { kind: "retry"; acquireJobId: string }
  | { kind: "continue"; acquireJobId: string };

/** Apply a `SetupBuildMove` under the record's lock, and answer the state as it now stands. */
export async function moveSetupBuild(
  ctx: ServiceContext,
  principal: Principal,
  move: SetupBuildMove,
  deps: SetupDeps,
  agentDeps: Pick<AgentDeps, "listAgents">,
): Promise<SetupMoveResult> {
  const moved = await ctx.db.transaction(async (tx) => {
    const record = await deps.lockSetup(tx, principal.personId);
    const current = record.acquireJobId === move.acquireJobId;
    if (move.kind === "built") {
      if (!current || record.toolId !== null) return false;
      if (record.step === "building") {
        await deps.saveSetup(tx, principal.personId, { step: "result", toolId: move.toolId });
        return true;
      }
      if (record.step === "finish") {
        await deps.saveSetup(tx, principal.personId, { toolId: move.toolId });
        return true;
      }
      return false;
    }
    if (!current || record.step !== "building") {
      throw new ServiceError("CONFLICT", "Setup moved on while the job was acquiring this tool", {
        details: { reason: "setup_step", step: record.step },
      });
    }
    const patch: SetupPatch =
      move.kind === "retry"
        ? { step: "goal", acquireJobId: null, toolId: null }
        : { step: "finish" };
    await deps.saveSetup(tx, principal.personId, patch);
    return true;
  });
  return { state: await getSetupState(ctx, principal, deps, agentDeps), moved };
}
