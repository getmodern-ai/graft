import { claimRunnableAcquireJobs } from "@graft/core";
import type { AcquireJobRow, RunnableAcquireJob } from "@graft/db/repo/acquire-job";

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

export type AcquireRunnerEvent =
  | { kind: "claimed"; jobId: string; agentId: string; resumed: boolean }
  | { kind: "finished"; jobId: string; agentId: string; status: AcquireJobRow["status"] | "gone" }
  | { kind: "failed"; jobId: string; agentId: string; error: string };

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
      resumed: job.attempts > 0 || job.tokenSpend > 0,
    });
    const work = runAcquireJob(deps, claimed, { heartbeatMs, now: options.now })
      .then(
        (row) => {
          options.onEvent?.({
            kind: "finished",
            jobId: job.id,
            agentId: job.agentId,
            status: row?.status ?? "gone",
          });
        },
        (error: unknown) => {
          options.onEvent?.({
            kind: "failed",
            jobId: job.id,
            agentId: job.agentId,
            error: errorMessage(error),
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
    // Off the caller's stack: the meta-tool answers before the roster is read.
    setTimeout(() => {
      kickScheduled = false;
      runTick();
    }, 0).unref?.();
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
