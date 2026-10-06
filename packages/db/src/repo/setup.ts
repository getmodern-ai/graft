import { eq, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { user } from "../schema/auth";
import { connection } from "../schema/connection";
import { type NewSetupRow, setup } from "../schema/setup";
import { authoredTool } from "../schema/tool";

/**
 * Query ownership for a person's Setup record (ADR 0024; ADR 0007: the record is the person's). One
 * row per person, so every statement is on `person_id`, and the count the show rule reads names
 * the person in both of its subqueries. There is no unscoped read: nothing but the person's own
 * console asks where their Setup stands.
 */

export type { NewSetupRow, SetupRow } from "../schema/setup";

/** What a write sets: every column but the person, each optional, so an absent key keeps its value. */
export type SetupPatch = Partial<
  Omit<NewSetupRow, "personId" | "owner" | "createdAt" | "updatedAt">
>;

export async function findSetup(db: DbOrTx, personId: string) {
  const [row] = await db.select().from(setup).where(eq(setup.personId, personId)).limit(1);
  return row ?? null;
}

/**
 * The person's record, locked (`SELECT … FOR UPDATE`), made first if there is none: the start's
 * opening read, so two starts from one person (a double click, two tabs) serialise on the row and
 * the second sees the agent the first minted rather than minting another. The insert does nothing
 * when the row exists; a transaction that then refuses rolls the made row back with it. Only
 * meaningful inside a transaction.
 */
export async function lockSetup(db: DbOrTx, personId: string) {
  await db.insert(setup).values({ personId }).onConflictDoNothing({ target: setup.personId });
  const [row] = await db
    .select()
    .from(setup)
    .where(eq(setup.personId, personId))
    .limit(1)
    .for("update");
  if (!row) throw new Error("Lock of setup returned no row");
  return row;
}

/**
 * Write the record: made with the patch when absent, the patch's keys set on it when present — the
 * rest keep what they held, so a skip leaves the agent and the step where they were.
 *
 * `updated_at` moves forward by at least a millisecond on every write, never merely to the clock:
 * the connect route's second routing takes the value it saw as a compare-and-swap token (GRA-206,
 * `fromVendorAt` in `@graft/core`'s `setup.service.ts`), and two writes in one millisecond, or a
 * clock stepped back, must still differ as a JavaScript `Date` reads them.
 */
export async function saveSetup(db: DbOrTx, personId: string, patch: SetupPatch) {
  const now = sql.param(new Date(), setup.updatedAt);
  const [row] = await db
    .insert(setup)
    .values({ ...patch, personId })
    .onConflictDoUpdate({
      target: setup.personId,
      set: {
        ...patch,
        updatedAt: sql`greatest(${now}, ${setup.updatedAt} + interval '1 millisecond')`,
      },
    })
    .returning();
  if (!row) throw new Error("Upsert of setup returned no row");
  return row;
}

/** What the show rule weighs beside the record: work the person has already done by hand. */
export type SetupWork = { connections: number; tools: number };

/**
 * The person's connections (revoked ones included: the row is still theirs, ADR 0007) and authored
 * tools, counted in one statement, each subquery under the person.
 */
export async function countSetupWork(db: DbOrTx, personId: string): Promise<SetupWork> {
  const [row] = await db
    .select({
      connections: db.$count(connection, eq(connection.personId, personId)),
      tools: db.$count(authoredTool, eq(authoredTool.personId, personId)),
    })
    .from(user)
    .where(eq(user.id, personId))
    .limit(1);
  return { connections: Number(row?.connections ?? 0), tools: Number(row?.tools ?? 0) };
}
