import type { AcquireJobRow } from "@graft/db/repo/acquire-job";

/**
 * What `acquire` and `acquire_status` answer (GRA-29), and what a job's `result` column holds —
 * one file, so the meta-tool, the job and a reader of the row cannot disagree about a field name.
 * GRA-31's evals and GRA-33's compose read these shapes; a change here is an `interface:` commit.
 *
 * A success names the tool three ways on purpose (GRA-78): the wire name a refreshed list shows,
 * `vendor` and `name` as `run_tool` takes them, and `inputSchema`, because a client that snapshots
 * its list per conversation (Claude.ai, 2026-09-17) never sees the promoted tool and `run_tool` is
 * the only path to it; `next` says so in one sentence. No `outputSchema`: authored tools declare
 * none, and `run_tool` answers the vendor verbatim.
 *
 * The refusals follow GRA-23's conventions and `result.ts`'s shape: `{ error: "refused", reason,
 * message }`, with the build ask's `awaiting_approval` body passed through from `approval.ts`.
 */

/**
 * `acquire`'s answer once a job exists is `AcquireStatus` (GRA-125): the call waits the approvals'
 * wait for the job, so a fast job answers settled with `result`, and a slow one answers `queued` or
 * `running` with the lines so far. Until GRA-125 this was `AcquireStarted`, the id and the first
 * line at once.
 */
export type AcquireStarted = AcquireStatus;

/** The job succeeded: the tool is published, promoted for the calling agent, and in its list. */
export type AcquireSuccess = {
  /** The wire name, `<vendor>__<name>`. */
  tool: string;
  /** The two halves of the wire name, as `run_tool` takes them. */
  vendor: string;
  name: string;
  toolId: string;
  version: number;
  /** The tool's published JSON Schema; what `run_tool`'s `input` must match. */
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  /** One sentence on what to do now, for a client whose tool list has not refreshed. */
  next: string;
};

/** `AcquireSuccess.next`: the tool is promoted; where the list has not refreshed, `run_tool` calls it. */
export function acquireNextStep(vendor: string, name: string): string {
  return `${vendor}__${name} is promoted into your working set; where your tool list has not refreshed, run_tool { vendor: "${vendor}", name: "${name}", input } calls it, with input matching inputSchema.`;
}

/**
 * Why a job ended without a tool — one word the agent and the console can branch on, and the
 * sentence that says it. `attempt_budget` and `token_ceiling` are the two bounds ADR 0004 names;
 * `vendor_unreachable` is the proxy getting no response from the vendor on a proof read or the dry
 * run (GRA-79) — the network's, not the module's, so the job ends on it at once; the rest are the
 * loop finding it cannot go on.
 */
export const ACQUIRE_FAILURES = [
  "attempt_budget",
  "token_ceiling",
  "turn_budget",
  "model_gave_up",
  "model_failed",
  "connection_unavailable",
  "build_approval_missing",
  "sandbox_unavailable",
  "vendor_unreachable",
  "job_failed",
] as const;
export type AcquireFailureKind = (typeof ACQUIRE_FAILURES)[number];

/**
 * One attempt as the failure result summarises it — what was tried, in order. `summary` is the
 * loop's account of how *this* attempt ended (the rules the check refused, the reads that failed,
 * the dry run's verdict, the reason the model gave up); `note` is what the model said when it
 * drafted it. The two were one field until GRA-70, when the next draft's note was found standing
 * in for the previous attempt's ending.
 */
export type AcquireAttemptSummary = {
  attempt: number;
  outcome: string;
  /** How the attempt ended, in the loop's words: the one line that stopped it. */
  summary: string;
  /** The model's note on the draft that opened the attempt; null when the row has none. */
  note: string | null;
};

export type AcquireFailure = {
  failure: AcquireFailureKind;
  message: string;
  /** The last attempt's diagnostics — the check's refusals, the proof reads, the dry-run report — or the error that ended the job. */
  lastDiagnostics: unknown;
  tried: AcquireAttemptSummary[];
};

export type AcquireResult = AcquireSuccess | AcquireFailure;

export function isAcquireFailure(result: AcquireResult): result is AcquireFailure {
  return "failure" in result;
}

/** `acquire_status`'s answer: the job as the agent may see it. */
export type AcquireStatus = {
  jobId: string;
  status: AcquireJobRow["status"];
  progress: string[];
  attempts: number;
  result?: AcquireResult;
};

export function acquireStatusOf(job: AcquireJobRow): AcquireStatus {
  const result = job.result as AcquireResult | null;
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    ...(result && (job.status === "succeeded" || job.status === "failed") ? { result } : {}),
  };
}

/** The bounds a job is held to — the environment's, or these when a deployment sets none. */
export type AcquireConfig = {
  /** Drafts per job — `GRAFT_ACQUIRE_MAX_ATTEMPTS`. */
  maxAttempts: number;
  /** Tokens per job, input and output summed — `GRAFT_ACQUIRE_TOKEN_CEILING`. */
  tokenCeiling: number;
  /**
   * How long the publish waits between asks when the toolbox store finds nothing at a draft the
   * check just read (GRA-141), one wait per element; `DEFAULT_STORE_MISS_RETRY_DELAYS_MS` when unset.
   * A test passes short ones.
   */
  storeMissRetryDelaysMs?: readonly number[];
};

/** The same figures `@graft/env`'s `acquireMaxAttempts` and `acquireTokenCeiling` default to. */
export const DEFAULT_ACQUIRE_CONFIG: AcquireConfig = { maxAttempts: 4, tokenCeiling: 400_000 };

/**
 * About four seconds in all before a store miss reaches the model. The hosted store's view of a
 * path another sandbox wrote lagged for tens of seconds at worst on 2026-09-20; the job writes the
 * draft through the store first (`job.ts`), and these waits are the floor under that.
 */
export const DEFAULT_STORE_MISS_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];
