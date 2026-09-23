import type { AgentScope } from "@graft/core";
import { type BlobLedgerEntry, blobIdOf } from "@graft/runner";

import { recordWrittenBlobs } from "./blobs";
import type { McpDeps } from "./deps";

/**
 * The record is the rule, the environment is advice (GRA-200, after Greptile on #157; ADR 0023,
 * "1 GiB live per agent"). A run admitted at the door is told what it may still commit as
 * `GRAFT_BLOB_BUDGET_BYTES`, and the runner refuses the write that would pass it; on a `run_tool`
 * that is a guarantee, since the server wrote the whole command. On a by-hand path the command is
 * the caller's: `GRAFT_BLOB_BUDGET_BYTES=1073741824 node "$GRAFT_RUNNER" …` hands the runner any
 * budget it likes, and the ledger it prints is then true of what is on the mount. So the server
 * holds the ledger to the budget it admitted when it records the run: the committed bytes are
 * summed, and past the budget the newest blobs are removed through the `BlobStore` until the rest
 * fit, given no row, and the run is answered a `blob_quota` failure naming the overshoot. Newest
 * first, because the earlier writes are exactly what an honest runner would have committed under
 * the same budget, and a module that wrote three files in an order meant the first ones; the ledger
 * is in commit order (`runner.mjs` appends as each rename lands), so the end of it is the newest.
 * The same check runs on `run.ts`'s path as defence in depth: it costs one sum.
 *
 * Removing is what makes the rule hold: a row left unwritten while the directory stays would be
 * adopted by the next sweep from its sidecar (GRA-189) and count again. Without a store bound
 * (`McpDeps.blobStore`, which `apps/server` always binds) the ledger is recorded as it stands and
 * the environment is the only rule, as it was before this file.
 */

/** What recording a ledger against a budget did: the rows written, the blobs removed, the figures. */
export type BudgetedRecord = {
  kept: BlobLedgerEntry[];
  removed: BlobLedgerEntry[];
  /** The bytes the run committed, kept and removed together. */
  committedBytes: number;
  /** The budget the door admitted the run under; undefined when no budget was known to check. */
  budgetBytes: number | undefined;
};

/**
 * Record a run's ledger as `recordWrittenBlobs` does, but held to `budgetBytes` (the header): what
 * fits gets its rows, what does not is removed from the mount and gets none. A ledger within the
 * budget, or one with no budget to check against, is recorded whole.
 */
export async function recordBlobsWithinBudget(
  deps: McpDeps,
  scope: AgentScope,
  versionId: string | null,
  blobs: readonly BlobLedgerEntry[],
  dropped: number,
  budgetBytes: number | undefined,
): Promise<BudgetedRecord> {
  const committedBytes = blobs.reduce((total, entry) => total + entry.bytes, 0);
  const store = deps.blobStore;
  if (budgetBytes === undefined || committedBytes <= budgetBytes || !store) {
    await recordWrittenBlobs(deps, scope, versionId, blobs, dropped);
    return { kept: [...blobs], removed: [], committedBytes, budgetBytes };
  }
  const kept = [...blobs];
  const removed: BlobLedgerEntry[] = [];
  let sum = committedBytes;
  while (sum > budgetBytes) {
    const newest = kept.pop();
    if (!newest) break;
    removed.push(newest);
    sum -= newest.bytes;
  }
  for (const entry of removed) {
    const id = blobIdOf(entry.ref);
    // The envelope reader admitted the ref's shape, so the id is there; a store that cannot find
    // the directory has nothing to remove, and either way the blob gets no row.
    if (id !== null) await store.remove(scope.agentId, id);
  }
  await recordWrittenBlobs(deps, scope, versionId, kept, dropped);
  return { kept, removed, committedBytes, budgetBytes };
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => `${Math.round((bytes / MIB) * 100) / 100} MiB`;

/**
 * The failure a run past its budget is answered, spread over the run's own answer: `error` opens
 * with the door's word, and the removed blobs are counted and sized beside it, never named, since
 * their refs point at nothing now. Null for a record within its budget.
 */
export function blobBudgetOvershoot(
  record: BudgetedRecord,
): { error: string; blobsRemoved: number; removedBytes: number; budgetBytes: number } | null {
  if (record.removed.length === 0 || record.budgetBytes === undefined) return null;
  const removedBytes = record.removed.reduce((total, entry) => total + entry.bytes, 0);
  return {
    error: `blob_quota: the run committed ${mib(record.committedBytes)} of blobs against the ${mib(record.budgetBytes)} its budget allowed, ${mib(record.committedBytes - record.budgetBytes)} past it. The newest ${record.removed.length} (${mib(removedBytes)}) were removed and have no ref; the ${record.kept.length} before them stand. The budget is what the agent's quota leaves, and a blob stops counting 24 hours after its write.`,
    blobsRemoved: record.removed.length,
    removedBytes,
    budgetBytes: record.budgetBytes,
  };
}
