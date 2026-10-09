import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import {
  type NewStockToolVersion,
  type StockTool,
  type StockToolVersion,
  stockTool,
  stockToolVersion,
} from "../schema/stock";

/**
 * The stock catalogue's statements (ADR 0025; GRA-238). **Deliberately unscoped**: the catalogue
 * belongs to no person, so no statement here takes one, and `repo/scope.test.ts` pins each by name
 * beside the other unscoped reads (the proxy's connection read, the sweep's rosters, the boot's
 * count). A person's copy of a stock tool is an ordinary `authored_tool` and is read through
 * `repo/tool.ts`, under the person.
 */

export type StockToolRow = StockTool;
export type StockToolVersionRow = StockToolVersion;

/** A stock tool beside its current version, the one with the highest number. */
export type CurrentStockTool = { tool: StockToolRow; version: StockToolVersionRow };

/** The advisory lock the boot's load holds for its transaction, so two replicas append a version once. */
export async function lockStockCatalogue(db: DbOrTx): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${"graft:stock-catalogue"}))`);
}

/** The tool's row if new; nothing when `(vendor, name)` is already in the catalogue. */
export async function insertStockTool(
  db: DbOrTx,
  input: { id: string; vendor: string; name: string },
): Promise<StockToolRow | null> {
  const [row] = await db
    .insert(stockTool)
    .values(input)
    .onConflictDoNothing({ target: [stockTool.vendor, stockTool.name] })
    .returning();
  return row ?? null;
}

export async function findStockTool(
  db: DbOrTx,
  key: { vendor: string; name: string },
): Promise<StockToolRow | null> {
  const [row] = await db
    .select()
    .from(stockTool)
    .where(and(eq(stockTool.vendor, key.vendor), eq(stockTool.name, key.name)))
    .limit(1);
  return row ?? null;
}

/** A tool's highest version, or null for a tool with none yet. */
export async function findLatestStockToolVersion(
  db: DbOrTx,
  stockToolId: string,
): Promise<StockToolVersionRow | null> {
  const [row] = await db
    .select()
    .from(stockToolVersion)
    .where(eq(stockToolVersion.stockToolId, stockToolId))
    .orderBy(desc(stockToolVersion.versionNumber))
    .limit(1);
  return row ?? null;
}

export async function insertStockToolVersion(
  db: DbOrTx,
  input: NewStockToolVersion,
): Promise<StockToolVersionRow> {
  const [row] = await db.insert(stockToolVersion).values(input).returning();
  if (!row) throw new Error("Insert of stock tool version returned no row");
  return row;
}

/** `version_number` equal to the tool's highest, as one predicate both reads share. */
function isCurrentVersion() {
  return eq(
    stockToolVersion.versionNumber,
    sql`(select max("v"."version_number") from ${stockToolVersion} "v" where "v"."stock_tool_id" = ${stockToolVersion.stockToolId})`,
  );
}

/** Every stock tool at its current version: `find_tool`'s stock search space. */
export async function listCurrentStockTools(db: DbOrTx): Promise<CurrentStockTool[]> {
  const rows = await db
    .select({ tool: stockTool, version: stockToolVersion })
    .from(stockToolVersion)
    .innerJoin(stockTool, eq(stockTool.id, stockToolVersion.stockToolId))
    .where(isCurrentVersion())
    .orderBy(asc(stockTool.vendor), asc(stockTool.name));
  return rows;
}

/** One integration's stock tools at their current versions, by vendor slug: the console's list. */
export async function listCurrentStockToolsForVendor(
  db: DbOrTx,
  vendor: string,
): Promise<CurrentStockTool[]> {
  return db
    .select({ tool: stockTool, version: stockToolVersion })
    .from(stockToolVersion)
    .innerJoin(stockTool, eq(stockTool.id, stockToolVersion.stockToolId))
    .where(and(eq(stockTool.vendor, vendor), isCurrentVersion()))
    .orderBy(asc(stockTool.name));
}

/** One stock tool at its current version, by the key the copy keeps; null when the catalogue has none. */
export async function findCurrentStockTool(
  db: DbOrTx,
  key: { vendor: string; name: string },
): Promise<CurrentStockTool | null> {
  const [row] = await db
    .select({ tool: stockTool, version: stockToolVersion })
    .from(stockToolVersion)
    .innerJoin(stockTool, eq(stockTool.id, stockToolVersion.stockToolId))
    .where(and(eq(stockTool.vendor, key.vendor), eq(stockTool.name, key.name), isCurrentVersion()))
    .orderBy(desc(stockToolVersion.versionNumber))
    .limit(1);
  return row ?? null;
}
