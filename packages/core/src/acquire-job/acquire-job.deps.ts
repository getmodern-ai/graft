import {
  addAcquireJobTokenSpend,
  appendAcquireJobProgress,
  claimAcquireJob,
  findAcquireJob,
  heartbeatAcquireJob,
  insertAcquireAttempt,
  insertAcquireJob,
  insertAcquireTrace,
  listAcquireAttempts,
  listAcquireJobs,
  listAcquireTraces,
  listRunnableAcquireJobs,
  recordAcquireJobAttempt,
  updateAcquireAttempt,
  updateAcquireJob,
} from "@graft/db/repo/acquire-job";
import { findConnection } from "@graft/db/repo/connection";

/** The acquire-job module's test seam: the job, its attempts, its trace, and the runner's two reads. */
export type AcquireJobDeps = {
  insertAcquireJob: typeof insertAcquireJob;
  findAcquireJob: typeof findAcquireJob;
  listAcquireJobs: typeof listAcquireJobs;
  updateAcquireJob: typeof updateAcquireJob;
  appendAcquireJobProgress: typeof appendAcquireJobProgress;
  recordAcquireJobAttempt: typeof recordAcquireJobAttempt;
  addAcquireJobTokenSpend: typeof addAcquireJobTokenSpend;
  heartbeatAcquireJob: typeof heartbeatAcquireJob;
  /** The runner's roster and claim — the two unscoped statements (`repo/acquire-job.ts` says why). */
  listRunnableAcquireJobs: typeof listRunnableAcquireJobs;
  claimAcquireJob: typeof claimAcquireJob;
  insertAcquireAttempt: typeof insertAcquireAttempt;
  updateAcquireAttempt: typeof updateAcquireAttempt;
  listAcquireAttempts: typeof listAcquireAttempts;
  insertAcquireTrace: typeof insertAcquireTrace;
  listAcquireTraces: typeof listAcquireTraces;
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
  addAcquireJobTokenSpend,
  heartbeatAcquireJob,
  listRunnableAcquireJobs,
  claimAcquireJob,
  insertAcquireAttempt,
  updateAcquireAttempt,
  listAcquireAttempts,
  insertAcquireTrace,
  listAcquireTraces,
  findConnection,
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
};
