import { AsyncLocalStorage } from "node:async_hooks";

import { type AgentScope, recordBlobsWritten } from "@graft/core";
import { BLOB_TTL_HOURS, type BlobLedgerEntry, blobIdOf } from "@graft/runner";

import { type boundResult, MAX_RESULT_BLOBS } from "./bounds";
import type { McpDeps } from "./deps";

/**
 * What a tool's description says of blobs (GRA-190; ADR 0023): the shape of the `blobs` list a
 * result may carry, and the three refusals the door answers an input's dead ref with
 * (`blob-door.ts`). A capability statement in the third person, as every description is
 * (GRA-111): it names what comes back and what is refused, and carries no rule; the rule, that a
 * file crosses as the ref and the producing tool runs first, is `session.ts`'s `BLOB_RULE`.
 * `run_tool` and every authored tool in the list carry this sentence (`tools/meta.ts`, `tools.ts`).
 */
export const BLOB_RESULT_FACT =
  "A result may carry blobs, one entry per file the tool wrote, each with ref (a blob:// string), bytes, contentType, name and expiresAt. " +
  `An input naming a blob:// ref this agent holds no blob for is refused blob_not_found, one whose ${BLOB_TTL_HOURS} hours have passed blob_expired, and any run while the agent's live blobs are at their quota blob_quota.`;

/**
 * What the server does with the runner's blob ledger (GRA-186; ADR 0023): the rows, the analytics
 * event, and the list the agent reads beside the result. One file, because the sync run
 * (`run.ts`) and the detached poll (`sandbox.ts`, `tools/authoring.ts`) learn of a blob the same
 * way and must do the same three things with it.
 */

/** One blob as `McpDeps.onBlobWritten` is told of it: counts and kinds, never the name or a byte. */
export type BlobWrittenEvent = {
  agentId: string;
  personId: string;
  /** The version whose run wrote it; null for a runner invoked by hand or a detached run polled later. */
  versionId: string | null;
  bytes: number;
  contentType: string;
};

/**
 * Record every blob on a ledger — one row each, one statement (`@graft/core`'s
 * `recordBlobsWritten`) — and tell the hook once per blob. The ref's id is the row's id: the
 * runner minted it, the envelope reader has already checked its shape, and the door will look a
 * ref up by it (GRA-187). Nothing to record is nothing done.
 */
export async function recordWrittenBlobs(
  deps: McpDeps,
  scope: AgentScope,
  versionId: string | null,
  blobs: readonly BlobLedgerEntry[],
  dropped = 0,
): Promise<void> {
  if (blobs.length === 0) {
    tallyBlobs(0, dropped);
    return;
  }
  const rows = await recordBlobsWritten(
    { db: deps.db },
    scope,
    {
      versionId,
      blobs: blobs.map((entry) => ({
        // Non-null: `readRunnerEnvelope` admits no ledger line whose ref is not `blob://<uuid>`.
        id: blobIdOf(entry.ref) ?? entry.ref,
        bytes: entry.bytes,
        contentType: entry.contentType,
        name: entry.name ?? null,
        expiresAt: new Date(entry.expiresAt),
      })),
    },
    deps.blob,
  );
  for (const row of rows) {
    deps.onBlobWritten?.({
      agentId: scope.agentId,
      personId: scope.personId,
      versionId,
      bytes: row.bytes,
      contentType: row.contentType,
    });
  }
  tallyBlobs(rows.length, dropped);
}

/**
 * What one tool call did with blobs, for the wide event (Greptile on #144): how many rows it
 * recorded and how many ledger lines it refused, and whether a runner's ledger was read at all.
 * Carried as its own value from the parsed ledger, never read off the answer, whose keys are the
 * module's to choose: a module returning `{ blobs: [...], blobsDropped: 3 }` wrote nothing.
 */
export type BlobTally = { seen: boolean; written: number; dropped: number };

const tallies = new AsyncLocalStorage<BlobTally>();

/** Run one tool call with a fresh tally in reach of every `recordWrittenBlobs` inside it. */
export async function withBlobTally<T>(
  work: () => Promise<T>,
): Promise<{ value: T; tally: BlobTally }> {
  const tally = newBlobTally();
  const value = await runUnderBlobTally(tally, work);
  return { value, tally };
}

/** A fresh tally, for a caller that must read it whether `work` settles or rejects. */
export function newBlobTally(): BlobTally {
  return { seen: false, written: 0, dropped: 0 };
}

/**
 * Run `work` under a tally the caller holds, so a rejection loses nothing: the acquire runner
 * reports a crashed job's blobs from the same tally its finished event would have (Greptile on
 * #151).
 */
export function runUnderBlobTally<T>(tally: BlobTally, work: () => Promise<T>): Promise<T> {
  return tallies.run(tally, work);
}

/**
 * Run `work` with no tally in reach, for background work started from inside a tool call — the
 * acquire runner's kick (`acquire/runner.ts`), whose timer would otherwise inherit the call's
 * context and claim jobs across agents under it (Greptile on #144). A job gets a tally of its own
 * from `withBlobTally` when it starts.
 */
export function outsideBlobTally<T>(work: () => T): T {
  return tallies.exit(work);
}

function tallyBlobs(written: number, dropped: number): void {
  const tally = tallies.getStore();
  if (!tally) return;
  tally.seen = true;
  tally.written += written;
  tally.dropped += dropped;
}

/**
 * The ledger as the agent reads it beside a result: the first `MAX_RESULT_BLOBS` lines whole, and
 * a count and a note when there were more. Every line is short and carries no bytes, so the bound
 * is against a module looping over a directory, not against size. Nothing at all when the run
 * wrote nothing and the reader refused nothing, so a caller spreads it unconditionally and a run
 * that wrote no blob answers exactly what it did (GRA-199 folded the guard here from four callers).
 */
export function blobsOnWire(
  blobs: readonly BlobLedgerEntry[],
  dropped = 0,
): {
  blobs?: BlobLedgerEntry[];
  blobsOmitted?: number;
  blobsNote?: string;
  blobsDropped?: number;
} {
  if (blobs.length === 0 && dropped === 0) return {};
  // A ledger line the reader refused (`readRunnerEnvelope`): counted for the agent here, never a
  // row; the wide event takes its count from the tally, not from this answer.
  const refused = dropped > 0 ? { blobsDropped: dropped } : {};
  if (blobs.length <= MAX_RESULT_BLOBS) return { blobs: [...blobs], ...refused };
  const omitted = blobs.length - MAX_RESULT_BLOBS;
  return {
    blobs: blobs.slice(0, MAX_RESULT_BLOBS),
    blobsOmitted: omitted,
    blobsNote: `The run wrote ${blobs.length} blobs; the first ${MAX_RESULT_BLOBS} are listed and ${omitted} omitted. Every ref is still in the module's result, and every blob is held.`,
    ...refused,
  };
}

/**
 * A run's answer with its blobs beside it — the wire shape (GRA-186). `bounded` is `boundResult`'s
 * own verdict, so whether the server cut the result is the server's word and never read off a key
 * the module chose. A run that wrote no blob answers exactly what it always did: the module's
 * result, or the server's `{ result: null, truncated, head, note }`. One that did answers
 * `{ result, blobs }` with the module's result under `result`, whatever its shape — a module's own
 * `truncated` or `blobs` key stays inside it — and a cut result takes the list beside the server's
 * own fields.
 */
export function withBlobs(
  bounded: ReturnType<typeof boundResult>,
  blobs: readonly BlobLedgerEntry[],
  dropped = 0,
): unknown {
  const cut = "truncated" in bounded;
  if (blobs.length === 0 && dropped === 0) return cut ? bounded : bounded.result;
  const wire = blobsOnWire(blobs, dropped);
  return cut ? { ...bounded, ...wire } : { result: bounded.result, ...wire };
}
