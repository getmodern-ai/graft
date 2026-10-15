import { relations } from "drizzle-orm";
import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { ownedRecord } from "./columns";
import { connection } from "./connection";
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
 *
 * **Three columns say how a call ended in the console's words** (GRA-301, decided under GRA-286),
 * all nullable, and null on every row written before them, which reads as unknown:
 *
 * - `reason`: the word a `refused` or `error` line ended on, from the vocabulary the run already
 *   answers (a refusal's `reason`, such as `approval_declined`, `tool_denied`, `awaiting_approval`,
 *   `connection_revoked`, `input_invalid`, `blob_quota`; a failure's kind, such as `threw`,
 *   `timeout`, `killed`, `still_running`, `sandbox_unavailable`; `execute__`'s `exit_nonzero` or
 *   `exit_unknown`). Null on an `ok` line. Never a message, never content: `@graft/core`'s
 *   `recordUsage` refuses anything that is not a snake_case word.
 * - `asked`: whether this call put an approval ask to the person or took the answer to one.
 *   `true`: the call opened an ask, re-offered one still open, or took one answered while it waited
 *   (so `ok` with `true` is "approved", `refused` with `true` is declined, expired or still
 *   awaiting, by `reason`). `false`: the gate decided with no ask on this call, on a read-only
 *   annotation or a standing answer (a tool's, its integration's, or the build approval for
 *   `execute__`), so `ok` with `false` is "ran without asking" and `refused` with `false` is a
 *   standing deny. Null: the call never reached the gate (refused before it, or an authored
 *   tool's dry run, which passes no gate). An `execute__` dry run still needs the build approval,
 *   so it records `true` or `false` as any other execute call does.
 * - `connectionId`: the connection the call ran, or would have run, against: an authored tool's as
 *   `run.ts` resolves it (the default, the one connection it follows, or the one the caller named),
 *   and `execute__<id>`'s own. Null when the call ended before one was resolved; `set null` with the
 *   connection, as `toolId` is.
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
    reason: text("reason"),
    asked: boolean("asked"),
    connectionId: text("connection_id").references(() => connection.id, { onDelete: "set null" }),
    ...ownedRecord(),
  },
  (table) => [
    index("usage_ledger_agent_id_created_at_idx").on(table.agentId, table.createdAt.desc()),
    index("usage_ledger_tool_id_idx").on(table.toolId),
    index("usage_ledger_version_id_idx").on(table.versionId),
    index("usage_ledger_connection_id_idx").on(table.connectionId),
  ],
);

export const usageLedgerRelations = relations(usageLedger, ({ one }) => ({
  agent: one(agent, { fields: [usageLedger.agentId], references: [agent.id] }),
  tool: one(authoredTool, { fields: [usageLedger.toolId], references: [authoredTool.id] }),
  version: one(toolVersion, { fields: [usageLedger.versionId], references: [toolVersion.id] }),
  connection: one(connection, {
    fields: [usageLedger.connectionId],
    references: [connection.id],
  }),
}));

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type NewUsageLedgerRow = typeof usageLedger.$inferInsert;
