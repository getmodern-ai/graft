import type { AgentRow } from "@graft/db/repo/agent";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import { type AgentScope, mintAgentToken, type Principal } from "../tenancy";
import type { AgentDeps } from "./agent.deps";

/**
 * Agents (CONTEXT.md; ADR 0007): create with a token shown once, list, revoke, tune the cap and
 * the idle window, set the scope. Plain functions — callable from the JSON API, the console later,
 * a script. `deps` is the last argument and is required; `defaultAgentDeps` is what a real caller
 * passes, and a test passes fakes, so nothing here needs a database to be exercised.
 */

/** Bounds the console form and the API share — the schema's columns are unbounded on purpose. */
export const AGENT_NAME_MAX_LENGTH = 100;
export const WORKING_SET_CAP_RANGE = { min: 1, max: 500 } as const;
export const IDLE_WINDOW_DAYS_RANGE = { min: 1, max: 3650 } as const;

/** The row as the wire sees it: never the token hash. */
export type AgentOutput = {
  id: string;
  name: string;
  tokenPrefix: string;
  workingSetCap: number;
  idleWindowDays: number;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toAgentOutput(row: AgentRow): AgentOutput {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    workingSetCap: row.workingSetCap,
    idleWindowDays: row.idleWindowDays,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CreateAgentInput = {
  name: string;
  workingSetCap?: number;
  idleWindowDays?: number;
  /** The initial scope; every id must be one of the person's connections. */
  connectionIds?: readonly string[];
};

export type AgentLimitsPatch = {
  name?: string;
  workingSetCap?: number;
  idleWindowDays?: number;
};

function validateLimits(patch: AgentLimitsPatch): void {
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0 || name.length > AGENT_NAME_MAX_LENGTH) {
      throw new ServiceError(
        "BAD_REQUEST",
        `An agent's name is 1 to ${AGENT_NAME_MAX_LENGTH} characters`,
      );
    }
  }
  if (patch.workingSetCap !== undefined && !inRange(patch.workingSetCap, WORKING_SET_CAP_RANGE)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The working-set cap is a whole number from ${WORKING_SET_CAP_RANGE.min} to ${WORKING_SET_CAP_RANGE.max}`,
    );
  }
  if (
    patch.idleWindowDays !== undefined &&
    !inRange(patch.idleWindowDays, IDLE_WINDOW_DAYS_RANGE)
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The idle window is a whole number of days from ${IDLE_WINDOW_DAYS_RANGE.min} to ${IDLE_WINDOW_DAYS_RANGE.max}`,
    );
  }
}

function inRange(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/**
 * Every id must be the person's connection — refused as `NOT_FOUND`, naming the ids, because a
 * connection that is not theirs and one that does not exist are the same answer (ADR 0007).
 */
async function assertOwnedConnections(
  ctx: ServiceContext,
  principal: Principal,
  connectionIds: readonly string[],
  deps: AgentDeps,
): Promise<string[]> {
  const unique = [...new Set(connectionIds)];
  if (unique.length === 0) return unique;
  const owned = await deps.findConnectionsByIds(ctx.db, principal.personId, unique);
  const ownedIds = new Set(owned.map((row) => row.id));
  const missing = unique.filter((id) => !ownedIds.has(id));
  if (missing.length > 0) {
    throw new ServiceError("NOT_FOUND", `Connection not found: ${missing.join(", ")}`, {
      details: { connectionIds: missing },
    });
  }
  return unique;
}

/**
 * Create an agent. The token is in the answer and nowhere else: the row stores its hash and its
 * first characters, so this is the one time anyone sees it (GRA-6's acceptance criterion).
 */
export async function createAgent(
  ctx: ServiceContext,
  principal: Principal,
  input: CreateAgentInput,
  deps: AgentDeps,
): Promise<{ agent: AgentOutput; token: string; connectionIds: string[] }> {
  validateLimits(input);
  const connectionIds = await assertOwnedConnections(
    ctx,
    principal,
    input.connectionIds ?? [],
    deps,
  );
  const minted = mintAgentToken(deps.randomBytes);

  const row = await ctx.db.transaction(async (tx) => {
    const inserted = await deps.insertAgent(tx, {
      id: deps.newId(),
      personId: principal.personId,
      name: input.name.trim(),
      tokenHash: minted.tokenHash,
      tokenPrefix: minted.tokenPrefix,
      ...(input.workingSetCap === undefined ? {} : { workingSetCap: input.workingSetCap }),
      ...(input.idleWindowDays === undefined ? {} : { idleWindowDays: input.idleWindowDays }),
    });
    if (connectionIds.length > 0) {
      await deps.replaceAgentConnections(
        tx,
        { personId: principal.personId, agentId: inserted.id },
        connectionIds,
      );
    }
    return inserted;
  });

  return { agent: toAgentOutput(row), token: minted.token, connectionIds };
}

export async function listAgents(
  ctx: ServiceContext,
  principal: Principal,
  deps: AgentDeps,
): Promise<AgentOutput[]> {
  const rows = await deps.listAgents(ctx.db, principal.personId);
  return rows.map(toAgentOutput);
}

export async function getAgent(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  deps: AgentDeps,
): Promise<AgentOutput | null> {
  const row = await deps.findAgent(ctx.db, principal.personId, agentId);
  return row ? toAgentOutput(row) : null;
}

/** The cap and the idle window are per agent and editable (ADR 0009); the name rides along. */
export async function updateAgentLimits(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  patch: AgentLimitsPatch,
  deps: AgentDeps,
): Promise<AgentOutput | null> {
  validateLimits(patch);
  // Built key by key: an absent key must not overwrite a stored value.
  const row = await deps.updateAgent(ctx.db, principal.personId, agentId, {
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.workingSetCap === undefined ? {} : { workingSetCap: patch.workingSetCap }),
    ...(patch.idleWindowDays === undefined ? {} : { idleWindowDays: patch.idleWindowDays }),
  });
  return row ? toAgentOutput(row) : null;
}

/**
 * Revoke: the token stops resolving at once (`findAgentByTokenHash` filters on `revoked_at` in the
 * statement), the row and its history stay. Null for no such agent, or one already revoked.
 */
export async function revokeAgent(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  deps: AgentDeps,
): Promise<AgentOutput | null> {
  const row = await deps.revokeAgent(ctx.db, principal.personId, agentId, deps.now());
  return row ? toAgentOutput(row) : null;
}

/**
 * Replace the agent's scope (CONTEXT.md, *Scope*). Every id is checked to be the person's before
 * anything is written, and the two statements run in one transaction so a refused id leaves the
 * old scope intact rather than an empty one.
 */
export async function setAgentScope(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  connectionIds: readonly string[],
  deps: AgentDeps,
): Promise<{ agent: AgentOutput; connectionIds: string[] }> {
  const row = orNotFound(
    await deps.findAgent(ctx.db, principal.personId, agentId),
    "Agent not found",
  );
  const unique = await assertOwnedConnections(ctx, principal, connectionIds, deps);
  const scope: AgentScope = { personId: principal.personId, agentId: row.id };
  await ctx.db.transaction(async (tx) => {
    await deps.replaceAgentConnections(tx, scope, unique);
  });
  return { agent: toAgentOutput(row), connectionIds: unique };
}

/** The connection ids in an agent's scope — what `acquire` and every exec mint tokens within. */
export async function getAgentScope(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: AgentDeps,
): Promise<string[]> {
  return deps.listAgentConnectionIds(ctx.db, scope);
}

/** An agent as the sweep sees it: its scope, and the two limits the rule reads (ADR 0009). */
export type ActiveAgentScope = AgentScope & { workingSetCap: number; idleWindowDays: number };

/**
 * Every agent whose token still resolves, across every person — the sweep's roster (ADR 0009), and
 * the one function in this module that takes no principal: the sweep is the system's own pass, not
 * a person's request. What comes back is a scope per agent, so everything the sweep does next — the
 * working-set read, each demotion — goes through a scoped statement like any agent's own call would.
 * `deps` is narrowed to the one read, so a caller holding only this cannot reach a person-scoped
 * function through it. The cap and window are the row's: the schema's defaults for a new agent, the
 * person's own values once edited in the console (GRA-1, user story 22).
 */
export async function listActiveAgentScopes(
  ctx: ServiceContext,
  deps: Pick<AgentDeps, "listAllActiveAgents">,
): Promise<ActiveAgentScope[]> {
  const rows = await deps.listAllActiveAgents(ctx.db);
  return rows.map((row) => ({
    personId: row.personId,
    agentId: row.id,
    workingSetCap: row.workingSetCap,
    idleWindowDays: row.idleWindowDays,
  }));
}
