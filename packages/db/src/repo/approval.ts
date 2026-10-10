import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { approval, buildApproval, type NewApprovalRow, vendorApproval } from "../schema/approval";
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
export type VendorApprovalRow = typeof vendorApproval.$inferSelect;

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
 * replaces the first. `askEveryCall` is kept when the caller does not say — setting a tool to ask
 * every time and re-answering it are two acts.
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
        // A second answer is given for the version the tool stands on now (GRA-245).
        toolVersionId: input.toolVersionId ?? null,
        ...(input.askEveryCall === undefined ? {} : { askEveryCall: input.askEveryCall }),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("Upsert of approval returned no row");
  return row;
}

/**
 * Turn a tool's ask-every-call setting on or off for one agent (ADR 0008, amendment of
 * 2026-09-15). Null when no approval stands to carry it.
 */
export async function updateAskEveryCall(
  db: DbOrTx,
  scope: AgentScope,
  toolId: string,
  on: boolean,
): Promise<ApprovalRow | null> {
  const [row] = await db
    .update(approval)
    .set({ askEveryCall: on, updatedAt: new Date() })
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

/**
 * A stock advance that does not widen the annotations keeps the approval (ADR 0008 as amended
 * 2026-10-09; GRA-245): every agent's answer given for the version the copy stood on moves onto the
 * version the advance wrote. An answer already given for an older version stays where it was, so
 * it still asks. Under the person through the tool, as the vendor-wide delete is. `@graft/publish`'s
 * `advanceStockCopy` calls it inside the tool row's lock. Returns what it moved.
 */
export async function carryApprovalsToVersion(
  db: DbOrTx,
  personId: string,
  args: { toolId: string; fromVersionId: string; toVersionId: string },
): Promise<ApprovalRow[]> {
  return db
    .update(approval)
    .set({ toolVersionId: args.toVersionId, updatedAt: new Date() })
    .where(
      and(
        inArray(
          approval.toolId,
          db
            .select({ id: authoredTool.id })
            .from(authoredTool)
            .where(and(eq(authoredTool.id, args.toolId), eq(authoredTool.personId, personId))),
        ),
        eq(approval.toolVersionId, args.fromVersionId),
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

/**
 * The agent's standing approval for every tool of a vendor (ADR 0008 as amended 2026-10-09;
 * GRA-237), or null. Agent-scoped like a tool's approval.
 */
export async function findVendorApproval(
  db: DbOrTx,
  scope: AgentScope,
  vendor: string,
): Promise<VendorApprovalRow | null> {
  const [row] = await db
    .select()
    .from(vendorApproval)
    .where(
      and(
        eq(vendorApproval.vendor, vendor),
        inArray(vendorApproval.agentId, scopedAgentIds(db, scope)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listVendorApprovals(
  db: DbOrTx,
  scope: AgentScope,
): Promise<VendorApprovalRow[]> {
  return db
    .select()
    .from(vendorApproval)
    .where(inArray(vendorApproval.agentId, scopedAgentIds(db, scope)))
    .orderBy(vendorApproval.vendor);
}

/**
 * The person's yes to every tool of a vendor for one agent, written or rewritten: one row per
 * (agent, vendor), so a later answer replaces the destructive choice of an earlier one. The agent
 * comes from the scope through an `insert … select` over the agent row under both ids, so a scope
 * naming another person's agent inserts nothing and answers null.
 */
export async function upsertVendorApproval(
  db: DbOrTx,
  scope: AgentScope,
  input: { vendor: string; includesDestructive: boolean; grantedAt: Date },
): Promise<VendorApprovalRow | null> {
  const [row] = await db
    .insert(vendorApproval)
    .select(
      db
        .select({
          agentId: agent.id,
          vendor: sql<string>`${input.vendor}::text`.as("vendor"),
          includesDestructive: sql<boolean>`${input.includesDestructive}::boolean`.as(
            "includes_destructive",
          ),
          grantedAt: sql<Date>`${input.grantedAt.toISOString()}::timestamp`.as("granted_at"),
          owner: sql<"person">`'person'`.as("owner"),
          createdAt: sql<Date>`now()`.as("created_at"),
          updatedAt: sql<Date>`now()`.as("updated_at"),
        })
        .from(agent)
        .where(and(eq(agent.id, scope.agentId), eq(agent.personId, scope.personId))),
    )
    .onConflictDoUpdate({
      target: [vendorApproval.agentId, vendorApproval.vendor],
      set: {
        includesDestructive: input.includesDestructive,
        grantedAt: input.grantedAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row ?? null;
}

/** Withdraw an agent's standing approval for a vendor, from the console. Null when none stood. */
export async function deleteVendorApproval(
  db: DbOrTx,
  scope: AgentScope,
  vendor: string,
): Promise<VendorApprovalRow | null> {
  const [row] = await db
    .delete(vendorApproval)
    .where(
      and(
        eq(vendorApproval.vendor, vendor),
        inArray(vendorApproval.agentId, scopedAgentIds(db, scope)),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * A revoke's sweep of the vendor's standing approvals: every agent of the person, the vendor's
 * tool approvals' companion (ADR 0007: a fresh start means the agent asks from zero).
 */
export async function deleteVendorApprovalsForVendor(
  db: DbOrTx,
  personId: string,
  vendor: string,
): Promise<VendorApprovalRow[]> {
  return db
    .delete(vendorApproval)
    .where(
      and(
        eq(vendorApproval.vendor, vendor),
        inArray(
          vendorApproval.agentId,
          db.select({ id: agent.id }).from(agent).where(eq(agent.personId, personId)),
        ),
      ),
    )
    .returning();
}
