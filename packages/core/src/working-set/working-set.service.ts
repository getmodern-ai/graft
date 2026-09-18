import type {
  WorkingSetChangeRow,
  WorkingSetEntry,
  WorkingSetRow,
} from "@graft/db/repo/working-set";
import type { WorkingSetChangeCause, WorkingSetPromotedBy } from "@graft/db/schema/working-set";

import type { ServiceContext } from "../context";
import { orNotFound } from "../errors";
import type { AgentScope } from "../tenancy";
import type { WorkingSetDeps } from "./working-set.deps";

/**
 * The working set (CONTEXT.md; ADR 0003, ADR 0009): promote, demote, touch, list — every change
 * recorded with its cause, because tool-list churn is a first-class event and the record is what
 * the console shows and a later miner reads (ADR 0012). Every function takes the `AgentScope`,
 * which the repo puts in the SQL.
 *
 * The cap and the idle window are *not* enforced here: promotion never refuses (ADR 0009's rule is
 * a backstop that demotes, GRA-24's sweep), so `promoteTool` answers whether anything changed and
 * the caller decides whether to fire `tools/list_changed`.
 */

export type WorkingSetChange = {
  /** False when the call changed nothing — already promoted, or not promoted to begin with. */
  changed: boolean;
  entry: WorkingSetRow | null;
};

/**
 * Promote. The tool must be in the person's toolbox — refused as `NOT_FOUND` otherwise, since a
 * tool that is another person's and one that does not exist are the same answer (ADR 0007). A tool
 * already promoted is a no-op with no change record. `promotedBy` is who did it (`agent`,
 * `publish`); the change record's cause is the same word.
 */
export async function promoteTool(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  promotedBy: Extract<WorkingSetPromotedBy, "agent" | "publish">,
  deps: WorkingSetDeps,
): Promise<WorkingSetChange> {
  orNotFound(await deps.findAuthoredToolById(ctx.db, scope.personId, toolId), "Tool not found");
  const at = deps.now();
  return ctx.db.transaction(async (tx) => {
    const entry = await deps.insertWorkingSetEntry(tx, {
      agentId: scope.agentId,
      toolId,
      promotedBy,
      promotedAt: at,
    });
    if (!entry) return { changed: false, entry: null };
    await deps.insertWorkingSetChange(tx, {
      id: deps.newId(),
      agentId: scope.agentId,
      toolId,
      change: "promote",
      cause: promotedBy,
      createdAt: at,
    });
    return { changed: true, entry };
  });
}

/**
 * Demote, with the cause the record needs: `agent` for the agent's own call, `idle` or `cap` for
 * the rule. The tool stays in the toolbox (ADR 0009). A tool not in the working set is a no-op with
 * no change record. The `revoke` cause is written by the connection service's own sweep rather
 * than through here (`connection.service.ts`, `revokeConnection`; ADR 0009 as amended 2026-09-18):
 * one statement of the working-set repo over every agent of the person, as the approval sweeps are,
 * because the connection module imports no other service.
 */
export async function demoteTool(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  cause: WorkingSetChangeCause,
  deps: WorkingSetDeps,
): Promise<WorkingSetChange> {
  return ctx.db.transaction(async (tx) => {
    const entry = await deps.deleteWorkingSetEntry(tx, scope, toolId);
    if (!entry) return { changed: false, entry: null };
    await deps.insertWorkingSetChange(tx, {
      id: deps.newId(),
      agentId: scope.agentId,
      toolId,
      change: "demote",
      cause,
      createdAt: deps.now(),
    });
    return { changed: true, entry };
  });
}

/** Every invocation moves `last_used_at` — the contraction rule's clock (ADR 0009). */
export async function touchToolUsed(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: WorkingSetDeps,
): Promise<WorkingSetRow | null> {
  return deps.touchWorkingSetUsed(ctx.db, scope, toolId, deps.now());
}

/** The agent's working set with each tool — what the MCP server lists (ADR 0003). */
export async function listWorkingSet(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: WorkingSetDeps,
): Promise<WorkingSetEntry[]> {
  return deps.listWorkingSet(ctx.db, scope);
}

export async function isPromoted(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: WorkingSetDeps,
): Promise<boolean> {
  return (await deps.findWorkingSetEntry(ctx.db, scope, toolId)) !== null;
}

export async function countWorkingSet(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: WorkingSetDeps,
): Promise<number> {
  return deps.countWorkingSet(ctx.db, scope);
}

/** The promotion history, newest first (GRA-1, user story 21). */
export async function listWorkingSetChanges(
  ctx: ServiceContext,
  scope: AgentScope,
  limit: number,
  deps: WorkingSetDeps,
): Promise<WorkingSetChangeRow[]> {
  return deps.listWorkingSetChanges(ctx.db, scope, limit);
}
