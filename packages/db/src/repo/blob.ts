import { and, desc, eq } from "drizzle-orm";

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

/** This agent's blobs, newest first, removed ones included — the record, not the live set. */
export async function listBlobs(db: DbOrTx, scope: AgentScope): Promise<BlobRow[]> {
  return db.select().from(blob).where(inScope(scope)).orderBy(desc(blob.createdAt), desc(blob.id));
}
