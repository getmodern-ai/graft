import { and, asc, desc, eq, gt, inArray, isNull, sum } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { blob, type NewBlobRow } from "../schema/blob";
import type { AgentScope } from "./scope";

/**
 * Query ownership for the blob rows (ADR 0023; GRA-186). The row carries both ids of the scope, so
 * every read names the person *and* the agent directly in its predicate (ADR 0007), and every insert
 * carries them in its values: a blob is the agent's, and a read under another agent's pair, or
 * another person's, matches nothing rather than disclosing anything. `repo/scope.test.ts` pins the
 * rendered statements.
 */

export type BlobRow = typeof blob.$inferSelect;

/** Whether this row's pair is the scope's — the predicate every read here takes. */
function inScope(scope: AgentScope) {
  return and(eq(blob.agentId, scope.agentId), eq(blob.personId, scope.personId));
}

/**
 * The rows for every blob one run wrote, in one statement — the ledger the runner returned beside
 * the result (`packages/mcp/src/run.ts`). Each row names its person and agent; the caller has put
 * the scope's pair on every one. An empty ledger writes nothing.
 */
export async function insertBlobs(db: DbOrTx, rows: readonly NewBlobRow[]): Promise<BlobRow[]> {
  if (rows.length === 0) return [];
  // Idempotent on the id: a finished detached run is polled more than once and every poll carries
  // the same ledger (GRA-186; `wait_for_process` in `@graft/mcp`), so a row already there is left
  // as it was and only the rows this call added come back.
  return db
    .insert(blob)
    .values([...rows])
    .onConflictDoNothing({ target: blob.id })
    .returning();
}

/** One blob by id, this agent's and this person's, or null — the door's read (GRA-187). */
export async function findBlob(
  db: DbOrTx,
  scope: AgentScope,
  blobId: string,
): Promise<BlobRow | null> {
  const [row] = await db
    .select()
    .from(blob)
    .where(and(eq(blob.id, blobId), inScope(scope)))
    .limit(1);
  return row ?? null;
}

/**
 * The rows among `blobIds` that are this agent's and this person's, in one statement: the door's
 * read for every ref an input names (GRA-187). An id with no row here is absent from the answer,
 * whether nobody wrote it or another agent did: the two are one answer by design (ADR 0023, "never
 * saying whose"). No ids is no statement.
 */
export async function findBlobs(
  db: DbOrTx,
  scope: AgentScope,
  blobIds: readonly string[],
): Promise<BlobRow[]> {
  if (blobIds.length === 0) return [];
  return db
    .select()
    .from(blob)
    .where(and(inArray(blob.id, [...blobIds]), inScope(scope)));
}

/**
 * How many bytes of blobs this agent holds live at `now`: rows not yet removed whose expiry is
 * still ahead, summed in one statement: the door's quota read (GRA-187, `blob_quota`). A row past
 * its expiry stops counting whether or not the sweep has reached it, so the quota frees itself on
 * the TTL alone. Zero for an agent that has never written.
 */
export async function sumLiveBlobBytes(db: DbOrTx, scope: AgentScope, now: Date): Promise<number> {
  const [row] = await db
    .select({ bytes: sum(blob.bytes) })
    .from(blob)
    .where(and(inScope(scope), isNull(blob.removedAt), gt(blob.expiresAt, now)));
  // `sum` over a bigint comes back as Postgres's numeric, a string; null when no row matched.
  return Number(row?.bytes ?? 0);
}

/** This agent's blobs, newest first, removed ones included — the record, not the live set. */
export async function listBlobs(db: DbOrTx, scope: AgentScope): Promise<BlobRow[]> {
  return db.select().from(blob).where(inScope(scope)).orderBy(desc(blob.createdAt), desc(blob.id));
}

/**
 * This agent's blobs whose directory the sweep has not yet removed, soonest to expire first: what
 * the sweep judges (GRA-189). a row past its expiry is removed or marked, a live one kept. A removed
 * row is out of the sweep's hands and stays for the door alone, which is why it is not read here
 * and the read stays bounded by what is live rather than by what was ever written.
 */
export async function listUnremovedBlobs(db: DbOrTx, scope: AgentScope): Promise<BlobRow[]> {
  return db
    .select()
    .from(blob)
    .where(and(inScope(scope), isNull(blob.removedAt)))
    .orderBy(asc(blob.expiresAt), asc(blob.id));
}

/**
 * Record that the sweep removed this blob's directory (or found it already gone): `removed_at`
 * set once, under the scope, on a row not yet marked. Answers whether a row changed, so a second
 * sweep over the same row is a no-op and not a second removal.
 */
export async function markBlobRemoved(
  db: DbOrTx,
  scope: AgentScope,
  blobId: string,
  removedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(blob)
    .set({ removedAt })
    .where(and(eq(blob.id, blobId), inScope(scope), isNull(blob.removedAt)))
    .returning({ id: blob.id });
  return rows.length > 0;
}

/**
 * The row the sweep writes, from the sidecar, for a committed directory it found no row for: what a
 * run killed after its rename and before the server read the envelope leaves (ADR 0023). Nothing on conflict:
 * the row may have landed meanwhile from the run itself, or be a removed row whose directory came
 * back, and the sweep reads the null as "not mine to write" (`@graft/core`'s `adoptBlob`).
 */
export async function insertAdoptedBlob(db: DbOrTx, row: NewBlobRow): Promise<BlobRow | null> {
  const [inserted] = await db.insert(blob).values(row).onConflictDoNothing().returning();
  return inserted ?? null;
}
