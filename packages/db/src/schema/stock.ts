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

/**
 * The **stock catalogue** (ADR 0025; CONTEXT.md, *Stock tool*): the stock tools this release ships,
 * loaded from `@graft/stock`'s workspace at boot (`apps/server/src/boot.ts`, GRA-238) and global,
 * so no row names a person and no owner tier is carried. `schema.test.ts` holds these two tables
 * apart from the owned ones and pins that. A person reaches a stock tool by a copy into their
 * toolbox (`tool_version.stock_version_id`), never by a row here.
 *
 * One row per `(vendor, name)`, the identity the copy keeps; what changes from release to release
 * is a version.
 */
export const stockTool = pgTable(
  "stock_tool",
  {
    id: text("id").primaryKey(),
    /** The integration's vendor slug, the same value `connection.vendor` and `authored_tool.vendor` hold. */
    vendor: text("vendor").notNull(),
    /** Kebab-case; with the vendor, the wire name `<vendor>__<name>` the copy keeps. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("stock_tool_vendor_name_unique").on(table.vendor, table.name)],
);

/**
 * One version of a stock tool, appended when the workspace's files hash differently from every
 * version the tool has (`source_hash`), so an older release's replica appends nothing; never edited, numbered 1, 2, 3 … per tool. The current version is the highest
 * number. The definition is per version, since a fix may change the description or the schema, and
 * the module's files are kept on the row: a copy made from this version is written from them, so a
 * version stays copyable whatever release a replica runs (the workspace on disk is only the
 * current release's). The annotations are the check's, run when the version was appended, never
 * the manifest's declaration (ADR 0008).
 */
export const stockToolVersion = pgTable(
  "stock_tool_version",
  {
    id: text("id").primaryKey(),
    stockToolId: text("stock_tool_id")
      .notNull()
      .references(() => stockTool.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    /** A hash over every file of the tool's directory in the workspace, manifest and test input included. */
    sourceHash: text("source_hash").notNull(),
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    readOnly: boolean("read_only").notNull(),
    destructive: boolean("destructive").notNull(),
    /** Every host the module calls, as its manifest declares them; what a connection must reach (GRA-241). */
    hosts: text("hosts").array().notNull(),
    /** The module's files, `{ path, content }`, as the copy writes them into a toolbox. */
    files: jsonb("files").$type<{ path: string; content: string }[]>().notNull(),
    /** The fixed input the workspace's harness proves the tool with. */
    testInput: jsonb("test_input").$type<Record<string, unknown>>().notNull(),
    /** The check's result when the version was appended, as `tool_version.check_output` holds it. */
    checkOutput: jsonb("check_output").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("stock_tool_version_stock_tool_id_version_number_unique").on(
      table.stockToolId,
      table.versionNumber,
    ),
    index("stock_tool_version_stock_tool_id_idx").on(table.stockToolId),
  ],
);

export const stockToolRelations = relations(stockTool, ({ many }) => ({
  versions: many(stockToolVersion),
}));

export const stockToolVersionRelations = relations(stockToolVersion, ({ one }) => ({
  stockTool: one(stockTool, {
    fields: [stockToolVersion.stockToolId],
    references: [stockTool.id],
  }),
}));

export type StockTool = typeof stockTool.$inferSelect;
export type StockToolVersion = typeof stockToolVersion.$inferSelect;
export type NewStockToolVersion = typeof stockToolVersion.$inferInsert;
