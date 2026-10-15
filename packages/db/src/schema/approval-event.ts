import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { user } from "./auth";
import { ownedRecord } from "./columns";
import { connection } from "./connection";
import { pendingAction } from "./pending-action";
import { authoredTool } from "./tool";

/**
 * What an event is about: a tool's answer (`approval`), an integration's standing approval
 * (`vendor_approval`), a build approval, a connection (an ask confirmed or declined, a revoke), an
 * agent's scope (the `scope` ask), or the agent itself (its revoke).
 */
export const approvalEventKind = [
  "tool",
  "vendor",
  "build",
  "connection",
  "scope",
  "agent",
] as const;
export type ApprovalEventKind = (typeof approvalEventKind)[number];

/**
 * What the person did. `allowed` and `denied` are answers (a declined ask included); `withdrew`
 * takes a standing answer away; `widened` and `narrowed` move an integration's approval to its
 * destructive tools and back; the two `ask_every_call_*` turn a tool's per-call ask on and off;
 * `revoked` is a connection's or an agent's revoke.
 */
export const approvalEventAction = [
  "allowed",
  "denied",
  "withdrew",
  "widened",
  "narrowed",
  "ask_every_call_on",
  "ask_every_call_off",
  "revoked",
] as const;
export type ApprovalEventAction = (typeof approvalEventAction)[number];

/**
 * The door the person used: the console's pages, a chat's ask card (`answer_ask`), an MCP client's
 * elicitation form, a vendor's consent or a provider's link the person returned from, and Setup.
 */
export const approvalEventVia = ["console", "card", "elicitation", "handoff", "setup"] as const;
export type ApprovalEventVia = (typeof approvalEventVia)[number];

/**
 * An **approval event**: one moment the person answered, withdrew, changed or revoked something,
 * appended in the transaction that made the change and never edited (GRA-341). The standing rows
 * (`approval`, `vendor_approval`, `build_approval`) say what holds now and lose what held before;
 * this is the record the console's Activity reads, so a withdrawn answer keeps its row and the
 * withdraw gets one beside it. No content: the subject is ids and a slug, never a payload.
 *
 * `agentId` is null for a connection's revoke, which is the person's act on every agent at once.
 * The subject columns are typed and nullable, one per kind: `toolId` for a tool, `vendor` on every
 * kind that has one (the tool's, the connection's) so a filter by integration needs no join, and
 * `connectionId` for a build approval, a connection and a scope. `set null` where the subject's row
 * can go, as the usage ledger's are, since the record outlives what it describes. `pendingActionId`
 * names the ask an answer answered, which is how the activity read leaves that ask out rather than
 * showing it twice (`repo/activity.ts`).
 */
export const approvalEvent = pgTable(
  "approval_event",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agent.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: approvalEventKind }).notNull(),
    action: text("action", { enum: approvalEventAction }).notNull(),
    toolId: text("tool_id").references(() => authoredTool.id, { onDelete: "set null" }),
    vendor: text("vendor"),
    connectionId: text("connection_id").references(() => connection.id, { onDelete: "set null" }),
    /** On a `vendor` event: whether the approval passes destructive tools. Null on every other kind. */
    includesDestructive: boolean("includes_destructive"),
    via: text("via", { enum: approvalEventVia }).notNull(),
    pendingActionId: text("pending_action_id").references(() => pendingAction.id, {
      onDelete: "set null",
    }),
    at: timestamp("at").notNull(),
    ...ownedRecord(),
  },
  (table) => [
    index("approval_event_person_id_at_idx").on(table.personId, table.at.desc()),
    index("approval_event_agent_id_idx").on(table.agentId),
    index("approval_event_tool_id_idx").on(table.toolId),
    index("approval_event_connection_id_idx").on(table.connectionId),
    index("approval_event_pending_action_id_idx").on(table.pendingActionId),
  ],
);

export const approvalEventRelations = relations(approvalEvent, ({ one }) => ({
  agent: one(agent, { fields: [approvalEvent.agentId], references: [agent.id] }),
}));

export type ApprovalEventRow = typeof approvalEvent.$inferSelect;
export type NewApprovalEventRow = typeof approvalEvent.$inferInsert;
