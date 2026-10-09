import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { stockToolVersion } from "../schema/stock";
import {
  authoredTool,
  type NewAuthoredTool,
  type NewToolVersion,
  toolVersion,
} from "../schema/tool";

/**
 * Query ownership for the toolbox: authored tools and their versions (ADR 0007: the toolbox is the
 * person's). Every statement takes `personId`; a version is reached through its tool, so the
 * version reads carry the person by a subquery on `authored_tool`.
 */

export type AuthoredToolRow = typeof authoredTool.$inferSelect;
export type ToolVersionRow = typeof toolVersion.$inferSelect;
export type AuthoredToolPatch = Partial<
  Pick<
    AuthoredToolRow,
    "description" | "inputSchema" | "readOnly" | "destructive" | "defaultConnectionId"
  >
>;

/** The tool ids a person owns — the subquery every version statement scopes by. */
function ownedToolIds(db: DbOrTx, personId: string, toolId: string) {
  return db
    .select({ id: authoredTool.id })
    .from(authoredTool)
    .where(and(eq(authoredTool.id, toolId), eq(authoredTool.personId, personId)));
}

export async function insertAuthoredTool(
  db: DbOrTx,
  input: NewAuthoredTool,
): Promise<AuthoredToolRow> {
  const [row] = await db.insert(authoredTool).values(input).returning();
  if (!row) throw new Error("Insert of authored tool returned no row");
  return row;
}

/** Every tool in the person's toolbox, demoted ones included — `find_tool`'s search space (ADR 0009). */
export async function listAuthoredTools(db: DbOrTx, personId: string): Promise<AuthoredToolRow[]> {
  return db
    .select()
    .from(authoredTool)
    .where(eq(authoredTool.personId, personId))
    .orderBy(asc(authoredTool.vendor), asc(authoredTool.name));
}

/** One tool by the triple that identifies it — (person, vendor, name). */
export async function findAuthoredTool(
  db: DbOrTx,
  personId: string,
  key: { vendor: string; name: string },
): Promise<AuthoredToolRow | null> {
  const [row] = await db
    .select()
    .from(authoredTool)
    .where(
      and(
        eq(authoredTool.personId, personId),
        eq(authoredTool.vendor, key.vendor),
        eq(authoredTool.name, key.name),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findAuthoredToolById(
  db: DbOrTx,
  personId: string,
  id: string,
): Promise<AuthoredToolRow | null> {
  const [row] = await db
    .select()
    .from(authoredTool)
    .where(and(eq(authoredTool.id, id), eq(authoredTool.personId, personId)))
    .limit(1);
  return row ?? null;
}

/**
 * One tool locked for the caller's transaction (`SELECT … FOR UPDATE`): the stock advance reads it
 * so two reaches of one copy at once serialise, and the second decides over the first's version
 * (`@graft/publish`'s `advanceStockCopy`, GRA-242).
 */
export async function findAuthoredToolForUpdate(
  db: DbOrTx,
  personId: string,
  id: string,
): Promise<AuthoredToolRow | null> {
  const [row] = await db
    .select()
    .from(authoredTool)
    .where(and(eq(authoredTool.id, id), eq(authoredTool.personId, personId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** A republish's changes to the tool itself: the prose, the schema, the derived annotations. */
export async function updateAuthoredTool(
  db: DbOrTx,
  personId: string,
  id: string,
  patch: AuthoredToolPatch,
): Promise<AuthoredToolRow | null> {
  const [row] = await db
    .update(authoredTool)
    .set(patch)
    .where(and(eq(authoredTool.id, id), eq(authoredTool.personId, personId)))
    .returning();
  return row ?? null;
}

export async function insertToolVersion(
  db: DbOrTx,
  input: NewToolVersion,
): Promise<ToolVersionRow> {
  const [row] = await db.insert(toolVersion).values(input).returning();
  if (!row) throw new Error("Insert of tool version returned no row");
  return row;
}

/** A tool's versions, newest first — nothing is ever deleted, so this is the whole history (ADR 0009). */
export async function listToolVersions(
  db: DbOrTx,
  personId: string,
  toolId: string,
): Promise<ToolVersionRow[]> {
  return db
    .select()
    .from(toolVersion)
    .where(inArray(toolVersion.toolId, ownedToolIds(db, personId, toolId)))
    .orderBy(desc(toolVersion.versionNumber));
}

/**
 * One version's origin, for the stock advance and the console's history (ADR 0025; GRA-242): the
 * stock tool and version it was copied from, with that stock version's number, or nulls for a
 * version the agent published.
 */
export type ToolVersionOrigin = {
  toolId: string;
  versionId: string;
  versionNumber: number;
  createdAt: Date;
  stockToolId: string | null;
  stockVersionId: string | null;
  /** The stock version's own number (`stock_tool_version.version_number`); null when not from stock. */
  stockVersionNumber: number | null;
};

/**
 * The origins of every version of the person's tools, or of one tool's when `toolId` is given, in
 * one statement: the person's tools by subquery, the stock number by a left join on the global
 * catalogue. Ordered by tool, then newest first.
 */
export async function listToolVersionOrigins(
  db: DbOrTx,
  personId: string,
  toolId?: string,
): Promise<ToolVersionOrigin[]> {
  const owned = db
    .select({ id: authoredTool.id })
    .from(authoredTool)
    .where(
      toolId === undefined
        ? eq(authoredTool.personId, personId)
        : and(eq(authoredTool.id, toolId), eq(authoredTool.personId, personId)),
    );
  return db
    .select({
      toolId: toolVersion.toolId,
      versionId: toolVersion.id,
      versionNumber: toolVersion.versionNumber,
      createdAt: toolVersion.createdAt,
      stockToolId: toolVersion.stockToolId,
      stockVersionId: toolVersion.stockVersionId,
      stockVersionNumber: stockToolVersion.versionNumber,
    })
    .from(toolVersion)
    .leftJoin(stockToolVersion, eq(stockToolVersion.id, toolVersion.stockVersionId))
    .where(inArray(toolVersion.toolId, owned))
    .orderBy(asc(toolVersion.toolId), desc(toolVersion.versionNumber));
}

export async function findToolVersion(
  db: DbOrTx,
  personId: string,
  versionId: string,
): Promise<ToolVersionRow | null> {
  const [row] = await db
    .select()
    .from(toolVersion)
    .where(
      and(
        eq(toolVersion.id, versionId),
        inArray(
          toolVersion.toolId,
          db
            .select({ id: authoredTool.id })
            .from(authoredTool)
            .where(eq(authoredTool.personId, personId)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Move the pointer. The version must belong to the tool — the subquery says so in the statement,
 * so a version id from another tool, or another person, moves nothing. Null when nothing landed.
 */
export async function setCurrentToolVersion(
  db: DbOrTx,
  personId: string,
  toolId: string,
  versionId: string,
): Promise<AuthoredToolRow | null> {
  const [row] = await db
    .update(authoredTool)
    .set({ currentVersionId: versionId })
    .where(
      and(
        eq(authoredTool.id, toolId),
        eq(authoredTool.personId, personId),
        inArray(
          authoredTool.id,
          db
            .select({ id: toolVersion.toolId })
            .from(toolVersion)
            .where(eq(toolVersion.id, versionId)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Record how a dry run of one version ended (ADR 0012, L0: the outcome per version). Guarded on
 * the version id, so a report for one version cannot land on the row of the next.
 */
export async function recordToolVersionDryRun(
  db: DbOrTx,
  personId: string,
  versionId: string,
  outcome: { report: Record<string, unknown>; at: Date; writesInvolved: boolean },
): Promise<ToolVersionRow | null> {
  const [row] = await db
    .update(toolVersion)
    .set({
      dryRunOutcome: outcome.report,
      dryRunAt: outcome.at,
      writesInvolved: outcome.writesInvolved,
    })
    .where(
      and(
        eq(toolVersion.id, versionId),
        inArray(
          toolVersion.toolId,
          db
            .select({ id: authoredTool.id })
            .from(authoredTool)
            .where(eq(authoredTool.personId, personId)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}
