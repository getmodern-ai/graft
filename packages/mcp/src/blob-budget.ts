import { type AgentScope, getBlobs, liveBlobBytes, type ServiceContext } from "@graft/core";
import { BLOB_QUOTA_BYTES, type BlobLedgerEntry, blobIdOf, blobRefOf } from "@graft/runner";

import { blobsOnWire, recordWrittenBlobs } from "./blobs";
import type { McpDeps } from "./deps";

/**
 * The record is the rule, the envelope is a claim (GRA-200, after Greptile on #157 twice; ADR 0023,
 * "1 GiB live per agent"). A run admitted at the door is told what it may still commit as
 * `GRAFT_BLOB_BUDGET_BYTES`, and the runner refuses the write that would pass it; on a `run_tool`
 * that holds, since the server wrote the whole command. On a by-hand path the command is the
 * caller's, so nothing in what it prints is evidence: `GRAFT_BLOB_BUDGET_BYTES=1073741824 node
 * "$GRAFT_RUNNER" …` hands the runner any budget, and a `printf` can forge the envelope outright,
 * naming a blob at zero bytes, an existing blob at 900 MiB, or a blob that is not there. So when
 * the server records a run's ledger it takes nothing from the ledger but the ids, and asks the
 * store (`McpDeps.blobStore`) and the rows for the rest:
 *
 *  - an entry whose ref carries no id, or names a directory the store cannot find under this
 *    agent (`stat` null, or no `data` yet), is dropped: nothing was written there by anyone;
 *  - an entry naming a blob that already has a row under this scope is **known**: it is neither
 *    recorded again nor ever removed, whatever the entry says of it, and it goes on the wire from
 *    its row alone. A second poll of a finished process reads the same envelope and names the
 *    same blob, which is the agent's and held; a forged entry naming another of the agent's blobs
 *    shows the agent a blob it already holds, at its true size, which is no more than it knew;
 *  - what is left is this run's, at the bytes the store measured, never the bytes declared.
 *
 * Then the quota itself, measured now: the agent's live bytes (`liveBlobBytes`, the rows) plus
 * what this run committed must not pass `BLOB_QUOTA_BYTES`, and past it the run's blobs are
 * removed newest first until the rest fit, given no row, and the run is answered a `blob_quota`
 * failure naming the overshoot. Newest first, because the earlier writes are exactly what an
 * honest runner would have committed under the same budget, and a module that wrote three files
 * in an order meant the first ones; the ledger is in commit order (`runner.mjs` appends as each
 * rename lands), so the end of it is the newest.
 *
 * **The record does not read the grant.** The door's budget is what an honest run was told and
 * the grant on the registry is what keeps two admissions apart (`in-flight.ts`); neither is what
 * the person was promised. A detached run's grant expires with its hold, its result stays
 * pollable after that, and a released or expired grant would read as "nothing to check against".
 * The quota is the promise, and the rows and the store are always there to measure it against,
 * so that is the rule at every record site, `run.ts`'s included as defence in depth: it costs one
 * `stat` per blob written and one sum.
 *
 * Removing is what makes the rule hold: a row left unwritten while the directory stays would be
 * adopted by the next sweep from its sidecar (GRA-189) and count again. Without a store bound
 * (`McpDeps.blobStore`, which `apps/server` always binds) nothing can be measured, and the ledger
 * is recorded as declared, as it was before this file: a harness with no store is one with no
 * by-hand caller either.
 */

/** What recording a ledger against the quota did: the rows written, the blobs removed, the figures. */
export type QuotaRecord = {
  /** This run's blobs that stand, at their measured bytes. */
  kept: BlobLedgerEntry[];
  /** This run's blobs removed to fit the quota, at their measured bytes, newest first. */
  removed: BlobLedgerEntry[];
  /**
   * What the agent is shown as the process's blobs, in ledger order: the known blobs from their
   * rows and the kept ones at their measured bytes; nothing removed, nothing dropped.
   */
  listed: BlobLedgerEntry[];
  /** Ledger lines the reader refused, plus entries that named nothing anyone wrote. */
  dropped: number;
  /** The bytes this run committed as the store measured them, kept and removed together. */
  committedBytes: number;
  /** The agent's live bytes before this run's were counted. */
  liveBytes: number;
  quota: number;
};

/**
 * Record a run's ledger as `recordWrittenBlobs` does, held to the quota over what the store
 * measured (the header): what is this run's and fits gets its rows, what does not fit is removed
 * from the mount and gets none, and what is not this run's is dropped.
 */
export async function recordBlobsWithinQuota(
  deps: McpDeps,
  scope: AgentScope,
  versionId: string | null,
  ledger: readonly BlobLedgerEntry[],
  dropped: number,
): Promise<QuotaRecord> {
  const store = deps.blobStore;
  if (!store) {
    await recordWrittenBlobs(deps, scope, versionId, ledger, dropped);
    return {
      kept: [...ledger],
      removed: [],
      listed: [...ledger],
      dropped,
      committedBytes: ledger.reduce((total, entry) => total + entry.bytes, 0),
      liveBytes: 0,
      quota: BLOB_QUOTA_BYTES,
    };
  }
  const ctx: ServiceContext = { db: deps.db };

  // Which of the named blobs already have a row under this scope: known, and not this run's.
  const ids = ledger.map((entry) => blobIdOf(entry.ref));
  const rows = await getBlobs(
    ctx,
    scope,
    ids.filter((id): id is string => id !== null),
    deps.blob,
  );
  const known = new Map(rows.map((row) => [row.id, row]));
  const measured: BlobLedgerEntry[] = [];
  const listed: BlobLedgerEntry[] = [];
  const seen = new Set<string>();
  let nobodys = 0;
  for (const [index, entry] of ledger.entries()) {
    const id = ids[index] ?? null;
    if (id === null || seen.has(id)) {
      nobodys += 1;
      continue;
    }
    seen.add(id);
    const row = known.get(id);
    if (row) {
      listed.push({
        ref: blobRefOf(row.id),
        bytes: row.bytes,
        contentType: row.contentType,
        ...(row.name !== null ? { name: row.name } : {}),
        expiresAt: row.expiresAt.toISOString(),
      });
      continue;
    }
    const stat = await store.stat(scope.agentId, id);
    if (!stat || stat.bytes === null) {
      nobodys += 1;
      continue;
    }
    const mine = { ...entry, bytes: stat.bytes };
    measured.push(mine);
    listed.push(mine);
  }

  const liveBytes = await liveBlobBytes(ctx, scope, deps.blob);
  const committedBytes = measured.reduce((total, entry) => total + entry.bytes, 0);
  const kept = [...measured];
  const removed: BlobLedgerEntry[] = [];
  let standing = committedBytes;
  while (liveBytes + standing > BLOB_QUOTA_BYTES) {
    const newest = kept.pop();
    if (!newest) break;
    removed.push(newest);
    standing -= newest.bytes;
  }
  for (const entry of removed) {
    const id = blobIdOf(entry.ref);
    if (id !== null) await store.remove(scope.agentId, id);
  }
  const droppedAll = dropped + nobodys;
  await recordWrittenBlobs(deps, scope, versionId, kept, droppedAll);
  return {
    kept,
    removed,
    listed: listed.filter((entry) => !removed.includes(entry)),
    dropped: droppedAll,
    committedBytes,
    liveBytes,
    quota: BLOB_QUOTA_BYTES,
  };
}

const MIB = 1024 * 1024;
const mib = (bytes: number) => `${Math.round((bytes / MIB) * 100) / 100} MiB`;

/**
 * The failure a run past the quota is answered, spread over the run's own answer: `error` opens
 * with the door's word, and the removed blobs are counted and sized beside it, never named, since
 * their refs point at nothing now. Null for a record within the quota.
 */
export function blobQuotaOvershoot(
  record: QuotaRecord,
): { error: string; blobsRemoved: number; removedBytes: number; quota: number } | null {
  if (record.removed.length === 0) return null;
  const removedBytes = record.removed.reduce((total, entry) => total + entry.bytes, 0);
  const total = record.liveBytes + record.committedBytes;
  return {
    error: `blob_quota: this run committed ${mib(record.committedBytes)} of blobs, and with the agent's ${mib(record.liveBytes)} live before it that comes to ${mib(total)}, ${mib(total - record.quota)} past the ${mib(record.quota)} quota. The newest ${record.removed.length} (${mib(removedBytes)}) were removed and have no ref; the ${record.kept.length} before them stand. A blob stops counting 24 hours after its write.`,
    blobsRemoved: record.removed.length,
    removedBytes,
    quota: record.quota,
  };
}

/**
 * A process's answer with the blobs it *declared* replaced by the blobs the record *listed*
 * (`blobsOnWire`'s keys): the known ones from their rows and the kept ones at measured bytes, so
 * nothing the command printed of its blobs reaches the agent as fact; with nothing listed and
 * nothing dropped, no blob key at all. The failure fields ride on top when the record removed
 * something.
 */
export function withRecordedBlobs(
  answer: Record<string, unknown>,
  record: QuotaRecord,
): Record<string, unknown> {
  const {
    blobs: _blobs,
    blobsOmitted: _omitted,
    blobsNote: _note,
    blobsDropped: _dropped,
    ...rest
  } = answer;
  const named =
    record.listed.length > 0 || record.dropped > 0
      ? blobsOnWire(record.listed, record.dropped)
      : {};
  return { ...rest, ...named, ...(blobQuotaOvershoot(record) ?? {}) };
}
