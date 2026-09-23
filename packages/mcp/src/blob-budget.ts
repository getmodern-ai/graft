import {
  type AgentScope,
  adoptedBlobOf,
  getBlobs,
  liveBlobBytes,
  parseBlobSidecar,
  type ServiceContext,
} from "@graft/core";
import { BLOB_QUOTA_BYTES, type BlobLedgerEntry, blobIdOf, blobRefOf } from "@graft/runner";

import { blobsOnWire, recordWrittenBlobs } from "./blobs";
import type { McpDeps } from "./deps";

/**
 * The record of a run's blobs is an adoption from the store (GRA-200, after Greptile on #157
 * three times; ADR 0023, "1 GiB live per agent"). A run admitted at the door is told what it may
 * still commit as `GRAFT_BLOB_BUDGET_BYTES`, and the runner refuses the write that would pass it;
 * on a `run_tool` that holds, since the server wrote the whole command. On a by-hand path the
 * command is the caller's, so nothing that comes out of the sandbox is evidence: the environment
 * can be replaced, the envelope can be forged outright with a `printf`, and the sidecar beside a
 * blob is a file the command can edit. So the record takes **the ids alone** from the ledger and
 * builds every row the way the sweep builds an orphan's (`adoptedBlobOf`, `@graft/core`; GRA-189),
 * from the store's measurement, the server's clock and the server's rules:
 *
 *  - an entry whose ref carries no id, a repeat, or one the store cannot `stat` under this agent
 *    (no directory, or no `data` yet) is dropped: nothing was written there by anyone;
 *  - an entry naming a blob that already has a row under this scope is **known**: it is neither
 *    recorded again nor ever removed, whatever the entry says of it, and it goes on the wire from
 *    its row alone, and only while the row is live (not removed, not expired) and the directory is
 *    still there; a dead one is dropped, so a forged or replayed ledger never advertises a ref the
 *    door would refuse. A second poll of a finished process reads the same envelope and names the
 *    same live blob, which is the agent's and held;
 *  - what is left is this run's, and its row is what the sidecar and the store agree on under the
 *    sweep's rules: the sidecar parsed by `parseBlobSidecar` (a name or a media type that fails the
 *    write rule, or a sidecar that is not JSON, drops the entry), a sidecar naming another agent
 *    dropped as the sweep refuses it, `bytes` as the store measured `data`, `writtenAt` the
 *    sidecar's unless it is later than the store's last write, and `expiresAt` never later than
 *    `writtenAt` plus the TTL. The store's last write is itself capped at the server's now before
 *    the clamp, so a directory touched into the future cannot buy a longer life. The version is the
 *    caller's (`run.ts` knows it; a by-hand path and a poll pass null), never the sidecar's.
 *
 * Then the quota itself, measured now: the agent's live bytes (`liveBlobBytes`, the rows) plus
 * what this run committed must not pass `BLOB_QUOTA_BYTES`, and past it the run's blobs are
 * removed newest first until the rest fit, given no row, and the run is answered a `blob_quota`
 * failure naming the overshoot. Newest first, because the earlier writes are exactly what an
 * honest runner would have committed under the same budget, and a module that wrote three files
 * in an order meant the first ones; the ledger is in commit order (`runner.mjs` appends as each
 * rename lands), so the end of it is the newest.
 *
 * **The whole record runs under the agent's critical section** (`InFlightRegistry.exclusive`,
 * `in-flight.ts`, the same one admissions take): two runs of one agent finishing together would
 * otherwise each read the same live total, each find room, and together pass the quota. The read,
 * the judgement, the removals and the inserts are one step per agent, and `wait_for_process`,
 * which reaches the record from outside the admission chain, takes the same step.
 *
 * **The record does not read the grant.** The door's budget is what an honest run was told and
 * the grant on the registry is what keeps two admissions apart; neither is what the person was
 * promised. A detached run's grant expires with its hold, its result stays pollable after that,
 * and a released or expired grant would read as "nothing to check against". The quota is the
 * promise, and the rows and the store are always there to measure it against, so that is the rule
 * at every record site, `run.ts`'s included as defence in depth: a `stat` and a `readMeta` per
 * blob written, and one sum.
 *
 * Removing is what makes the rule hold: a row left unwritten while the directory stays would be
 * adopted by the next sweep from its sidecar (GRA-189) and count again. Without a store bound
 * (`McpDeps.blobStore`, which `apps/server` always binds) nothing can be measured, and the ledger
 * is recorded as declared, as it was before this file: a harness with no store is one with no
 * by-hand caller either.
 */

/** What recording a ledger against the quota did: the rows written, the blobs removed, the figures. */
export type QuotaRecord = {
  /** This run's blobs that stand, as their rows were written. */
  kept: BlobLedgerEntry[];
  /** This run's blobs removed to fit the quota, at their measured bytes, newest first. */
  removed: BlobLedgerEntry[];
  /**
   * What the agent is shown as the process's blobs, in ledger order: the known live blobs from
   * their rows and the kept ones as recorded; nothing removed, nothing dropped.
   */
  listed: BlobLedgerEntry[];
  /** Ledger lines the reader refused, plus entries that named nothing this record could adopt. */
  dropped: number;
  /** The bytes this run committed as the store measured them, kept and removed together. */
  committedBytes: number;
  /** The agent's live bytes before this run's were counted. */
  liveBytes: number;
  quota: number;
};

/**
 * Record a run's ledger as `recordWrittenBlobs` does, adopted from the store and held to the quota
 * (the header): what is this run's and fits gets its row, what does not fit is removed from the
 * mount and gets none, and what cannot be adopted is dropped. One step per agent.
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
  const step = () => recordAdopted(deps, store, scope, versionId, ledger, dropped);
  return deps.inFlight ? deps.inFlight.exclusive(scope.agentId, step) : step();
}

async function recordAdopted(
  deps: McpDeps,
  store: NonNullable<McpDeps["blobStore"]>,
  scope: AgentScope,
  versionId: string | null,
  ledger: readonly BlobLedgerEntry[],
  dropped: number,
): Promise<QuotaRecord> {
  const ctx: ServiceContext = { db: deps.db };
  const now = deps.blob.now();

  // Which of the named blobs already have a row under this scope: known, and not this run's.
  const ids = ledger.map((entry) => blobIdOf(entry.ref));
  const rows = await getBlobs(
    ctx,
    scope,
    ids.filter((id): id is string => id !== null),
    deps.blob,
  );
  const known = new Map(rows.map((row) => [row.id, row]));
  const mine: BlobLedgerEntry[] = [];
  const listed: BlobLedgerEntry[] = [];
  const seen = new Set<string>();
  let unadoptable = 0;
  for (const id of ids) {
    if (id === null || seen.has(id)) {
      unadoptable += 1;
      continue;
    }
    seen.add(id);
    const row = known.get(id);
    if (row) {
      // Listed from the row, and only while the door would admit the ref (the header).
      const live = row.removedAt === null && row.expiresAt.getTime() > now.getTime();
      if (live && (await store.exists(scope.agentId, id))) {
        listed.push({
          ref: blobRefOf(row.id),
          bytes: row.bytes,
          contentType: row.contentType,
          ...(row.name !== null ? { name: row.name } : {}),
          expiresAt: row.expiresAt.toISOString(),
        });
      } else {
        unadoptable += 1;
      }
      continue;
    }
    const adopted = await adoptFromStore(store, scope.agentId, id, now);
    if (!adopted) {
      unadoptable += 1;
      continue;
    }
    mine.push(adopted);
    listed.push(adopted);
  }

  const liveBytes = await liveBlobBytes(ctx, scope, deps.blob);
  const committedBytes = mine.reduce((total, entry) => total + entry.bytes, 0);
  const kept = [...mine];
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
  const droppedAll = dropped + unadoptable;
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

/**
 * One blob as the store and the sweep's rules describe it, or null when it cannot be adopted (the
 * header's third bullet): the directory and its `data` through `stat`, the sidecar through
 * `readMeta` and `parseBlobSidecar`, a sidecar naming another agent refused, and `adoptedBlobOf`
 * over the two with the store's last write capped at the server's now.
 */
async function adoptFromStore(
  store: NonNullable<McpDeps["blobStore"]>,
  agentId: string,
  blobId: string,
  now: Date,
): Promise<BlobLedgerEntry | null> {
  const stat = await store.stat(agentId, blobId);
  if (!stat || stat.bytes === null) return null;
  const meta = await store.readMeta(agentId, blobId);
  const sidecar = meta === null ? null : parseBlobSidecar(meta);
  if (!sidecar || (sidecar.agentId !== null && sidecar.agentId !== agentId)) return null;
  const lastWrittenAt = stat.lastWrittenAt.getTime() < now.getTime() ? stat.lastWrittenAt : now;
  const adopted = adoptedBlobOf(sidecar, { lastWrittenAt, bytes: stat.bytes });
  if (!adopted) return null;
  return {
    ref: blobRefOf(blobId),
    bytes: adopted.bytes,
    contentType: adopted.contentType,
    ...(adopted.name !== null ? { name: adopted.name } : {}),
    expiresAt: adopted.expiresAt.toISOString(),
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
 * (`blobsOnWire`'s keys): the known live ones from their rows and the kept ones as recorded, so
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
