import { findBlob, insertBlobs, listBlobs } from "@graft/db/repo/blob";

/** The blob module's test seam. */
export type BlobDeps = {
  insertBlobs: typeof insertBlobs;
  findBlob: typeof findBlob;
  listBlobs: typeof listBlobs;
  now: () => Date;
};

export const defaultBlobDeps: BlobDeps = {
  insertBlobs,
  findBlob,
  listBlobs,
  now: () => new Date(),
};
