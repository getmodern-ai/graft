import { relations } from "drizzle-orm";
import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { ownedRecord } from "./columns";
import { authoredTool, toolVersion } from "./tool";

export const usageOutcome = ["ok", "error", "refused"] as const;
export type UsageOutcome = (typeof usageOutcome)[number];

/**
 * The **usage ledger**: one row per invocation — agent, tool, version, outcome, dry-run flag,
 * latency (GRA-1, "Tenancy and the schema"). Two readers share it, which is why it is one table
 * (ADR 0009): the contraction rule reads per-agent, per-tool recency, and the repair and mining
 * levels of ADR 0012 read per-tool failure rates. Append-only; a correction is a new row.
 *
 * Denormalised rather than joined, because it is read by aggregation: `toolName` is stored beside
 * `toolId` so a meta-tool call (`acquire`, `find_tool`, which have no tool row) and a call to a
 * tool whose row is gone both still say what was called. `toolId` and `versionId` are `set null`
 * for the same reason: the record must outlive what it describes.
 */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    toolId: text("tool_id").references(() => authoredTool.id, { onDelete: "set null" }),
    versionId: text("version_id").references(() => toolVersion.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    outcome: text("outcome", { enum: usageOutcome }).notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    latencyMs: integer("latency_ms").notNull(),
    ...ownedRecord(),
  },
  (table) => [
    index("usage_ledger_agent_id_created_at_idx").on(table.agentId, table.createdAt.desc()),
    index("usage_ledger_tool_id_idx").on(table.toolId),
    index("usage_ledger_version_id_idx").on(table.versionId),
  ],
);

export const usageLedgerRelations = relations(usageLedger, ({ one }) => ({
  agent: one(agent, { fields: [usageLedger.agentId], references: [agent.id] }),
  tool: one(authoredTool, { fields: [usageLedger.toolId], references: [authoredTool.id] }),
  version: one(toolVersion, { fields: [usageLedger.versionId], references: [toolVersion.id] }),
}));

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert;
