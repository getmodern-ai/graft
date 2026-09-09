import { and, desc, gte, inArray, max } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { type NewUsageLedgerRow, usageLedger } from "../schema/usage";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * The usage ledger's reads and writes (ADR 0009, ADR 0012). Append-only: nothing here updates or
 * deletes a row, which is what makes the table safe to aggregate at any moment.
 */

export type UsageLedgerRow = typeof usageLedger.$inferSelect;

export async function insertUsage(db: DbOrTx, row: NewUsageLedgerRow): Promise<UsageLedgerRow> {
  const [inserted] = await db.insert(usageLedger).values(row).returning();
  if (!inserted) throw new Error("Insert of usage row returned no row");
  return inserted;
}

/** An agent's recent invocations, newest first, optionally since a moment. */
export async function listUsage(
  db: DbOrTx,
  scope: AgentScope,
  args: { limit: number; since?: Date },
): Promise<UsageLedgerRow[]> {
  return db
    .select()
    .from(usageLedger)
    .where(
      and(
        inArray(usageLedger.agentId, scopedAgentIds(db, scope)),
        args.since ? gte(usageLedger.createdAt, args.since) : undefined,
      ),
    )
    .orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
    .limit(args.limit);
}

/**
 * When each tool was last invoked by this agent — the contraction rule's other clock (ADR 0009),
 * read from the ledger rather than from `working_set.last_used_at` when the sweep wants the record
 * and not the cache of it. Meta-tool lines (`tool_id` null) are excluded by the grouping.
 */
export async function lastUsedAtByTool(
  db: DbOrTx,
  scope: AgentScope,
): Promise<{ toolId: string; lastUsedAt: Date }[]> {
  const rows = await db
    .select({ toolId: usageLedger.toolId, lastUsedAt: max(usageLedger.createdAt) })
    .from(usageLedger)
    .where(inArray(usageLedger.agentId, scopedAgentIds(db, scope)))
    .groupBy(usageLedger.toolId);
  return rows.flatMap((row) =>
    row.toolId && row.lastUsedAt ? [{ toolId: row.toolId, lastUsedAt: row.lastUsedAt }] : [],
  );
}
