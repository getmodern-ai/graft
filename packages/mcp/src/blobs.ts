import { type AgentScope, recordBlobsWritten } from "@graft/core";
import { type BlobLedgerEntry, blobIdOf } from "@graft/runner";

import { type boundResult, MAX_RESULT_BLOBS } from "./bounds";
import type { McpDeps } from "./deps";

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
): Promise<void> {
  if (blobs.length === 0) return;
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
}

/**
 * The ledger as the agent reads it beside a result: the first `MAX_RESULT_BLOBS` lines whole, and
 * a count and a note when there were more. Every line is short and carries no bytes, so the bound
 * is against a module looping over a directory, not against size.
 */
export function blobsOnWire(
  blobs: readonly BlobLedgerEntry[],
  dropped = 0,
): {
  blobs: BlobLedgerEntry[];
  blobsOmitted?: number;
  blobsNote?: string;
  blobsDropped?: number;
} {
  // A ledger line the reader refused (`readRunnerEnvelope`): counted here, so it reaches the wide
  // event through `tools.ts`'s `eventDetail`, and never a row.
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
