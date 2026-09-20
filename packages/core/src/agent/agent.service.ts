import type { AgentConnectedVia, AgentRow } from "@graft/db/repo/agent";
import type { AgentScopeMode } from "@graft/db/schema/agent";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import { type AgentScope, mintAgentToken, type Principal } from "../tenancy";
import type { AgentDeps } from "./agent.deps";
import {
  AGENT_NAME_MAX_LENGTH,
  IDLE_WINDOW_DAYS_RANGE,
  WORKING_SET_CAP_RANGE,
} from "./agent.rules";

/**
 * Agents (CONTEXT.md; ADR 0007): create with a token shown once, list, revoke, tune the cap and
 * the idle window, set the scope. Plain functions — callable from the JSON API, the console later,
 * a script. `deps` is the last argument and is required; `defaultAgentDeps` is what a real caller
 * passes, and a test passes fakes, so nothing here needs a database to be exercised.
 *
 * Since ADR 0018 an agent is minted one of two ways: in the console, with a static token the person
 * copies into a harness (`createAgent`), or at an MCP client's consent, with no static token at all
 * (`createAgentForClient`) — that agent is reached through the tokens the client holds, and the
 * row records which client it was connected from.
 *
 * **The scope has a mode** (ADR 0007 as amended 2026-09-19; GRA-105). `all`, the default for a new
 * agent, is every connection of the person's, present and future, and holds no list; `listed` is
 * the rows the person ticked or the agent's own proposals added, as every agent's scope was before
 * the amendment. `getAgentScope` resolves the mode to ids in one statement, and every caller that
 * mints a capability token reads that — so the token names ids under both modes and the property
 * the ADR states does not move. A grant into the scope (`addConnectionToAgentScope`) is a no-op
 * for an agent on `all`, which is what makes every grant-on-connect path in `@graft/mcp` and
 * `apps/server` right without knowing the mode.
 */

export type { AgentScopeMode };

/** Bounds the console form and the API share — the schema's columns are unbounded on purpose. */
export { AGENT_NAME_MAX_LENGTH, IDLE_WINDOW_DAYS_RANGE, WORKING_SET_CAP_RANGE };

/** The MCP client an agent was connected from, as the wire sees it (ADR 0018); null for a console-made agent. */
export type AgentConnectedViaOutput = { clientId: string; clientName: string };

/** The row as the wire sees it: never the token hash. */
export type AgentOutput = {
  id: string;
  name: string;
  /** Null for an agent minted at an MCP client's consent, which holds no static token (ADR 0018). */
  tokenPrefix: string | null;
  connectedVia: AgentConnectedViaOutput | null;
  /** `all` or `listed` (the header's paragraph on the mode). */
  scopeMode: AgentScopeMode;
  workingSetCap: number;
  idleWindowDays: number;
  revokedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentListOutput = AgentOutput & { workingSetCount: number };

export function toAgentOutput(row: AgentRow): AgentOutput {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    connectedVia:
      row.connectedViaClientId && row.connectedViaClientName
        ? { clientId: row.connectedViaClientId, clientName: row.connectedViaClientName }
        : null,
    scopeMode: row.scopeMode,
    workingSetCap: row.workingSetCap,
    idleWindowDays: row.idleWindowDays,
    revokedAt: row.revokedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CreateAgentInput = {
  name: string;
  workingSetCap?: number;
  idleWindowDays?: number;
  /** `all` when absent (ADR 0007 as amended 2026-09-19); `listed` takes `connectionIds` as the list. */
  scopeMode?: AgentScopeMode;
  /**
   * The initial list under `listed`; every id must be one of the person's connections. Refused
   * with a list under `all`, which has none — a caller that sends both has two answers in mind.
   */
  connectionIds?: readonly string[];
};

/**
 * What a scope write says (`PUT /api/agents/:id/scope`): every connection, or a list. A `listed`
 * write with no list **materialises** the scope as it stands — every connection of the person's
 * for an agent on `all`, its list otherwise — so a person narrowing an agent starts from what it
 * had and unticks, rather than from nothing.
 */
export type SetAgentScopeInput =
  | { mode: "all" }
  | { mode: "listed"; connectionIds?: readonly string[] };

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
 * `connectionIds` is a list, and only a `listed` scope has one: refused rather than dropped, since
 * silently discarding what the caller named would leave them believing the agent was narrowed.
 */
function assertListMatchesMode(
  scopeMode: AgentScopeMode,
  connectionIds: readonly string[] | undefined,
): void {
  if (scopeMode === "all" && connectionIds !== undefined && connectionIds.length > 0) {
    throw new ServiceError(
      "BAD_REQUEST",
      "connectionIds names a list, and an agent on all connections has none — send scopeMode: listed with it",
    );
  }
}

/**
 * The insert both mints share: validated limits, a confirmed scope, the row and its scope in one
 * transaction. The token columns and the origin columns are the caller's — the two mints differ in
 * exactly those. The `connectionIds` answered are the scope as it now resolves: the list under
 * `listed`, every connection of the person's under `all`.
 */
async function insertNewAgent(
  ctx: ServiceContext,
  principal: Principal,
  input: CreateAgentInput,
  columns: Pick<
    AgentRow,
    "tokenHash" | "tokenPrefix" | "connectedViaClientId" | "connectedViaClientName"
  >,
  deps: AgentDeps,
): Promise<{ row: AgentRow; connectionIds: string[] }> {
  validateLimits(input);
  const scopeMode = input.scopeMode ?? "all";
  assertListMatchesMode(scopeMode, input.connectionIds);
  const listed =
    scopeMode === "listed"
      ? await assertOwnedConnections(ctx, principal, input.connectionIds ?? [], deps)
      : [];
  return ctx.db.transaction(async (tx) => {
    const inserted = await deps.insertAgent(tx, {
      id: deps.newId(),
      personId: principal.personId,
      name: input.name.trim(),
      scopeMode,
      ...columns,
      ...(input.workingSetCap === undefined ? {} : { workingSetCap: input.workingSetCap }),
      ...(input.idleWindowDays === undefined ? {} : { idleWindowDays: input.idleWindowDays }),
    });
    const scope: AgentScope = { personId: principal.personId, agentId: inserted.id };
    if (listed.length > 0) {
      await deps.replaceAgentConnections(tx, scope, listed);
    }
    return {
      row: inserted,
      connectionIds: scopeMode === "all" ? await deps.listScopeConnectionIds(tx, scope) : listed,
    };
  });
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
  const minted = mintAgentToken(deps.randomBytes);
  const { row, connectionIds } = await insertNewAgent(
    ctx,
    principal,
    input,
    {
      tokenHash: minted.tokenHash,
      tokenPrefix: minted.tokenPrefix,
      connectedViaClientId: null,
      connectedViaClientName: null,
    },
    deps,
  );
  return { agent: toAgentOutput(row), token: minted.token, connectionIds };
}

export type CreateAgentForClientInput = CreateAgentInput & {
  /** The MCP client whose consent is minting this agent — recorded on the row (ADR 0018). */
  connectedVia: AgentConnectedVia;
};

/**
 * Mint the agent an MCP client's consent asked for (ADR 0018): the same row as `createAgent`'s,
 * with the client recorded as its origin and **no static token** — no hash, no prefix, no value
 * shown to anyone. The client reaches it through the tokens the authorization server issues, and
 * a token nobody was ever shown would be a credential with no holder.
 */
export async function createAgentForClient(
  ctx: ServiceContext,
  principal: Principal,
  input: CreateAgentForClientInput,
  deps: AgentDeps,
): Promise<{ agent: AgentOutput; connectionIds: string[] }> {
  const { connectedVia, ...rest } = input;
  const { row, connectionIds } = await insertNewAgent(
    ctx,
    principal,
    rest,
    {
      tokenHash: null,
      tokenPrefix: null,
      connectedViaClientId: connectedVia.clientId,
      connectedViaClientName: connectedVia.clientName,
    },
    deps,
  );
  return { agent: toAgentOutput(row), connectionIds };
}

/**
 * The consent named an agent the person already had (ADR 0018): confirm it is theirs and still
 * stands, and record the client as its origin when none is recorded yet — an agent that already
 * says where it came from keeps saying so. A revoked agent cannot be lent to a client; the person
 * is told to pick another rather than have a dead agent quietly revived.
 */
export async function connectExistingAgentToClient(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  via: AgentConnectedVia,
  deps: AgentDeps,
): Promise<AgentOutput> {
  const row = orNotFound(
    await deps.findAgent(ctx.db, principal.personId, agentId),
    "Agent not found",
  );
  if (row.revokedAt) {
    throw new ServiceError("BAD_REQUEST", "This agent is revoked; choose another or create one");
  }
  const updated = await deps.setAgentConnectedVia(ctx.db, principal.personId, row.id, via);
  return toAgentOutput(updated ?? row);
}

export async function listAgents(
  ctx: ServiceContext,
  principal: Principal,
  deps: AgentDeps,
): Promise<AgentListOutput[]> {
  const rows = await deps.listAgents(ctx.db, principal.personId);
  return rows.map((row) => ({ ...toAgentOutput(row), workingSetCount: row.workingSetCount }));
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
 * Revoke: every token stops resolving at once — the static one because `findAgentByTokenHash`
 * filters on `revoked_at` in the statement, an MCP client's because the door's read joins the same
 * column (ADR 0018) — and the client's token rows are stamped in the same transaction so the record
 * says so. The row and its history stay. Null for no such agent, or one already revoked.
 */
export async function revokeAgent(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  deps: AgentDeps,
): Promise<AgentOutput | null> {
  const now = deps.now();
  const row = await ctx.db.transaction(async (tx) => {
    const revoked = await deps.revokeAgent(tx, principal.personId, agentId, now);
    if (!revoked) return null;
    await deps.revokeMcpTokensForAgent(
      tx,
      { personId: principal.personId, agentId: revoked.id },
      now,
    );
    return revoked;
  });
  return row ? toAgentOutput(row) : null;
}

/** Archive and revoke every token in one transaction, keeping history readable (ADR 0007). */
export async function archiveAgent(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  deps: AgentDeps,
): Promise<AgentOutput | null> {
  const row = await ctx.db.transaction(async (tx) => {
    const now = deps.now();
    const archived = await deps.archiveAgent(tx, principal.personId, agentId, now);
    // A repeated request reads the first archive back; a foreign id still reads nothing.
    if (!archived) return deps.findAgent(tx, principal.personId, agentId);
    await deps.revokeMcpTokensForAgent(tx, { personId: principal.personId, agentId }, now);
    return archived;
  });
  return row ? toAgentOutput(row) : null;
}

/**
 * Set the agent's scope (CONTEXT.md, *Scope*; `SetAgentScopeInput` says what each shape means).
 * One transaction, opened by locking the agent row (`findAgentForUpdate`): every scope write —
 * this one and the grant after a connect (`addConnectionToAgentScope`) — takes that lock first, so
 * two of them serialise rather than interleave. To `all`: the mode is written and the list cleared
 * — a list left behind would come back on a later `listed` write as a choice nobody made that day.
 * To `listed`: with no list given, the scope as it stands **inside the transaction** becomes the
 * list — read after the lock, so a connection a concurrent grant is making either committed before
 * (and is in the set) or waits on the row and then finds the agent on `listed` and writes its list
 * row; read outside it, a connection made in between was silently lost (Greptile on #88). Every
 * given id is checked to be the person's before anything is written, so a refused id leaves the
 * old scope intact rather than an empty one. The answer is the scope as it now resolves.
 */
export async function setAgentScope(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  input: SetAgentScopeInput,
  deps: AgentDeps,
): Promise<{ agent: AgentOutput; connectionIds: string[] }> {
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const row = orNotFound(
      await deps.findAgentForUpdate(tx, principal.personId, agentId),
      "Agent not found",
    );
    const scope: AgentScope = { personId: principal.personId, agentId: row.id };
    if (input.mode === "all") {
      const updated = await deps.updateAgent(tx, principal.personId, row.id, { scopeMode: "all" });
      await deps.replaceAgentConnections(tx, scope, []);
      return {
        agent: toAgentOutput(updated ?? { ...row, scopeMode: "all" }),
        connectionIds: await deps.listScopeConnectionIds(tx, scope),
      };
    }
    const wanted = input.connectionIds ?? (await deps.listScopeConnectionIds(tx, scope));
    const unique = await assertOwnedConnections(scoped, principal, wanted, deps);
    const updated = await deps.updateAgent(tx, principal.personId, row.id, {
      scopeMode: "listed",
    });
    await deps.replaceAgentConnections(tx, scope, unique);
    return {
      agent: toAgentOutput(updated ?? { ...row, scopeMode: "listed" }),
      connectionIds: unique,
    };
  });
}

/**
 * Add one connection to an agent's list, keeping the rest — what every grant-on-connect does when
 * a connection an agent proposed is made (GRA-28, GRA-58, GRA-59) and what a `scope` ask's yes does
 * (GRA-104): the connection is the person's, and the agent that asked is given it. **A no-op for an
 * agent on `all`** (ADR 0007 as amended 2026-09-19): the connection is the person's, so it is
 * already in that agent's scope, and writing a list row would leave one behind for a later `listed`
 * write to resurface; the answer is the scope as it resolves. The connection is checked to be the
 * person's like any scope write under either mode, so a foreign id is `NOT_FOUND` whatever the
 * mode. Under `listed` the write is one idempotent insert on the scope's key
 * (`addAgentConnection`), never a read of the list and a rewrite of the whole: a grant that overlaps
 * the agent page's picker or another grant loses neither (Greptile on #87), and adding one already
 * in the list changes nothing. The list read back after it, in the same transaction, is what the
 * caller answers with. The agent row is read **locked** (`findAgentForUpdate`), inside the
 * transaction, and the mode decided from that read: a narrowing running at the same time
 * (`setAgentScope`) takes the same lock, so this grant either sees `listed` and writes its row, or
 * commits first and the narrowing's materialised list includes the connection (Greptile on #88).
 * Callers already inside a transaction pass its handle as `ctx.db`; the nested call is a savepoint.
 */
export async function addConnectionToAgentScope(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  connectionId: string,
  deps: AgentDeps,
): Promise<{ agent: AgentOutput; connectionIds: string[] }> {
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const row = orNotFound(
      await deps.findAgentForUpdate(tx, principal.personId, agentId),
      "Agent not found",
    );
    await assertOwnedConnections(scoped, principal, [connectionId], deps);
    const scope: AgentScope = { personId: principal.personId, agentId: row.id };
    if (row.scopeMode === "all") {
      return {
        agent: toAgentOutput(row),
        connectionIds: await deps.listScopeConnectionIds(tx, scope),
      };
    }
    await deps.addAgentConnection(tx, scope, connectionId);
    return {
      agent: toAgentOutput(row),
      connectionIds: await deps.listAgentConnectionIds(tx, scope),
    };
  });
}

/**
 * The connection ids in an agent's scope — what `acquire` and every exec mint tokens within —
 * resolved for the agent's mode in one statement (ADR 0007 as amended 2026-09-19): every
 * connection of the person's under `all`, the list under `listed`. Revoked rows are in the set
 * under both, as they always were under a list (GRA-69); a caller that must not use one checks
 * `revokedAt` on the row it holds, as every exec and `listToolsFor` do.
 */
export async function getAgentScope(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: AgentDeps,
): Promise<string[]> {
  return deps.listScopeConnectionIds(ctx.db, scope);
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
