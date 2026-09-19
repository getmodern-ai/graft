import type { AgentScope } from "@graft/core";
import { getAcquireJob } from "@graft/core";
import type { AcquireJobRow } from "@graft/db/repo/acquire-job";

import type { McpDeps } from "../deps";

/**
 * Wait for news of a job, so patience is the protocol's and not a rule the model has to obey
 * (GRA-125). A chat model polled `acquire_status` seven times in twelve seconds, then wrote and ran
 * its own code through `execute__` while the job it had started went on to succeed unused. So
 * `acquire` holds its call until the job settles or `handoff.waitMs` passes — the approvals' wait,
 * `GRAFT_APPROVAL_WAIT_SECONDS` — and `acquire_status` holds its call until the job has a progress
 * line newer than the caller has seen or has settled, up to `STATUS_WAIT_MS`. Polling the row is
 * what the console does too; the runner writes progress as it goes.
 */

/** The longest `acquire_status` waits for a new line; the approvals' wait bounds it below. */
export const STATUS_WAIT_MS = 20_000;
/** How often the wait looks at the row; a test sets `handoff.pollMs` low. */
export const DEFAULT_POLL_MS = 1_000;

export function isSettled(job: Pick<AcquireJobRow, "status">): boolean {
  return job.status === "succeeded" || job.status === "failed";
}

export type AwaitJobOptions = {
  /** Return when the job has more progress lines than this; `Infinity` waits for settlement alone. */
  sinceProgress: number;
  maxWaitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The job as soon as it has news, or as it stands when the wait runs out; null when it is not
 * this agent's. News: settled, or more progress lines than `sinceProgress`.
 */
export async function awaitJobNews(
  ctx: Parameters<typeof getAcquireJob>[0],
  scope: AgentScope,
  jobId: string,
  deps: McpDeps,
  options: AwaitJobOptions,
): Promise<AcquireJobRow | null> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? deps.handoff.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + Math.max(0, options.maxWaitMs);
  let job = await getAcquireJob(ctx, scope, jobId, deps.acquireJob);
  while (job && !isSettled(job) && job.progress.length <= options.sinceProgress) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
    job = await getAcquireJob(ctx, scope, jobId, deps.acquireJob);
  }
  return job;
}
