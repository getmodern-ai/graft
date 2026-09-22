import type { BlobRow } from "@graft/db/repo/blob";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import type { BlobDeps } from "./blob.deps";
import type { BlobSidecar } from "./blob-sweep.decision";

/**
 * The blob rows (CONTEXT.md, *Blob*; ADR 0023): what the server knows of a file one tool wrote for
 * another. The bytes never come here — they are in the blob store, under the agent's mount — and
 * neither does a ref: the MCP layer reads `blob://<id>` off the runner's ledger and hands this
 * service the id, so the row's key is the blob's id and the wire's vocabulary stays the wire's.
 * Every function takes the `AgentScope`, which the repo puts in the SQL (ADR 0007).
 */

/** One blob as the runner's ledger described it, keyed by the id inside its ref. */
export type BlobWrittenInput = {
  id: string;
  bytes: number;
  contentType: string;
  name?: string | null;
  expiresAt: Date;
};

/**
 * Record every blob one run wrote, in one statement, for the agent whose sandbox wrote them and the
 * version whose run it was (null for a runner invoked by hand, or a detached run polled later).
 * Nothing to record is nothing written. A line that could not have come from the runner — a size
 * that is not a whole number, an empty media type, an expiry that is not a date — is refused whole,
 * since the runner is the only writer and such a line is a bug and not data.
 */
export async function recordBlobsWritten(
  ctx: ServiceContext,
  scope: AgentScope,
  input: { versionId: string | null; blobs: readonly BlobWrittenInput[] },
  deps: BlobDeps,
): Promise<BlobRow[]> {
  if (input.blobs.length === 0) return [];
  const createdAt = deps.now();
  for (const entry of input.blobs) {
    if (entry.id.trim().length === 0) {
      throw new ServiceError("BAD_REQUEST", "A blob row names the blob's id");
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new ServiceError("BAD_REQUEST", "A blob's size is a whole number of bytes");
    }
    if (entry.contentType.trim().length === 0) {
      throw new ServiceError("BAD_REQUEST", "A blob row names the blob's media type");
    }
    if (Number.isNaN(entry.expiresAt.getTime())) {
      throw new ServiceError("BAD_REQUEST", "A blob row names when the blob expires");
    }
  }
  return deps.insertBlobs(
    ctx.db,
    input.blobs.map((entry) => ({
      id: entry.id,
      personId: scope.personId,
      agentId: scope.agentId,
      versionId: input.versionId,
      bytes: entry.bytes,
      contentType: entry.contentType,
      name: entry.name ?? null,
      expiresAt: entry.expiresAt,
      createdAt,
    })),
  );
}

/** One blob of this agent's by id, or null — another agent's, another person's and none are the same answer. */
export async function getBlob(
  ctx: ServiceContext,
  scope: AgentScope,
  blobId: string,
  deps: BlobDeps,
): Promise<BlobRow | null> {
  return deps.findBlob(ctx.db, scope, blobId);
}

/**
 * The blobs among `blobIds` that are this agent's, in one read: the door's lookup of every ref an
 * input names (GRA-187). An id absent from the answer has no row under this scope; whether nobody
 * wrote it or another agent did is not told apart here or anywhere (ADR 0023).
 */
export async function getBlobs(
  ctx: ServiceContext,
  scope: AgentScope,
  blobIds: readonly string[],
  deps: BlobDeps,
): Promise<BlobRow[]> {
  return deps.findBlobs(ctx.db, scope, blobIds);
}

/**
 * The bytes this agent holds live now: every blob not removed and not yet expired, summed in one
 * read, which is what the door measures against the quota before a run (GRA-187). The clock is the seam's,
 * so a suite can move it.
 */
export async function liveBlobBytes(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: BlobDeps,
): Promise<number> {
  return deps.sumLiveBlobBytes(ctx.db, scope, deps.now());
}

/** This agent's blobs, newest first, removed ones included. */
export async function listBlobs(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: BlobDeps,
): Promise<BlobRow[]> {
  return deps.listBlobs(ctx.db, scope);
}

/** This agent's blobs the sweep has not yet removed, soonest to expire first: what the sweep judges (GRA-189). */
export async function listUnremovedBlobs(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: BlobDeps,
): Promise<BlobRow[]> {
  return deps.listUnremovedBlobs(ctx.db, scope);
}

/**
 * The sweep removed this blob's directory, or found it already gone: the row stays with
 * `removed_at`, so the door says expired rather than not found (ADR 0023; GRA-187). Answers whether
 * this call marked it; a row already marked, or not this agent's, is false and nothing is written.
 */
export async function markBlobRemoved(
  ctx: ServiceContext,
  scope: AgentScope,
  blobId: string,
  deps: BlobDeps,
): Promise<boolean> {
  return deps.markBlobRemoved(ctx.db, scope, blobId, deps.now());
}

/**
 * The row for a committed directory the sweep found no row for, written from its sidecar (ADR 0023:
 * a run killed after its rename leaves a directory with a sidecar and no row). The person is the
 * scope's, the agent the directory's (the sidecar's own `agentId` was judged by the decision), and
 * the version is the sidecar's `toolVersion`. Null when a row with that id already exists: the run
 * wrote it meanwhile, or the sweep once removed it and its directory has come back, and the caller
 * reads the null as "not mine to adopt".
 */
export async function adoptBlob(
  ctx: ServiceContext,
  scope: AgentScope,
  blobId: string,
  sidecar: BlobSidecar,
  deps: BlobDeps,
): Promise<BlobRow | null> {
  if (blobId.trim().length === 0) {
    throw new ServiceError("BAD_REQUEST", "A blob row names the blob's id");
  }
  return deps.insertAdoptedBlob(ctx.db, {
    id: blobId,
    personId: scope.personId,
    agentId: scope.agentId,
    versionId: sidecar.toolVersion,
    bytes: sidecar.bytes,
    contentType: sidecar.contentType,
    name: sidecar.name,
    expiresAt: sidecar.expiresAt,
    createdAt: sidecar.writtenAt,
  });
}
