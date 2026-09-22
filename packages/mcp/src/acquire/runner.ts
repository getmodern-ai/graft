import { claimRunnableAcquireJobs } from "@graft/core";
import type { AcquireJobRow, RunnableAcquireJob } from "@graft/db/repo/acquire-job";

import { newBlobTally, outsideBlobTally, runUnderBlobTally } from "../blobs";
import type { McpDeps } from "../deps";
import { errorMessage } from "../sandbox";
import { DEFAULT_HEARTBEAT_MS, runAcquireJob } from "./job";

/**
 * The `acquire` job runner: a plain in-process scheduler like the sweep's (`../sweep.ts`; GRA-1,
 * "No Temporal"). On a tick it takes what it may — queued jobs, and running jobs whose heartbeat has
 * gone stale, up to its concurrency — and runs each through `runAcquireJob`. Two things wake it: the
 * poll timer, and `kick`, which the `acquire` meta-tool calls the moment a job is queued so a job
 * starts at once rather than at the next poll. Never two ticks at once; a kick during a tick is one
 * more tick after it.
 *
 * **Resumable on restart, by claim.** Nothing is remembered across processes but the rows: a job
 * queued before the server stopped is picked up as queued; one that was running is picked up once
 * its heartbeat is older than `staleAfterSeconds`, since a live runner stamps every
 * `DEFAULT_HEARTBEAT_MS`. The claim is one statement (`claimAcquireJob`), so two servers on one
 * database cannot both run a job, and a job resumed by a second runner starts its conversation over
 * with its attempts and tokens already counted (`./job.ts`). The cost of in-process: a job whose
 * process dies is stalled for the stale bound before anyone notices, which the alpha accepts.
 */

export type AcquireRunnerOptions = {
  /** Jobs at once — `GRAFT_ACQUIRE_CONCURRENCY`. */
  concurrency: number;
  /** Seconds between polls for queued and stale jobs. A test may pass a fraction. */
  pollIntervalSeconds?: number;
  /** A running job whose heartbeat is older than this is another process's dead job. */
  staleAfterSeconds?: number;
  /** How often a job stamps its heartbeat; a test may lower both bounds together. */
  heartbeatMs?: number;
  now?: () => Date;
  onEvent?: (event: AcquireRunnerEvent) => void;
  /** A tick that threw as a whole — the roster read, say. A job's own failure is written to the job. */
  onError?: (error: unknown) => void;
};

/**
 * Every event names the agent and its person: the process line reads by agent, and the server's
 * analytics file the job's end on the person's profile (GRA-100), so both ride from the claim.
 */
export type AcquireRunnerEvent =
  | { kind: "claimed"; jobId: string; agentId: string; personId: string; resumed: boolean }
  | {
      kind: "finished";
      jobId: string;
      agentId: string;
      personId: string;
      status: AcquireJobRow["status"] | "gone";
      /** A failed job's `failure: message`, so the process log names the cause beside the status. */
      failure?: string;
      /** How many drafts the job made and what it spent — `acquire_attempt` rows and the token ceiling's counter. */
      attempts?: number;
      tokenSpend?: number;
      /**
       * The blobs the job's runs wrote and the ledger lines refused (GRA-186; `../blobs.ts`), from
       * the job's own tally: a job runs on the scheduler, not on the call that queued it, so its
       * writes are reported here and never on that call's `tool_called` event.
       */
      blobsWritten: number;
      blobsDropped: number;
    }
  | {
      kind: "failed";
      jobId: string;
      agentId: string;
      personId: string;
      error: string;
      /** The same two counts as `finished`: a job that crashed after a write still wrote it. */
      blobsWritten: number;
      blobsDropped: number;
    };

export type AcquireRunner = {
  /** Poll now — coalesced: a kick during a tick schedules one more tick, never a parallel one. */
  kick(): void;
  /** Start the poll timer and kick once, so a restart picks up what the last process left. */
  start(): void;
  /** Stop the timer. Jobs in flight run on; their heartbeat stops with the process. */
  stop(): void;
  /** Resolves when no job is running and no tick is pending. For tests and a graceful shutdown. */
  idle(): Promise<void>;
  running(): number;
};

export const DEFAULT_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_STALE_AFTER_SECONDS = 120;

export function createAcquireRunner(deps: McpDeps, options: AcquireRunnerOptions): AcquireRunner {
  const pollMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1_000;
  const staleAfterMs = (options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS) * 1_000;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const ctx = { db: deps.db };
  const running = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking: Promise<void> | null = null;
  let again = false;
  let kickScheduled = false;
  const idleWaiters: (() => void)[] = [];

  const settleIdle = () => {
    if (running.size === 0 && ticking === null && !kickScheduled) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };

  const start = (claimed: RunnableAcquireJob): void => {
    const { job } = claimed;
    options.onEvent?.({
      kind: "claimed",
      jobId: job.id,
      agentId: job.agentId,
      personId: claimed.personId,
      resumed: job.attempts > 0 || job.tokenSpend > 0,
    });
    // A tally of the job's own (`../blobs.ts`): the dry run's blobs, and later a fixture's, are
    // counted on this job's event, whichever call or tick started it.
    const tally = newBlobTally();
    const work = runUnderBlobTally(tally, () =>
      runAcquireJob(deps, claimed, { heartbeatMs, now: options.now }),
    )
      .then(
        (row) => {
          options.onEvent?.({
            kind: "finished",
            jobId: job.id,
            agentId: job.agentId,
            personId: claimed.personId,
            status: row?.status ?? "gone",
            ...(row?.status === "failed" ? { failure: describeFailure(row.result) } : {}),
            ...(row ? { attempts: row.attempts, tokenSpend: row.tokenSpend } : {}),
            blobsWritten: tally.written,
            blobsDropped: tally.dropped,
          });
        },
        (error: unknown) => {
          options.onEvent?.({
            kind: "failed",
            jobId: job.id,
            agentId: job.agentId,
            personId: claimed.personId,
            error: errorMessage(error),
            blobsWritten: tally.written,
            blobsDropped: tally.dropped,
          });
        },
      )
      .finally(() => {
        running.delete(job.id);
        // A slot opened: whatever is queued behind this job gets it without waiting for the poll.
        kick();
        settleIdle();
      });
    running.set(job.id, work);
  };

  const tick = async (): Promise<void> => {
    const room = options.concurrency - running.size;
    if (room <= 0) return;
    const claimed = await claimRunnableAcquireJobs(
      ctx,
      { staleAfterMs, limit: room },
      deps.acquireJob,
    );
    for (const job of claimed) start(job);
  };

  const runTick = (): void => {
    if (ticking) {
      again = true;
      return;
    }
    ticking = tick()
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        ticking = null;
        if (again) {
          again = false;
          runTick();
        } else {
          settleIdle();
        }
      });
  };

  const kick = (): void => {
    if (kickScheduled) return;
    kickScheduled = true;
    // Off the caller's stack: the meta-tool answers before the roster is read. And outside the
    // caller's blob tally, so a tick claiming jobs across agents inherits nothing of the call that
    // kicked it (`../blobs.ts`, Greptile on #144).
    outsideBlobTally(() =>
      setTimeout(() => {
        kickScheduled = false;
        runTick();
      }, 0),
    ).unref?.();
  };

  return {
    kick,
    start() {
      if (timer) return;
      timer = setInterval(runTick, pollMs);
      timer.unref?.();
      kick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    idle() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
    running: () => running.size,
  };
}

/** `failure: message` from a failed job's result — the shape `shapes.ts`'s `AcquireFailure` writes. */
function describeFailure(result: AcquireJobRow["result"]): string {
  const failure = typeof result?.failure === "string" ? result.failure : "failed";
  const message = typeof result?.message === "string" ? result.message : "";
  return message ? `${failure}: ${message}` : failure;
}
