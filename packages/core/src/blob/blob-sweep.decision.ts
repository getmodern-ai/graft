/**
 * ADR 0023's "the sweep deletes" as a pure function, in the shape of the working-set one
 * (`../working-set/sweep.decision.ts`): given one agent's blob rows, the names its blob store
 * listed, the sidecars and ages the caller read for the directories that need them, and the clock,
 * which directory goes, which row is marked, which orphan becomes a row. No `ctx`, no `deps`, so
 * every clause has a test that reads like the ADR (`blob-sweep.decision.test.ts`); the sweep
 * (`@graft/mcp`'s `sweep.ts`) only applies what this returns, through the `BlobStore` seam and the
 * blob repo.
 *
 * Seven outcomes, one per directory or row:
 *
 * - **`keep`**: a live row with its directory; a live row whose directory is missing, since the
 *   write may still be landing across a lagging view of the store (GRA-123) and the row will be
 *   judged again once it expires; a `.tmp` younger than the longest a run may live.
 * - **`remove`**: a row past its expiry whose directory is there. The directory goes and the row is
 *   marked `removed_at`, so the door can say expired rather than not found (GRA-187).
 * - **`mark`**: a row past its expiry whose directory is already gone. Only the row is marked.
 * - **`adopt`**: a committed directory with a readable sidecar and no row, which is what a run
 *   killed after its rename and before the server read the envelope leaves. The row is written from the sidecar, expiry
 *   from its `expiresAt`, and judged like any row on the next pass.
 * - **`remove_orphan`**: a committed directory with no row and no readable sidecar. The rename is
 *   the commit and the runner writes the sidecar before it, so a committed directory always has
 *   one; this is junk and goes.
 * - **`remove_tmp`**: a `<blobId>.tmp` last written to longer ago than the longest a run may live.
 *   A `.tmp` is a write in progress or an abandoned one, and the bound is what tells them apart;
 *   the sweep also never runs for an agent with a run in flight (ADR 0009), so no write the runner
 *   could still finish is ever taken from under it.
 *
 * A row already marked removed whose directory is still there is `remove` again with nothing to
 * mark; one whose directory is gone is out of the sweep's hands and is not in the plan. Expiry is
 * strict: a blob expiring exactly now is not yet past it. Nothing under `tools/` can ever be in a
 * plan, since the names come from a store that reaches `.blobs/` alone.
 */

/** The suffix of a directory the runner is still writing; `@graft/toolbox`'s `BLOB_TMP_SUFFIX`, spelt here so this package does not depend on the store and pinned equal in `@graft/mcp`'s `sweep.test.ts`. */
export const BLOB_TMP_SUFFIX = ".tmp";

/** What the store knows of a directory past its name: `@graft/toolbox`'s `BlobDirectoryStat`, structurally. */
export type BlobDirectoryAge = {
  /** The newest of the directory's, `data`'s and `meta.json`'s modification times. */
  lastWrittenAt: Date;
  /** The size of `data`, or null when the directory holds none yet. */
  bytes: number | null;
};

/** What the decision reads off a row: its id, when it expires, whether the sweep already removed it. */
export type BlobSweepRow = {
  id: string;
  /** The row's size, carried onto the removal so the count needs no read of the directory. */
  bytes: number;
  expiresAt: Date;
  removedAt: Date | null;
};

/** One name the store listed, with what the caller read about it where the rule needs it. */
export type BlobSweepEntry = {
  /** A blob id or a `<blobId>.tmp`, as `BlobStore.list` answered it. */
  name: string;
  /**
   * The sidecar's text, for a committed directory the caller found no row for; null when the
   * store could not read one. Not needed for a `.tmp` or a directory with a row.
   */
  sidecar?: string | null;
  /**
   * `BlobStore.stat`'s answer, for a `.tmp` (its age) and for a committed directory with no row
   * (the bytes an orphan held); null when the directory was gone by the time it was read.
   */
  stat?: BlobDirectoryAge | null;
};

/** The sidecar the runner writes beside `data` (GRA-186), as the sweep reads it. */
export type BlobSidecar = {
  bytes: number;
  contentType: string;
  name: string | null;
  writtenAt: Date;
  expiresAt: Date;
  agentId: string | null;
  toolVersion: string | null;
};

export type BlobSweepDecisionInput = {
  /** Whose directory this is: a sidecar naming another agent is not this agent's and is not adopted. */
  agentId: string;
  rows: readonly BlobSweepRow[];
  entries: readonly BlobSweepEntry[];
  now: Date;
  /** The longest a run may live, with a margin; a `.tmp` older than this is abandoned. */
  abandonedWriteMs: number;
};

export type BlobSweepAction =
  | { action: "keep"; name: string; reason: "live" | "landing" | "writing" }
  | { action: "remove"; blobId: string; bytes: number; mark: boolean }
  | { action: "mark"; blobId: string; bytes: number }
  | { action: "adopt"; blobId: string; sidecar: BlobSidecar }
  | { action: "remove_orphan"; blobId: string; bytes: number | null }
  | { action: "remove_tmp"; name: string; bytes: number | null };

export type BlobSweepDecision = { actions: BlobSweepAction[] };

/** Whether a listed name is a `<blobId>.tmp` rather than a committed blob's id. */
export function isTmpName(name: string): boolean {
  return name.endsWith(BLOB_TMP_SUFFIX) && name.length > BLOB_TMP_SUFFIX.length;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The sidecar's text as a `BlobSidecar`, or null when it is not one the runner could have written:
 * not JSON, not an object, a size that is not a whole number, an empty media type, an expiry or a
 * writing time that is not a date. A sidecar is what a sandbox wrote, so it is read as input and
 * never trusted to have a shape.
 */
export function parseBlobSidecar(text: string): BlobSidecar | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const bytes = record.bytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;
  const contentType = record.contentType;
  if (typeof contentType !== "string" || contentType.trim() === "") return null;
  const writtenAt = readDate(record.writtenAt);
  const expiresAt = readDate(record.expiresAt);
  if (!writtenAt || !expiresAt) return null;
  const name = typeof record.name === "string" && record.name !== "" ? record.name : null;
  const agentId =
    typeof record.agentId === "string" && record.agentId !== "" ? record.agentId : null;
  const toolVersion =
    typeof record.toolVersion === "string" && record.toolVersion !== "" ? record.toolVersion : null;
  return { bytes, contentType, name, writtenAt, expiresAt, agentId, toolVersion };
}

export function blobSweepDecision(input: BlobSweepDecisionInput): BlobSweepDecision {
  const now = input.now.getTime();
  const listed = new Set(input.entries.map((entry) => entry.name));
  const rowIds = new Set(input.rows.map((row) => row.id));
  const actions: BlobSweepAction[] = [];

  // The rows first, in the order given (the repo answers soonest to expire first).
  for (const row of input.rows) {
    const present = listed.has(row.id);
    if (row.removedAt !== null) {
      // Marked already: a directory still there goes, with nothing to mark; gone is nobody's.
      if (present)
        actions.push({ action: "remove", blobId: row.id, bytes: row.bytes, mark: false });
      continue;
    }
    const expired = row.expiresAt.getTime() < now;
    if (!expired) {
      actions.push({ action: "keep", name: row.id, reason: present ? "live" : "landing" });
      continue;
    }
    if (present) actions.push({ action: "remove", blobId: row.id, bytes: row.bytes, mark: true });
    else actions.push({ action: "mark", blobId: row.id, bytes: row.bytes });
  }

  // Then every listed name no row claims.
  for (const entry of input.entries) {
    if (rowIds.has(entry.name)) continue;
    if (isTmpName(entry.name)) {
      const stat = entry.stat;
      if (!stat) {
        // Gone between the listing and the read, or not read at all: nothing to judge this pass.
        actions.push({ action: "keep", name: entry.name, reason: "writing" });
        continue;
      }
      const abandoned = stat.lastWrittenAt.getTime() < now - input.abandonedWriteMs;
      if (abandoned) actions.push({ action: "remove_tmp", name: entry.name, bytes: stat.bytes });
      else actions.push({ action: "keep", name: entry.name, reason: "writing" });
      continue;
    }
    const sidecar = entry.sidecar == null ? null : parseBlobSidecar(entry.sidecar);
    const mine =
      sidecar !== null && (sidecar.agentId === null || sidecar.agentId === input.agentId);
    if (sidecar && mine) actions.push({ action: "adopt", blobId: entry.name, sidecar });
    else
      actions.push({
        action: "remove_orphan",
        blobId: entry.name,
        bytes: entry.stat?.bytes ?? null,
      });
  }

  return { actions };
}
