import { relations } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned } from "./columns";
import { connection } from "./connection";

export const acquireJobStatus = ["queued", "running", "succeeded", "failed"] as const;
export type AcquireJobStatus = (typeof acquireJobStatus)[number];

/**
 * An **acquire** job: the asynchronous run in which Graft's model authors a tool (CONTEXT.md).
 * The meta-tool creates the row and returns its id at once; `acquire_status` reads it back; the
 * inner loop appends progress lines and counts attempts and tokens as it goes (ADR 0012: every
 * trace recorded from the first release, because L2 and L3 are built on this data).
 *
 * `progress` is an array of lines the agent relays to the person; `result` is the published
 * tool's identity on success or the last diagnostics on failure; `traceRef` points at the model
 * trace in whatever observability tool is configured, when one is.
 */
export const acquireJob = pgTable(
  "acquire_job",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connection.id, { onDelete: "cascade" }),
    /** What the agent asked for, in its words. */
    goal: text("goal").notNull(),
    status: text("status", { enum: acquireJobStatus }).notNull().default("queued"),
    progress: jsonb("progress").$type<string[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    tokenSpend: integer("token_spend").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    traceRef: text("trace_ref"),
    ...owned(),
  },
  (table) => [
    index("acquire_job_agent_id_idx").on(table.agentId),
    index("acquire_job_connection_id_idx").on(table.connectionId),
  ],
);

export const acquireJobRelations = relations(acquireJob, ({ one }) => ({
  agent: one(agent, { fields: [acquireJob.agentId], references: [agent.id] }),
  connection: one(connection, {
    fields: [acquireJob.connectionId],
    references: [connection.id],
  }),
}));

export type AcquireJobRow = typeof acquireJob.$inferSelect;
export type NewAcquireJobRow = typeof acquireJob.$inferInsert;
