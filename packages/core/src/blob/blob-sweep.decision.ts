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
 *   judged again once it expires; a `.tmp` younger than the longest a run may live; a directory
 *   with no row whose age the store could not read this pass.
 * - **`remove`**: a row past its expiry whose directory is there. The directory goes and the row is
 *   marked `removed_at`, so the door can say expired rather than not found (GRA-187).
 * - **`mark`**: a row past its expiry whose directory is already gone. Only the row is marked.
 * - **`adopt`**: a committed directory with a readable sidecar and no row, which is what a run
 *   killed after its rename and before the server read the envelope leaves. The row is built from
 *   what the store measured and the sidecar clamped to it (below), and judged like any row on the
 *   next pass.
 * - **`remove_orphan`**: a committed directory with no row and no sidecar the sweep can adopt from.
 *   The rename is the commit and the runner writes the sidecar before it, so a committed directory
 *   always has one; a directory without one, with one the runner could not have written, or with
 *   one naming another agent, is junk and goes.
 * - **`remove_tmp`**: a `<blobId>.tmp` last written to longer ago than the longest a run may live.
 *   A `.tmp` is a write in progress or an abandoned one, and the bound is what tells them apart;
 *   the sweep also never runs for an agent with a run in flight (ADR 0009), so no write the runner
 *   could still finish is ever taken from under it.
 *
 * **The sidecar is untrusted.** The mount is the scope (ADR 0023) and the server trusts nothing a
 * sandbox wrote, so an adoption takes the row's facts from the store where it can and clamps the
 * rest: `bytes` is `data`'s real size, never the sidecar's number; `writtenAt` is the sidecar's
 * unless it is missing or later than the store's `lastWrittenAt`, which then stands in; `expiresAt`
 * is the sidecar's, never later than `writtenAt` plus the TTL, so nothing is adopted with a
 * far-future expiry; `name` and `contentType` are held to the rules a write is held to
 * (`BLOB_NAME_RULES`, `BLOB_CONTENT_TYPE_RULES`), and a sidecar that breaks one is not adopted.
 *
 * A row already marked removed whose directory is still there is `remove` again with nothing to
 * mark; one whose directory is gone is out of the sweep's hands and is not in the plan. Expiry is
 * strict: a blob expiring exactly now is not yet past it. Nothing under `tools/` can ever be in a
 * plan, since the names come from a store that reaches `.blobs/` alone.
 */

import { BLOB_TTL_MS, MAX_BLOB_CONTENT_TYPE_CHARS, MAX_BLOB_NAME_CHARS } from "@graft/runner";

/** How long a blob lives from its write (ADR 0023): the runner's figure, which the clamp below applies. */
export { BLOB_TTL_MS };

/** The suffix of a directory the runner is still writing; `@graft/toolbox`'s `BLOB_TMP_SUFFIX`, spelt here so this package does not depend on the store and pinned equal in `@graft/mcp`'s `sweep.test.ts`. */
export const BLOB_TMP_SUFFIX = ".tmp";

/**
 * What a blob's name may be, as the sweep admits one from a sidecar: the runner's length
 * (`MAX_BLOB_NAME_CHARS`, the same figure its `blob_invalid_name` refuses past, GRA-186), no slash
 * or backslash (a name is shown to the agent, never read as a path) and no control character. The
 * runner's own pattern is private to `runner.mjs`; the length is the one spelling.
 */
export const BLOB_NAME_RULES = {
  maxChars: MAX_BLOB_NAME_CHARS,
  /** Neither separator may appear: a name is never read as a path, and one that looks like it is refused. */
  forbidden: ["/", "\\"],
} as const;

/**
 * What a blob's media type may be: the runner's length (`MAX_BLOB_CONTENT_TYPE_CHARS`, its
 * `blob_invalid_content_type` figure), shaped `type/subtype` with optional `; key=value`
 * parameters (RFC 9110's token grammar), which is what the runner's write admits. Control
 * characters are refused by `hasControlCharacter` rather than the pattern, so no character class
 * here has to spell one.
 */
export const BLOB_CONTENT_TYPE_RULES = {
  maxChars: MAX_BLOB_CONTENT_TYPE_CHARS,
  pattern:
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"]*"|[A-Za-z0-9!#$&^_.+-]+))*$/,
} as const;

/** A C0 control character (below space) or DEL anywhere in the value. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Whether `name` may be a blob's name (the write rule and the adoption rule are one). */
export function isValidBlobName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= BLOB_NAME_RULES.maxChars &&
    !hasControlCharacter(name) &&
    !BLOB_NAME_RULES.forbidden.some((separator) => name.includes(separator))
  );
}

/** Whether `contentType` may be a blob's media type (the write rule and the adoption rule are one). */
export function isValidBlobContentType(contentType: string): boolean {
  return (
    contentType.length > 0 &&
    contentType.length <= BLOB_CONTENT_TYPE_RULES.maxChars &&
    !hasControlCharacter(contentType) &&
    BLOB_CONTENT_TYPE_RULES.pattern.test(contentType)
  );
}

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
   * store confirmed there is none (`BlobStore.readMeta`'s own signal, never a failed read). Not
   * needed for a `.tmp` or a directory with a row.
   */
  sidecar?: string | null;
  /**
   * `BlobStore.stat`'s answer, for a `.tmp` (its age) and for a committed directory with no row
   * (its real size and age, which an adoption is built from); null when the directory was gone by
   * the time it was read.
   */
  stat?: BlobDirectoryAge | null;
};

/** The sidecar the runner writes beside `data` (GRA-186), as the sweep reads it before any clamp. */
export type BlobSidecar = {
  bytes: number;
  contentType: string;
  name: string | null;
  writtenAt: Date | null;
  expiresAt: Date | null;
  agentId: string | null;
  toolVersion: string | null;
};

/** The row an adoption writes: the store's measurements, and the sidecar clamped to them. */
export type AdoptedBlob = {
  /** `data`'s size as the store measured it. */
  bytes: number;
  contentType: string;
  name: string | null;
  /** The sidecar's, unless missing or later than the store's `lastWrittenAt`, which then stands in. */
  writtenAt: Date;
  /** The sidecar's, and never later than `writtenAt` plus the TTL. */
  expiresAt: Date;
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
  | { action: "keep"; name: string; reason: "live" | "landing" | "writing" | "unread" }
  | { action: "remove"; blobId: string; bytes: number; mark: boolean }
  | { action: "mark"; blobId: string; bytes: number }
  | { action: "adopt"; blobId: string; row: AdoptedBlob }
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The sidecar's text as a `BlobSidecar`, or null when it is not one the runner could have written:
 * not JSON, not an object, a size that is not a whole number, a media type or a name that breaks
 * the write rules. A date that does not parse reads as absent, and the adoption fills it from the
 * store. A sidecar is what a sandbox wrote, so it is read as input and never trusted to have a
 * shape.
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
  const contentType = typeof record.contentType === "string" ? record.contentType.trim() : "";
  if (!isValidBlobContentType(contentType)) return null;
  const name = readString(record.name);
  if (name !== null && !isValidBlobName(name)) return null;
  return {
    bytes,
    contentType,
    name,
    writtenAt: readDate(record.writtenAt),
    expiresAt: readDate(record.expiresAt),
    agentId: readString(record.agentId),
    toolVersion: readString(record.toolVersion),
  };
}

/**
 * The row an orphan is adopted as: the store's size, the sidecar's times clamped to the store's
 * age and the TTL. Null when the directory holds no `data`, since a blob without its bytes is not
 * a blob.
 */
export function adoptedBlobOf(sidecar: BlobSidecar, stat: BlobDirectoryAge): AdoptedBlob | null {
  if (stat.bytes === null) return null;
  const writtenAt =
    sidecar.writtenAt !== null && sidecar.writtenAt.getTime() <= stat.lastWrittenAt.getTime()
      ? sidecar.writtenAt
      : stat.lastWrittenAt;
  const latest = writtenAt.getTime() + BLOB_TTL_MS;
  const expiresAt =
    sidecar.expiresAt !== null && sidecar.expiresAt.getTime() < latest
      ? sidecar.expiresAt
      : new Date(latest);
  return {
    bytes: stat.bytes,
    contentType: sidecar.contentType,
    name: sidecar.name,
    writtenAt,
    expiresAt,
    toolVersion: sidecar.toolVersion,
  };
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
    if (entry.stat === undefined) {
      // Not read this pass: no adoption without the store's measurements, and no removal either.
      actions.push({ action: "keep", name: entry.name, reason: "unread" });
      continue;
    }
    if (entry.stat === null) {
      // Gone between the listing and the read: nobody's to remove, nothing to adopt.
      actions.push({ action: "keep", name: entry.name, reason: "landing" });
      continue;
    }
    const sidecar = entry.sidecar == null ? null : parseBlobSidecar(entry.sidecar);
    const mine =
      sidecar !== null && (sidecar.agentId === null || sidecar.agentId === input.agentId);
    const row = sidecar && mine ? adoptedBlobOf(sidecar, entry.stat) : null;
    if (row) actions.push({ action: "adopt", blobId: entry.name, row });
    else actions.push({ action: "remove_orphan", blobId: entry.name, bytes: entry.stat.bytes });
  }

  return { actions };
}
