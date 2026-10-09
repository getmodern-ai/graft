import { relations } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned, ownedRecord } from "./columns";
import { connection } from "./connection";
import { authoredTool } from "./tool";

export const approvalDecision = ["allow", "deny"] as const;
export type ApprovalDecision = (typeof approvalDecision)[number];

/**
 * An **approval**: a person's standing answer to a tool's ask, per agent, per tool (CONTEXT.md;
 * ADR 0008). Undecided is the *absence* of a row. Reads never consult this table; any other tool,
 * destructive included, asks once and the row holds the answer, unless the person has set
 * `askEveryCall` on it. Deleted for every tool of a vendor when one of its connections is revoked,
 * so a fresh start means the agent asks from zero (ADR 0007).
 */
export const approval = pgTable(
  "approval",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => authoredTool.id, { onDelete: "cascade" }),
    decision: text("decision", { enum: approvalDecision }).notNull(),
    decidedAt: timestamp("decided_at").notNull(),
    /**
     * The person's opt-in, from the ask or the agent's page: true means every call of this tool
     * asks again whatever `decision` says, and each call's yes is the pending action's rather than
     * this row's. Off by default, for a new row and for every row that predates the column (ADR
     * 0008, amendment of 2026-09-15: the column it replaced, `per_call_relaxed`, was dropped rather
     * than inverted, because a destructive allow recorded under the old rule now holds).
     */
    askEveryCall: boolean("ask_every_call").notNull().default(false),
    ...owned(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.toolId] }),
    index("approval_tool_id_idx").on(table.toolId),
  ],
);

/**
 * A **build approval**: the person's once-per-agent-per-connection yes to `acquire` working
 * against a connection (ADR 0008), because that is the moment Graft's model starts reading the
 * person's data through dry-run reads. Presence is the grant; there is no deny row, because a
 * declined ask simply leaves nothing behind and the next `acquire` asks again.
 */
export const buildApproval = pgTable(
  "build_approval",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at").notNull().defaultNow(),
    ...ownedRecord(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.connectionId] }),
    index("build_approval_connection_id_idx").on(table.connectionId),
  ],
);

/**
 * A **standing approval for an integration**: the person's yes to every tool of one vendor for one
 * agent, given on a tool's ask (ADR 0008 as amended 2026-10-09; GRA-237). A non-read tool of that
 * vendor with no answer of its own then passes without asking, stock, remixed or authored, existing
 * or future, unless it is destructive and `includesDestructive` is off. A tool's own row still wins:
 * a `deny` refuses and the ask-every-call setting asks (`approvalDecision`). Presence is the yes;
 * there is no deny row, since leaving it absent is how an integration's tools keep asking. Deleted
 * for every agent of the person when one of the vendor's connections is revoked, as the vendor's
 * tool approvals are (ADR 0007).
 */
export const vendorApproval = pgTable(
  "vendor_approval",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** The connection's and the tool's vendor slug, the `<vendor>` of `<vendor>__<name>`. */
    vendor: text("vendor").notNull(),
    /** The separate tick on the same card, off by default: whether destructive tools pass too. */
    includesDestructive: boolean("includes_destructive").notNull().default(false),
    grantedAt: timestamp("granted_at").notNull(),
    ...owned(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.vendor] })],
);

export const approvalRelations = relations(approval, ({ one }) => ({
  agent: one(agent, { fields: [approval.agentId], references: [agent.id] }),
  tool: one(authoredTool, { fields: [approval.toolId], references: [authoredTool.id] }),
}));

export const buildApprovalRelations = relations(buildApproval, ({ one }) => ({
  agent: one(agent, { fields: [buildApproval.agentId], references: [agent.id] }),
  connection: one(connection, {
    fields: [buildApproval.connectionId],
    references: [connection.id],
  }),
}));

export const vendorApprovalRelations = relations(vendorApproval, ({ one }) => ({
  agent: one(agent, { fields: [vendorApproval.agentId], references: [agent.id] }),
}));

export type ApprovalRow = typeof approval.$inferSelect;
export type NewApprovalRow = typeof approval.$inferInsert;
export type BuildApprovalRow = typeof buildApproval.$inferSelect;
export type VendorApprovalRow = typeof vendorApproval.$inferSelect;
