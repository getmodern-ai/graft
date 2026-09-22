import { findBlob, findBlobs, insertBlobs, listBlobs, sumLiveBlobBytes } from "@graft/db/repo/blob";

/** The blob module's test seam. */
export type BlobDeps = {
  insertBlobs: typeof insertBlobs;
  findBlob: typeof findBlob;
  findBlobs: typeof findBlobs;
  listBlobs: typeof listBlobs;
  sumLiveBlobBytes: typeof sumLiveBlobBytes;
  now: () => Date;
};

export const defaultBlobDeps: BlobDeps = {
  insertBlobs,
  findBlob,
  findBlobs,
  listBlobs,
  sumLiveBlobBytes,
  now: () => new Date(),
};
