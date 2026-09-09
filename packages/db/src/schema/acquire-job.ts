import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { agent } from "./agent";
import { owned, ownedRecord } from "./columns";
import { connection } from "./connection";
import { authoredTool, toolVersion } from "./tool";

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
 *
 * The three clocks are the in-process runner's (GRA-29; `@graft/mcp`'s `acquire/runner.ts`):
 * `startedAt` when a runner claimed the job, `heartbeatAt` stamped while it works, `finishedAt` at
 * the end. A `running` job whose heartbeat has gone stale was in a process that died, and the next
 * runner claims it again — the claim is one statement, so two runners cannot both take it.
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
    /** What the agent already knew — an endpoint, a documentation URL — in its words; null when none. */
    hints: text("hints"),
    status: text("status", { enum: acquireJobStatus }).notNull().default("queued"),
    progress: jsonb("progress").$type<string[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    tokenSpend: integer("token_spend").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    traceRef: text("trace_ref"),
    startedAt: timestamp("started_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    finishedAt: timestamp("finished_at"),
    /** The tool the job published, once it has; `set null` so the record outlives the tool. */
    toolId: text("tool_id").references(() => authoredTool.id, { onDelete: "set null" }),
    ...owned(),
  },
  (table) => [
    index("acquire_job_agent_id_idx").on(table.agentId),
    index("acquire_job_connection_id_idx").on(table.connectionId),
    index("acquire_job_tool_id_idx").on(table.toolId),
    // The runner's roster: what is queued, and what is running with a heartbeat gone stale.
    index("acquire_job_status_heartbeat_at_idx").on(table.status, table.heartbeatAt),
  ],
);

/**
 * How an attempt ended: where in the loop the draft stopped. `running` until it ends; `passed` is the
 * one that promoted; `abandoned` is a draft the job left mid-way — the model gave up or a budget ran
 * out while the attempt was open.
 */
export const acquireAttemptOutcome = [
  "running",
  "passed",
  "check_refused",
  "proof_failed",
  "publish_refused",
  "dry_run_failed",
  "run_failed",
  "abandoned",
] as const;
export type AcquireAttemptOutcome = (typeof acquireAttemptOutcome)[number];

/** A file of a drafted module, as the attempt row keeps it. */
export type AcquireAttemptFile = { path: string; content: string };

/**
 * One draft inside an `acquire` job (ADR 0012, L1: candidates). Every module the model wrote is
 * kept — its files, where the check stopped it, the version the publish wrote and whose row carries
 * the dry-run report, the model's own account of what changed, what it cost — so the console can
 * show what was tried and a later miner can cluster why it failed (ADR 0012, L3). The files ride on
 * the row rather than only at `draftPath` because the drafts directory is the sandbox's and this
 * record is the person's.
 *
 * Carries `agent_id` beside `job_id` so every read takes the scope in the statement the way every
 * other agent-scoped table does (`repo/scope.ts`), with no join through the job.
 */
export const acquireAttempt = pgTable(
  "acquire_attempt",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => acquireJob.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** 1, 2, 3 … per job. */
    attemptNumber: integer("attempt_number").notNull(),
    /** Where the draft was written in the toolbox — `.drafts/<jobId>/a<N>`. */
    draftPath: text("draft_path").notNull(),
    files: jsonb("files").$type<AcquireAttemptFile[]>().notNull(),
    /** The check's result, or the publish's refusal, as it stood for this draft. */
    checkOutput: jsonb("check_output").$type<Record<string, unknown>>(),
    /** The version this draft published, whose row holds the dry-run report (`tool_version.dry_run_outcome`). */
    versionId: text("version_id").references(() => toolVersion.id, { onDelete: "set null" }),
    /** The model's one line on this draft — what it learned from the last outcome, what it changed. */
    diagnosis: text("diagnosis"),
    outcome: text("outcome", { enum: acquireAttemptOutcome }).notNull().default("running"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    finishedAt: timestamp("finished_at"),
    ...owned(),
  },
  (table) => [
    unique("acquire_attempt_job_id_attempt_number_unique").on(table.jobId, table.attemptNumber),
    index("acquire_attempt_job_id_idx").on(table.jobId),
    index("acquire_attempt_agent_id_idx").on(table.agentId),
    index("acquire_attempt_version_id_idx").on(table.versionId),
  ],
);

/**
 * What a trace line is about. `progress` is a line the agent relays; `model` is what the model
 * answered and what it cost; `docs`, `edit`, `check`, `proof`, `publish` and `dry_run` are the loop's
 * steps; `vendor_error` is a vendor's error body, credentials redacted; `diagnosis` is the model's
 * account of a failure; `result` is how the job ended.
 */
export const acquireTraceKind = [
  "progress",
  "model",
  "docs",
  "edit",
  "check",
  "proof",
  "vendor_error",
  "publish",
  "dry_run",
  "diagnosis",
  "result",
] as const;
export type AcquireTraceKind = (typeof acquireTraceKind)[number];

/**
 * The inner-loop trace of an `acquire` job, one line per step, in order (ADR 0012: every inner-loop
 * trace and every vendor error body, credentials redacted, recorded from day one). `text` is the
 * line; `data` is the step's structured payload — a dry-run report, a redacted error body, a check's
 * diagnostics; `redacted` says the redaction changed something, so a reader knows a `[redacted]` is
 * the store's and not the vendor's. Append-only.
 */
export const acquireTrace = pgTable(
  "acquire_trace",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => acquireJob.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    /** The attempt the line belongs to; null for a line about the job as a whole. */
    attemptNumber: integer("attempt_number"),
    /** 1, 2, 3 … per job — the order the console shows. */
    sequence: integer("sequence").notNull(),
    kind: text("kind", { enum: acquireTraceKind }).notNull(),
    text: text("text").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    redacted: boolean("redacted").notNull().default(false),
    ...ownedRecord(),
  },
  (table) => [
    unique("acquire_trace_job_id_sequence_unique").on(table.jobId, table.sequence),
    index("acquire_trace_job_id_idx").on(table.jobId),
    index("acquire_trace_agent_id_idx").on(table.agentId),
  ],
);

export const acquireJobRelations = relations(acquireJob, ({ one, many }) => ({
  agent: one(agent, { fields: [acquireJob.agentId], references: [agent.id] }),
  connection: one(connection, {
    fields: [acquireJob.connectionId],
    references: [connection.id],
  }),
  tool: one(authoredTool, { fields: [acquireJob.toolId], references: [authoredTool.id] }),
  attempts: many(acquireAttempt),
  traces: many(acquireTrace),
}));

export const acquireAttemptRelations = relations(acquireAttempt, ({ one }) => ({
  job: one(acquireJob, { fields: [acquireAttempt.jobId], references: [acquireJob.id] }),
  agent: one(agent, { fields: [acquireAttempt.agentId], references: [agent.id] }),
  version: one(toolVersion, {
    fields: [acquireAttempt.versionId],
    references: [toolVersion.id],
  }),
}));

export const acquireTraceRelations = relations(acquireTrace, ({ one }) => ({
  job: one(acquireJob, { fields: [acquireTrace.jobId], references: [acquireJob.id] }),
  agent: one(agent, { fields: [acquireTrace.agentId], references: [agent.id] }),
}));

export type AcquireJobRow = typeof acquireJob.$inferSelect;
export type NewAcquireJobRow = typeof acquireJob.$inferInsert;
export type AcquireAttemptRow = typeof acquireAttempt.$inferSelect;
export type NewAcquireAttemptRow = typeof acquireAttempt.$inferInsert;
export type AcquireTraceRow = typeof acquireTrace.$inferSelect;
export type NewAcquireTraceRow = typeof acquireTrace.$inferInsert;
