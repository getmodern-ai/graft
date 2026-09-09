import { and, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { approval, buildApproval, type NewApprovalRow } from "../schema/approval";
import { connection } from "../schema/connection";
import { authoredTool } from "../schema/tool";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * Query ownership for approvals and build approvals (ADR 0008). Agent-scoped through
 * `scopedAgentIds`; the two vendor-wide deletes a revoke performs take the person instead, because
 * a revoke is the person's act and reaches every agent (ADR 0007).
 */

export type ApprovalRow = typeof approval.$inferSelect;
export type BuildApprovalRow = typeof buildApproval.$inferSelect;

export async function findApproval(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
): Promise<ApprovalRow | null> {
  const [row] = await db
    .select()
    .from(approval)
    .where(and(eq(approval.toolId, toolId), inArray(approval.agentId, scopedAgentIds(db, scope))))
    .limit(1);
  return row ?? null;
}

export async function listApprovals(db: DbOrTx, scope: AgentScope): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(approval)
    .where(inArray(approval.agentId, scopedAgentIds(db, scope)))
    .orderBy(approval.toolId);
}

/**
 * The person's answer, written or rewritten: one row per (agent, tool), so a second answer
 * replaces the first. `perCallRelaxed` is kept when the caller does not say — relaxing a
 * destructive tool and re-answering it are two acts.
 */
export async function upsertApproval(db: DbOrTx, input: NewApprovalRow): Promise<ApprovalRow> {
  const [row] = await db
    .insert(approval)
    .values(input)
    .onConflictDoUpdate({
      target: [approval.agentId, approval.toolId],
      set: {
        decision: input.decision,
        decidedAt: input.decidedAt,
        ...(input.perCallRelaxed === undefined ? {} : { perCallRelaxed: input.perCallRelaxed }),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Upsert of approval returned no row");
  return row;
}

/** Relax a destructive tool's per-call ask (ADR 0008). Null when no approval stands to relax. */
export async function relaxApproval(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
): Promise<ApprovalRow | null> {
  const [row] = await db
    .update(approval)
    .set({ perCallRelaxed: true })
    .where(and(eq(approval.toolId, toolId), inArray(approval.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}

export async function findBuildApproval(
  db: DbOrTx,
  scope: AgentScope,
  connectionId: string,
): Promise<BuildApprovalRow | null> {
  const [row] = await db
    .select()
    .from(buildApproval)
    .where(
      and(
        eq(buildApproval.connectionId, connectionId),
        inArray(buildApproval.agentId, scopedAgentIds(db, scope)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Grant, once: a repeated grant changes nothing and answers null. */
export async function insertBuildApproval(
  db: DbOrTx,
  input: { agentId: string; connectionId: string; grantedAt: Date },
): Promise<BuildApprovalRow | null> {
  const [row] = await db.insert(buildApproval).values(input).onConflictDoNothing().returning();
  return row ?? null;
}

/**
 * A revoke's first sweep: every approval, for every agent of the person, on every tool bound to
 * the vendor (ADR 0007: a fresh start means the agent asks from zero). Returns what it deleted.
 */
export async function deleteApprovalsForVendor(
  db: DbOrTx,
  personId: string,
  vendor: string,
): Promise<ApprovalRow[]> {
  return db
    .delete(approval)
    .where(
      inArray(
        approval.toolId,
        db
          .select({ id: authoredTool.id })
          .from(authoredTool)
          .where(and(eq(authoredTool.personId, personId), eq(authoredTool.vendor, vendor))),
      ),
    )
    .returning();
}

/** A revoke's second sweep: every agent's build approval for the connection. */
export async function deleteBuildApprovalsForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
): Promise<BuildApprovalRow[]> {
  return db
    .delete(buildApproval)
    .where(
      inArray(
        buildApproval.connectionId,
        db
          .select({ id: connection.id })
          .from(connection)
          .where(and(eq(connection.id, connectionId), eq(connection.personId, personId))),
      ),
    )
    .returning();
}

/**
 * Revoke one agent's standing answer for one tool, from the console (ADR 0008: an approval is a
 * durable record the person can revisit). The next call then asks again as if never answered. Null
 * when no approval stood. Distinct from the vendor-wide sweep above, which is a revoke's and reaches
 * every agent.
 */
export async function deleteApproval(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
): Promise<ApprovalRow | null> {
  const [row] = await db
    .delete(approval)
    .where(and(eq(approval.toolId, toolId), inArray(approval.agentId, scopedAgentIds(db, scope))))
    .returning();
  return row ?? null;
}
