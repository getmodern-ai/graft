import { relations } from "drizzle-orm";
import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned, ownedRecord } from "./columns";
import { authoredTool } from "./tool";

/**
 * Who moved a tool into the working set (ADR 0009: expansion has an author). `agent` is the
 * agent's own `promote` call, `publish` the `acquire` job promoting what it just built, `rule`
 * the cap-and-idle sweep — which only ever demotes, so it appears here only if a rule ever
 * promotes; recorded now so the enum needs no migration then.
 */
export const workingSetPromotedBy = ["agent", "publish", "rule"] as const;
export type WorkingSetPromotedBy = (typeof workingSetPromotedBy)[number];

/**
 * The **working set**: the authored tools currently promoted for one agent, and therefore present
 * in its MCP tool list (CONTEXT.md; ADR 0003). Agent × tool. A row here is the tool being in the
 * list; deleting it is demotion. The tool itself stays in the toolbox (ADR 0009).
 */
export const workingSet = pgTable(
  "working_set",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => authoredTool.id, { onDelete: "cascade" }),
    promotedAt: timestamp("promoted_at").notNull().defaultNow(),
    /**
     * Updated on every invocation — the contraction rule's clock (ADR 0009). Null until the first
     * call, which the sweep reads as "idle since promotion".
     */
    lastUsedAt: timestamp("last_used_at"),
    promotedBy: text("promoted_by", { enum: workingSetPromotedBy }).notNull(),
    ...owned(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.toolId] }),
    index("working_set_tool_id_idx").on(table.toolId),
    // The sweep's read: this agent's tools by how recently each was used.
    index("working_set_agent_id_last_used_at_idx").on(table.agentId, table.lastUsedAt),
  ],
);

export const workingSetChangeKind = ["promote", "demote"] as const;
export type WorkingSetChangeKind = (typeof workingSetChangeKind)[number];

/**
 * Why the working set changed: the agent asked, a publish promoted, the idle window or the cap
 * demoted (ADR 0009), or a revoke took the tool's connection away. The console shows this list
 * (GRA-1, user story 21), and it is the record a later miner reads (ADR 0012).
 */
export const workingSetChangeCause = ["agent", "publish", "idle", "cap", "revoke"] as const;
export type WorkingSetChangeCause = (typeof workingSetChangeCause)[number];

/** Every promotion and demotion, with its cause — tool-list churn is a first-class event (ADR 0003). */
export const workingSetChange = pgTable(
  "working_set_change",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => authoredTool.id, { onDelete: "cascade" }),
    change: text("change", { enum: workingSetChangeKind }).notNull(),
    cause: text("cause", { enum: workingSetChangeCause }).notNull(),
    ...ownedRecord(),
  },
  (table) => [
    index("working_set_change_agent_id_idx").on(table.agentId),
    index("working_set_change_tool_id_idx").on(table.toolId),
  ],
);

export const workingSetRelations = relations(workingSet, ({ one }) => ({
  agent: one(agent, { fields: [workingSet.agentId], references: [agent.id] }),
  tool: one(authoredTool, { fields: [workingSet.toolId], references: [authoredTool.id] }),
}));

export const workingSetChangeRelations = relations(workingSetChange, ({ one }) => ({
  agent: one(agent, { fields: [workingSetChange.agentId], references: [agent.id] }),
  tool: one(authoredTool, { fields: [workingSetChange.toolId], references: [authoredTool.id] }),
}));

export type WorkingSetRow = typeof workingSet.$inferSelect;
export type NewWorkingSetRow = typeof workingSet.$inferInsert;
export type WorkingSetChangeRow = typeof workingSetChange.$inferSelect;
export type NewWorkingSetChangeRow = typeof workingSetChange.$inferInsert;
