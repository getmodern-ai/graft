import type { BlobRow } from "@graft/db/repo/blob";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import type { BlobDeps } from "./blob.deps";

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

/** This agent's blobs, newest first, removed ones included. */
export async function listBlobs(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: BlobDeps,
): Promise<BlobRow[]> {
  return deps.listBlobs(ctx.db, scope);
}
