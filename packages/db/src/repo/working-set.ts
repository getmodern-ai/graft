import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { authoredTool } from "../schema/tool";
import {
  type NewWorkingSetChangeRow,
  type NewWorkingSetRow,
  workingSet,
  workingSetChange,
} from "../schema/working-set";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the working set and its change log (ADR 0003, ADR 0009). Every statement
 * takes the `AgentScope` through `scopedAgentIds`, so one agent's list is never another agent's
 * and never another person's — the acceptance criterion of GRA-6 is on these predicates.
 */

export type WorkingSetRow = typeof workingSet.$inferSelect;
export type WorkingSetChangeRow = typeof workingSetChange.$inferSelect;

/** A promoted tool with the tool itself — what the MCP server lists (ADR 0003). */
export type WorkingSetEntry = WorkingSetRow & { tool: typeof authoredTool.$inferSelect };

export async function listWorkingSet(db: DbOrTx, scope: AgentScope): Promise<WorkingSetEntry[]> {
  const rows = await db
    .select({ entry: workingSet, tool: authoredTool })
    .from(workingSet)
    .innerJoin(authoredTool, eq(workingSet.toolId, authoredTool.id))
    .where(inArray(workingSet.agentId, scopedAgentIds(db, scope)))
    .orderBy(asc(workingSet.promotedAt), asc(workingSet.toolId));
  return rows.map(({ entry, tool }) => ({ ...entry, tool }));
}

export async function findWorkingSetEntry(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
): Promise<WorkingSetRow | null> {
  const [row] = await db
    .select()
    .from(workingSet)
    .where(
      and(eq(workingSet.toolId, toolId), inArray(workingSet.agentId, scopedAgentIds(db, scope))),
    )
    .limit(1);
  return row ?? null;
}

export async function countWorkingSet(db: DbOrTx, scope: AgentScope): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(workingSet)
    .where(inArray(workingSet.agentId, scopedAgentIds(db, scope)));
  return Number(row?.count ?? 0);
}

/**
 * Promote. `onConflictDoNothing` on the primary key: promoting a tool that is already promoted
 * changes nothing, and the null answer lets the service skip the change record and the
 * notification. The service has verified the tool is the person's before this insert.
 */
export async function insertWorkingSetEntry(
  db: DbOrTx,
  input: NewWorkingSetRow,
): Promise<WorkingSetRow | null> {
  const [row] = await db.insert(workingSet).values(input).onConflictDoNothing().returning();
  return row ?? null;
}

/** Demote. Null when the tool was not in this agent's working set. */
export async function deleteWorkingSetEntry(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
): Promise<WorkingSetRow | null> {
  const [row] = await db
    .delete(workingSet)
    .where(
      and(eq(workingSet.toolId, toolId), inArray(workingSet.agentId, scopedAgentIds(db, scope))),
    )
    .returning();
  return row ?? null;
}

/** The contraction rule's clock (ADR 0009): every invocation moves `last_used_at`. */
export async function touchWorkingSetUsed(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
  at: Date,
): Promise<WorkingSetRow | null> {
  const [row] = await db
    .update(workingSet)
    .set({ lastUsedAt: at })
    .where(
      and(eq(workingSet.toolId, toolId), inArray(workingSet.agentId, scopedAgentIds(db, scope))),
    )
    .returning();
  return row ?? null;
}

export async function insertWorkingSetChange(
  db: DbOrTx,
  input: NewWorkingSetChangeRow,
): Promise<WorkingSetChangeRow> {
  const [row] = await db.insert(workingSetChange).values(input).returning();
  if (!row) throw new Error("Insert of working-set change returned no row");
  return row;
}

/** The promotion history the console shows (GRA-1, user story 21), newest first. */
export async function listWorkingSetChanges(
  db: DbOrTx,
  scope: AgentScope,
  limit: number,
): Promise<WorkingSetChangeRow[]> {
  return db
    .select()
    .from(workingSetChange)
    .where(inArray(workingSetChange.agentId, scopedAgentIds(db, scope)))
    .orderBy(desc(workingSetChange.createdAt), desc(workingSetChange.id))
    .limit(limit);
}
