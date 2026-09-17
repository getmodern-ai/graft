import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

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
  args: {
    ciphertext: Buffer;
    setAt: Date;
    /**
     * The authorization-code state written in the same statement as the record it describes
     * (ADR 0005): the tokens' expiry when a consent or a refresh wrote them, null when the person
     * re-entered the client secret and the old tokens went with it. Omitted, the column is left as
     * it is — a key-shaped scheme never touches it.
     */
    oauthRefreshState?: Record<string, unknown> | null;
  },
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set({
      credentialCiphertext: args.ciphertext,
      credentialSetAt: args.setAt,
      revokedAt: null,
      ...(args.oauthRefreshState === undefined
        ? {}
        : { oauthRefreshState: args.oauthRefreshState }),
    })
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .returning();
  return row ?? null;
}

/**
 * Replace an authorization-code connection's non-secret state alone — a consent started (the PKCE
 * verifier written for the callback to read), a refresh refused (the mark the console turns into
 * Reconnect). The credential is not touched: those two moments change what is known about the
 * tokens, not the tokens (ADR 0005). Null means no such connection for this person.
 */
export async function setConnectionOAuthState(
  db: DbOrTx,
  personId: string,
  id: string,
  state: Record<string, unknown> | null,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set({ oauthRefreshState: state })
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .returning();
  return row ?? null;
}

/**
 * Revoke: clear every secret the row holds — the credential, the OAuth client secret, the refresh
 * state — and stamp the moment. The row itself stays, because its vendor slug is what keeps the
 * person's authored tools bound (ADR 0007) and because the ledger and the jobs reference it. The
 * approvals are the approval repo's to delete; the service does both in one transaction. What the
 * row's provider holds outside Graft (`provider_ref`, ADR 0019) is **not** cleared here: the
 * service asks the provider to release it after the transaction, and `recordProviderRelease` writes
 * what came of that — the reference is what the release is by, and a failed one is retried from it.
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

/**
 * What the provider's release answered after a revoke (ADR 0019; GRA-59). Released: the reference
 * goes — the row is connected to nothing, and nothing outside Graft holds an account for it any
 * more — and a failure once recorded is cleared. Failed: the moment is stamped and the reference
 * kept, so the fact outlives the request and the console can offer a retry that knows which
 * account to release. Written only where the row is **still revoked and still carries the
 * reference that was released**: the release runs outside the revoke's transaction, and a link's
 * return may reconnect the row in between with a new reference, which this statement must neither
 * erase nor stamp. Null means no such row in that state — gone, another person's, or moved on.
 */
export async function recordProviderRelease(
  db: DbOrTx,
  personId: string,
  id: string,
  outcome: { released: true; ref: string } | { released: false; ref: string; at: Date },
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set(
      outcome.released
        ? { providerRef: null, providerReleaseFailedAt: null }
        : { providerReleaseFailedAt: outcome.at },
    )
    .where(
      and(
        eq(connection.id, id),
        eq(connection.personId, personId),
        eq(connection.providerRef, outcome.ref),
        isNotNull(connection.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * A relay provider's row connected — or reconnected — to what the provider now holds for it
 * (ADR 0019; GRA-59): the provider's reference written, `revoked_at` cleared in the same statement,
 * the reconnection a credential re-entry is for a keyring row (`setConnectionCredential`). No
 * credential is touched, because there is none here for such a row. Null means no such connection
 * for this person.
 */
export async function setConnectionProviderRef(
  db: DbOrTx,
  personId: string,
  id: string,
  providerRef: string,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connection)
    .set({ providerRef, revokedAt: null, providerReleaseFailedAt: null })
    .where(and(eq(connection.id, id), eq(connection.personId, personId)))
    .returning();
  return row ?? null;
}
