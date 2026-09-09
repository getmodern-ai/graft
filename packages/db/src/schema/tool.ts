import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { acquireJob } from "./acquire-job";
import { user } from "./auth";
import { owned, ownedRecord } from "./columns";
import { connection } from "./connection";

/**
 * An **authored tool**: a module of code Graft's model wrote against a vendor, versioned in the
 * person's toolbox and promoted per agent (CONTEXT.md; ADR 0003, ADR 0007).
 *
 * **Postgres holds a pointer, never code.** The module lives in the toolbox at the version's
 * `path`; this row carries what the MCP server needs to *list* the tool — the name and
 * description the model reads, the input schema a call is validated against, the annotations the
 * check derived — and which version the pointer currently names. A publish inserts a version row
 * and moves `currentVersionId`; earlier versions stay, so a run that loaded one finishes on it
 * while the next opens the new one, and nothing is ever deleted by the system (ADR 0009).
 *
 * Bound to a **vendor slug**, never a connection row (ADR 0007): revoking a connection clears its
 * credential and approvals and leaves these rows, which re-ask after reconnection.
 * `defaultConnectionId` is the connection the tool was authored against — a default binding for
 * the exec, `set null` so a deleted connection leaves the tool in place.
 */
export const authoredTool = pgTable(
  "authored_tool",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The same value `connection.vendor` holds. */
    vendor: text("vendor").notNull(),
    /** Kebab-case (`@graft/core`'s `isKebabCase`); with the person and the vendor, the tool's identity. */
    name: text("name").notNull(),
    /** Model-written prose, which is why the approval card says who wrote it (ADR 0008). */
    description: text("description").notNull(),
    /** A JSON Schema object (`type: "object"`); the MCP server validates every call against it. */
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    /**
     * The version the tool currently runs as. Null between the tool's insert and its first
     * version's — a publish writes the version, then moves this. A circular reference with
     * `tool_version.tool_id`, which Postgres allows and drizzle types through `AnyPgColumn`.
     */
    currentVersionId: text("current_version_id").references((): AnyPgColumn => toolVersion.id, {
      onDelete: "set null",
    }),
    /**
     * The annotations the check derived from the HTTP methods the module uses — never taken from
     * the model's own declaration (ADR 0008). `readOnly` is what lets a call pass without asking;
     * `destructive` is what makes it ask every time. Emitted as MCP's `readOnlyHint` and
     * `destructiveHint` so a harness that gates on annotations agrees with Graft.
     */
    readOnly: boolean("read_only").notNull(),
    destructive: boolean("destructive").notNull(),
    defaultConnectionId: text("default_connection_id").references(() => connection.id, {
      onDelete: "set null",
    }),
    ...owned(),
  },
  (table) => [
    /** One tool per (person, vendor, name) — GRA-1, "Tenancy and the schema". */
    unique("authored_tool_person_id_vendor_name_unique").on(
      table.personId,
      table.vendor,
      table.name,
    ),
    index("authored_tool_person_id_idx").on(table.personId),
    index("authored_tool_current_version_id_idx").on(table.currentVersionId),
    index("authored_tool_default_connection_id_idx").on(table.defaultConnectionId),
  ],
);

/**
 * One published version of a tool: where it is in the toolbox, what it was made of, and what the
 * check and the dry run said about it (ADR 0012, L0: the outcome stored per version, from the
 * first release). Append-only — a republish is a new row and a pointer move, never an edit.
 */
export const toolVersion = pgTable(
  "tool_version",
  {
    id: text("id").primaryKey(),
    toolId: text("tool_id")
      .notNull()
      .references(() => authoredTool.id, { onDelete: "cascade" }),
    /** 1, 2, 3 … per tool; the directory name under the tool in the toolbox. */
    versionNumber: integer("version_number").notNull(),
    /** The version's directory in the toolbox, e.g. `unleashed/create-order/v3`. */
    path: text("path").notNull(),
    /** A hash of the module's source files, so two versions with the same code are recognisable. */
    sourceHash: text("source_hash").notNull(),
    /**
     * A hash of the lockfile the install step wrote, when the module declares dependencies
     * (ADR 0013: packages install at publish, vendored into the version). Null for a module with
     * none.
     */
    lockfileHash: text("lockfile_hash"),
    /** The check's result — refusals, advice and the derived annotations — as it was at publish. */
    checkOutput: jsonb("check_output").$type<Record<string, unknown>>().notNull(),
    /** The dry-run report, when the version was dry-run, and the time it was. */
    dryRunOutcome: jsonb("dry_run_outcome").$type<Record<string, unknown>>(),
    dryRunAt: timestamp("dry_run_at"),
    /** Whether the dry run previewed any write — the fact ADR 0008's first-call ask turns on. */
    writesInvolved: boolean("writes_involved").notNull().default(false),
    /** The `acquire` job that published this version, when one did; a person's own publish has none. */
    publisherJobId: text("publisher_job_id").references(() => acquireJob.id, {
      onDelete: "set null",
    }),
    ...ownedRecord(),
  },
  (table) => [
    unique("tool_version_tool_id_version_number_unique").on(table.toolId, table.versionNumber),
    index("tool_version_tool_id_idx").on(table.toolId),
    index("tool_version_publisher_job_id_idx").on(table.publisherJobId),
  ],
);

export const authoredToolRelations = relations(authoredTool, ({ one, many }) => ({
  person: one(user, { fields: [authoredTool.personId], references: [user.id] }),
  currentVersion: one(toolVersion, {
    fields: [authoredTool.currentVersionId],
    references: [toolVersion.id],
  }),
  defaultConnection: one(connection, {
    fields: [authoredTool.defaultConnectionId],
    references: [connection.id],
  }),
  versions: many(toolVersion),
}));

export const toolVersionRelations = relations(toolVersion, ({ one }) => ({
  tool: one(authoredTool, { fields: [toolVersion.toolId], references: [authoredTool.id] }),
  publisherJob: one(acquireJob, {
    fields: [toolVersion.publisherJobId],
    references: [acquireJob.id],
  }),
}));

export type AuthoredTool = typeof authoredTool.$inferSelect;
export type NewAuthoredTool = typeof authoredTool.$inferInsert;
export type ToolVersion = typeof toolVersion.$inferSelect;
export type NewToolVersion = typeof toolVersion.$inferInsert;
