import { and, asc, eq, inArray } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { connection, type NewConnection } from "../schema/connection";

/**
 * Query ownership for the connection aggregate (ADR 0007: a connection is the person's). Every
 * read and write takes `personId` in the SQL — one function is unscoped, and it is the proxy's.
 */

export type ConnectionRow = typeof connection.$inferSelect;

export async function insertConnection(db: DbOrTx, input: NewConnection): Promise<ConnectionRow> {
  const [row] = await db.insert(connection).values(input).returning();
  if (!row) throw new Error("Insert of connection returned no row");
  return row;
}

export async function findConnection(
  db: DbOrTx,
  personId: string,
  id: string,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .limit(1);
  return row ?? null;
}

/**
 * A connection by id and nothing else — **the proxy's read**, and the only unscoped one here. A
 * vendor call carries no session; the capability token's `person` claim is what the proxy compares
 * the row's `personId` against, and that comparison is the whole authorisation (ADR 0010). Do not
 * reach for this from a path that has a person: `findConnection` exists so a mis-scoped read comes
 * back empty instead of crossing persons.
 */
export async function findConnectionByIdUnscoped(
  db: DbOrTx,
  id: string,
): Promise<ConnectionRow | null> {
  const [row] = await db.select().from(connection).where(eq(connection.id, id)).limit(1);
  return row ?? null;
}

/** Every connection of a person, revoked ones included, oldest first. */
export async function listConnections(db: DbOrTx, personId: string): Promise<ConnectionRow[]> {
  return db
    .select()
    .from(connection)
    .where(eq(connection.personId, personId))
    .orderBy(asc(connection.createdAt), asc(connection.id));
}

/**
 * The subset of `ids` that are this person's connections — what setting an agent's scope reads
 * to refuse an id the person does not own. An empty `ids` is an empty answer, not a full scan.
 */
export async function findConnectionsByIds(
  db: DbOrTx,
  personId: string,
  ids: readonly string[],
): Promise<ConnectionRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(connection)
    .where(and(eq(connection.personId, personId), inArray(connection.id, [...ids])));
}

/**
 * Write the vault's ciphertext — never the fields — and the moment it was entered. A re-entry after
 * a revoke is a reconnection, so `revoked_at` clears in the same statement: the authored tools
 * bound to the vendor were left in place for exactly this (ADR 0007), and they re-ask from zero
 * because the approvals went with the revoke. Null means no such connection for this person.
 */
export async function setConnectionCredential(
  db: DbOrTx,
  personId: string,
  id: string,
  args: { ciphertext: Buffer; setAt: Date },
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set({ credentialCiphertext: args.ciphertext, credentialSetAt: args.setAt, revokedAt: null })
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .returning();
  return row ?? null;
}

/**
 * Revoke: clear every secret the row holds — the credential, the OAuth client secret, the refresh
 * state — and stamp the moment. The row itself stays, because its vendor slug is what keeps the
 * person's authored tools bound (ADR 0007) and because the ledger and the jobs reference it. The
 * approvals are the approval repo's to delete; the service does both in one transaction.
 */
export async function revokeConnection(
  db: DbOrTx,
  personId: string,
  id: string,
  at: Date,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set({
      credentialCiphertext: null,
      credentialSetAt: null,
      oauthClientSecretCiphertext: null,
      oauthRefreshState: null,
      revokedAt: at,
    })
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .returning();
  return row ?? null;
}
