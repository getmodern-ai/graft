import { and, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import {
  type ApprovalEventAction,
  type ApprovalEventKind,
  type ApprovalEventRow,
  type ApprovalEventVia,
  approvalEvent,
} from "../schema/approval-event";

/**
 * The approval events (GRA-341), append-only: written in the transaction of the change they record,
 * never updated or deleted here. The person is the row's own column, which every read of them
 * names (`repo/activity.ts`).
 */

export type NewApprovalEvent = {
  personId: string;
  agentId: string | null;
  kind: ApprovalEventKind;
  action: ApprovalEventAction;
  via: ApprovalEventVia;
  toolId?: string | null;
  vendor?: string | null;
  connectionId?: string | null;
  includesDestructive?: boolean | null;
  pendingActionId?: string | null;
  at: Date;
};

/**
 * Append one event. An event about an agent is inserted only for an agent of the person's, in the
 * statement (`insert … select` from the agent row under both ids, as `upsertVendorApproval` does),
 * so a scope naming another person's agent writes nothing and answers null; an event naming no
 * agent (a connection's revoke) is the person's own row.
 */
export async function insertApprovalEvent(
  db: DbOrTx,
  input: NewApprovalEvent,
): Promise<ApprovalEventRow | null> {
  const id = crypto.randomUUID();
  const columns = {
    toolId: input.toolId ?? null,
    vendor: input.vendor ?? null,
    connectionId: input.connectionId ?? null,
    includesDestructive: input.includesDestructive ?? null,
    pendingActionId: input.pendingActionId ?? null,
  };
  if (input.agentId === null) {
    const [row] = await db
      .insert(approvalEvent)
      .values({
        id,
        personId: input.personId,
        agentId: null,
        kind: input.kind,
        action: input.action,
        via: input.via,
        ...columns,
        at: input.at,
      })
      .returning();
    return row ?? null;
  }
  const [row] = await db
    .insert(approvalEvent)
    .select(
      db
        .select({
          id: sql<string>`${id}::text`.as("id"),
          personId: agent.personId,
          agentId: agent.id,
          kind: sql<ApprovalEventKind>`${input.kind}::text`.as("kind"),
          action: sql<ApprovalEventAction>`${input.action}::text`.as("action"),
          toolId: sql<string | null>`${columns.toolId}::text`.as("tool_id"),
          vendor: sql<string | null>`${columns.vendor}::text`.as("vendor"),
          connectionId: sql<string | null>`${columns.connectionId}::text`.as("connection_id"),
          includesDestructive: sql<boolean | null>`${columns.includesDestructive}::boolean`.as(
            "includes_destructive",
          ),
          via: sql<ApprovalEventVia>`${input.via}::text`.as("via"),
          pendingActionId: sql<string | null>`${columns.pendingActionId}::text`.as(
            "pending_action_id",
          ),
          at: sql<Date>`${input.at.toISOString()}::timestamp`.as("at"),
          owner: sql<"person">`'person'`.as("owner"),
          createdAt: sql<Date>`now()`.as("created_at"),
        })
        .from(agent)
        .where(and(eq(agent.id, input.agentId), eq(agent.personId, input.personId))),
    )
    .returning();
  return row ?? null;
}
