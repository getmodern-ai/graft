import {
  appendAcquireJobProgress,
  findAcquireJob,
  insertAcquireJob,
  listAcquireJobs,
  recordAcquireJobAttempt,
  updateAcquireJob,
} from "@graft/db/repo/acquire-job";
import { findConnection } from "@graft/db/repo/connection";

/** The acquire-job module's test seam. */
export type AcquireJobDeps = {
  insertAcquireJob: typeof insertAcquireJob;
  findAcquireJob: typeof findAcquireJob;
  listAcquireJobs: typeof listAcquireJobs;
  updateAcquireJob: typeof updateAcquireJob;
  appendAcquireJobProgress: typeof appendAcquireJobProgress;
  recordAcquireJobAttempt: typeof recordAcquireJobAttempt;
  /** The job's connection must be the person's. */
  findConnection: typeof findConnection;
  newId: () => string;
  now: () => Date;
};

export const defaultAcquireJobDeps: AcquireJobDeps = {
  insertAcquireJob,
  findAcquireJob,
  listAcquireJobs,
  updateAcquireJob,
  appendAcquireJobProgress,
  recordAcquireJobAttempt,
  findConnection,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
