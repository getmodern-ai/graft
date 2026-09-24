import type { AgentRow } from "@graft/db/repo/agent";
import type { SetupPatch, SetupRow } from "@graft/db/repo/setup";
import type { AgentScopeMode } from "@graft/db/schema/agent";
import type { SetupHarness, SetupStep } from "@graft/db/schema/setup";

import type { AgentDeps } from "../agent/agent.deps";
import {
  type AgentOutput,
  createAgentAwaitingHarness,
  toAgentOutput,
} from "../agent/agent.service";
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
