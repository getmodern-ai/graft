import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned } from "./columns";

/**
 * A **pending action**: the durable record behind a handoff URL (ADR 0006) — an approval the
 * person was not there to answer, a connection the agent proposed, a credential to re-enter. The
 * agent's turn ends; the person answers from the console hours later; the waiting tool resumes
 * on the answer or returns a clear refusal when the record expires. Durable in Postgres rather
 * than in one process's memory, on the evidence ADR 0006 cites.
 *
 * `kind` and `payload` are the meta-tool's to define — an approval carries a tool id, a
 * connection proposal carries hosts and a scheme — and this table stores them without reading
 * them. `answer` is what the person said, `consumedAt` is the waiting tool having read it, so an
 * answer is used once.
 */
export const pendingAction = pgTable(
  "pending_action",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    answeredAt: timestamp("answered_at"),
    answer: jsonb("answer").$type<Record<string, unknown>>(),
    consumedAt: timestamp("consumed_at"),
    ...owned(),
  },
  (table) => [index("pending_action_agent_id_idx").on(table.agentId)],
);

export const pendingActionRelations = relations(pendingAction, ({ one }) => ({
  agent: one(agent, { fields: [pendingAction.agentId], references: [agent.id] }),
}));

export type PendingActionRow = typeof pendingAction.$inferSelect;
export type NewPendingActionRow = typeof pendingAction.$inferInsert;
