import { listAgentPersonIds } from "@graft/db/repo/agent";
import {
  findBlob,
  findBlobs,
  insertAdoptedBlob,
  insertBlobs,
  listAgentsWithUnremovedBlobs,
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
  /**
   * The blob pass's roster (GRA-195; `listBlobSweepAgents`): the two reads with no person in
   * them, every agent with an unremoved row, and whose an agent id the store listed is.
   */
  listAgentsWithUnremovedBlobs: typeof listAgentsWithUnremovedBlobs;
  listAgentPersonIds: typeof listAgentPersonIds;
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
  listAgentsWithUnremovedBlobs,
  listAgentPersonIds,
  now: () => new Date(),
};
