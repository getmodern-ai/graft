import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned } from "./columns";
import { connection } from "./connection";

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
 * answer is used once. `connectionId` is the one fact lifted out of the payload into a column: which
 * connection the ask is about, when it is about one, so a revoke can close every open ask for it in
 * one statement without reading the JSON (ADR 0007; `repo/pending-action.ts`).
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
    /**
     * The connection the ask is about — a tool's, a build's, a credential re-entry's — or null for
     * an ask that has none yet, such as a proposal for a connection that does not exist until the
     * person creates it. Set null rather than cascade if the row ever goes: the ask's history is
     * the agent's, not the connection's.
     */
    connectionId: text("connection_id").references(() => connection.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    answeredAt: timestamp("answered_at"),
    answer: jsonb("answer").$type<Record<string, unknown>>(),
    consumedAt: timestamp("consumed_at"),
    ...owned(),
  },
  (table) => [
    index("pending_action_agent_id_idx").on(table.agentId),
    // "Every open ask about this connection" — what a revoke closes (ADR 0007).
    index("pending_action_connection_id_idx").on(table.connectionId),
  ],
);

export const pendingActionRelations = relations(pendingAction, ({ one }) => ({
  agent: one(agent, { fields: [pendingAction.agentId], references: [agent.id] }),
}));

export type PendingActionRow = typeof pendingAction.$inferSelect;
export type NewPendingActionRow = typeof pendingAction.$inferInsert;
