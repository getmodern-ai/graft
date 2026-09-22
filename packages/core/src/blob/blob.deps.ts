import {
  findBlob,
  findBlobs,
  insertAdoptedBlob,
  insertBlobs,
  listBlobs,
  listUnremovedBlobs,
  markBlobRemoved,
  sumLiveBlobBytes,
} from "@graft/db/repo/blob";

/** The blob module's test seam. */
export type BlobDeps = {
  insertBlobs: typeof insertBlobs;
  findBlob: typeof findBlob;
  findBlobs: typeof findBlobs;
  listBlobs: typeof listBlobs;
  sumLiveBlobBytes: typeof sumLiveBlobBytes;
  /** The sweep's three (GRA-189): what it judges, how it marks, how it adopts. */
  listUnremovedBlobs: typeof listUnremovedBlobs;
  markBlobRemoved: typeof markBlobRemoved;
  insertAdoptedBlob: typeof insertAdoptedBlob;
  now: () => Date;
};

export const defaultBlobDeps: BlobDeps = {
  insertBlobs,
  findBlob,
  findBlobs,
  listBlobs,
  sumLiveBlobBytes,
  listUnremovedBlobs,
  markBlobRemoved,
  insertAdoptedBlob,
  now: () => new Date(),
};
