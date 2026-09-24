import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { acquireJob } from "./acquire-job";
import { agent } from "./agent";
import { user } from "./auth";
import { owned } from "./columns";
import { connection } from "./connection";
import { pendingAction } from "./pending-action";
import { authoredTool } from "./tool";

/**
 * The steps of **Setup** (CONTEXT.md; ADR 0024) in the order a person walks them, and `completed`
 * after the last. The column holds the step the person has *reached*: the harness step writes
 * `vendor`, and each later step writes the one after it (GRA-206 onwards). Spelled here because the
 * schema imports nothing of `@graft/core`; the core's rules import the type
 * (`@graft/core/setup/setup.rules`).
 */
export const setupStep = [
  "harness",
  "vendor",
  "connect",
  "goal",
  "building",
  "result",
  "finish",
  "completed",
] as const;
export type SetupStep = (typeof setupStep)[number];

/**
 * The harnesses Setup offers (GRA-202, user story 3). The data each carries, its kind and its
 * label, is `@graft/core/setup/harness`'s, whose test asserts the two lists equal.
 */
export const setupHarness = [
  "claude",
  "chatgpt",
  "claude-code",
  "codex",
  "hermes",
  "openclaw",
  "other",
] as const;
export type SetupHarness = (typeof setupHarness)[number];

/**
 * A person's **Setup** record (ADR 0024): one row per person, so the primary key is the person, and
 * a reload resumes on the step it names with the same agent, connection and job (GRA-202, user
 * story 25). Every reference is `set null` on delete, so the record outlives what it points at and
 * the console reads a gone agent as "back to the harness step" rather than as a missing row.
 *
 * `harness` is what the person picked; null when Setup adopted an agent that already existed (one
 * active agent, or the one the person picked among several), whose harness was connected before
 * Setup ever showed. `started_at` is null for a person who skipped before starting; `skipped_at`
 * and `completed_at` are what the show rule reads (`shouldShowSetup`).
 */
export const setup = pgTable(
  "setup",
  {
    personId: text("person_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    step: text("step", { enum: setupStep }).notNull().default("harness"),
    harness: text("harness", { enum: setupHarness }),
    /** The agent Setup runs as: minted at the harness step, or adopted. */
    agentId: text("agent_id").references(() => agent.id, { onDelete: "set null" }),
    /** The open connection ask the connect step made (GRA-206). */
    pendingActionId: text("pending_action_id").references(() => pendingAction.id, {
      onDelete: "set null",
    }),
    /** The connection the ask made, learned when Setup's state is next read (GRA-206). */
    connectionId: text("connection_id").references(() => connection.id, { onDelete: "set null" }),
    /** The acquire job the build step started. */
    acquireJobId: text("acquire_job_id").references(() => acquireJob.id, { onDelete: "set null" }),
    /** The authored tool the job published. */
    toolId: text("tool_id").references(() => authoredTool.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    skippedAt: timestamp("skipped_at"),
    ...owned(),
  },
  (table) => [
    index("setup_agent_id_idx").on(table.agentId),
    index("setup_pending_action_id_idx").on(table.pendingActionId),
    index("setup_connection_id_idx").on(table.connectionId),
    index("setup_acquire_job_id_idx").on(table.acquireJobId),
    index("setup_tool_id_idx").on(table.toolId),
  ],
);

export const setupRelations = relations(setup, ({ one }) => ({
  person: one(user, { fields: [setup.personId], references: [user.id] }),
  agent: one(agent, { fields: [setup.agentId], references: [agent.id] }),
}));

export type SetupRow = typeof setup.$inferSelect;
export type NewSetupRow = typeof setup.$inferInsert;
