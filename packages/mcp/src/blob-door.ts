import { type AgentScope, getBlobs, liveBlobBytes, type ServiceContext } from "@graft/core";
import type { BlobRow } from "@graft/db/repo/blob";
import { BLOB_QUOTA_BYTES, BLOB_REF_SCHEME, BLOB_TTL_MS, blobIdOf } from "@graft/runner";

import type { McpDeps } from "./deps";
import { type Refusal, refusal } from "./result";

/**
 * The door a run passes before a sandbox is touched (GRA-187; ADR 0023): every `blob://` ref in
 * the input is looked up in the `blob` table under the person and the agent, and the agent's live
 * bytes are measured against the quota. Three refusals, in the shape every other refusal of the
 * run takes (`result.ts`), each with a sentence the agent can act on:
 *
 *  - `blob_quota`: this agent's live blobs are at or over `BLOB_QUOTA_BYTES`. Judged first and on
 *    every run, a ref in the input or not, since any tool may write a blob; carries `bytes` and
 *    `quota`. Live is not removed and not yet expired, so the quota frees itself on the TTL.
 *  - `blob_not_found`: a ref with no row under this scope. A ref that is not well formed, one nobody
 *    wrote and one another agent wrote are one answer, and the sentence never says whose it is: a
 *    ref must not be a probe into what other agents hold (GRA-181, user story 11).
 *  - `blob_expired`: the row is there but its time has passed, or the sweep has removed the bytes
 *    (`removed_at`). The sentence names the TTL and says to run the producing tool again.
 *
 * The refs are read off the input's string leaves, arrays and nested objects included: the ref is
 * a plain string a module may take under any key (ADR 0023, "no JSON Schema marker"). Whole leaves
 * only, so a sentence that mentions a ref is not one; a module that reads a ref out of a longer
 * string meets the runner's own `blob_not_found` inside the run instead, which is safe and costs
 * an exec. The runner checks no expiry, so this door is the expiry's one judge.
 *
 * Reading a blob asks nothing (ADR 0008): the door sits after the input is validated and before
 * the approval gate, so a dead ref never reaches the person as an ask, and a dry run passes the
 * same door so `acquire`'s job learns of a dead ref here.
 */

/**
 * How deep an input may nest before the door refuses it as `input_invalid` (Greptile on #149): the
 * walk below is iterative, so a deep input can never overflow the stack, and the bound is what
 * keeps a pathological input from being walked at all. Sixty-four levels is far past any tool's
 * schema and far short of anything that costs.
 */
export const MAX_INPUT_DEPTH = 64;

/**
 * Every distinct `blob://` string leaf of a value, in walk order, and whether the walk stopped at a
 * value nested past `MAX_INPUT_DEPTH`: an explicit stack rather than recursion, so the depth of
 * the input is never the depth of the call stack, and `tooDeep` is the caller's to refuse
 * (`admitBlobs` answers `input_invalid`; `acquire`'s job leaves the dry run's door to say so).
 */
export function blobRefsIn(input: unknown): { refs: string[]; tooDeep: boolean } {
  const refs = new Set<string>();
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof value === "string") {
      if (value.startsWith(BLOB_REF_SCHEME)) refs.add(value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (depth >= MAX_INPUT_DEPTH) return { refs: [...refs], tooDeep: true };
    // Pushed in reverse, so the pop order is the input's own: walk order is what the refusal's
    // "first dead ref" means (`judgeBlobRefs`).
    const items = Array.isArray(value) ? value : Object.values(value);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      stack.push({ value: items[i], depth: depth + 1 });
    }
  }
  return { refs: [...refs], tooDeep: false };
}

const MIB = 1024 * 1024;
const TTL_HOURS = BLOB_TTL_MS / (60 * 60 * 1000);

/** The quota rule over the number alone, so a suite can pin the boundary without rows. */
export function judgeBlobQuota(liveBytes: number, quota = BLOB_QUOTA_BYTES): Refusal | null {
  if (liveBytes < quota) return null;
  const held = Math.round(liveBytes / MIB);
  const cap = Math.round(quota / MIB);
  return refusal(
    "blob_quota",
    `This agent's live blobs come to ${held} MiB, at or over the ${cap} MiB quota, so no tool can run for it until some expire: any tool may write a blob. A blob lives ${TTL_HOURS} hours from its write and stops counting once it has expired, the oldest first. Run the tool again once one has.`,
    { bytes: liveBytes, quota },
  );
}

/**
 * The refs judged against the rows found under the scope, in the order the input named them: the
 * first ref with no row is `blob_not_found`, the first with a row past its time or removed is
 * `blob_expired`, and every ref live is null. Pure, so the sentences and the order are pinned
 * without a store.
 */
export function judgeBlobRefs(
  refs: readonly string[],
  rows: readonly BlobRow[],
  now: Date,
): Refusal | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const ref of refs) {
    const id = blobIdOf(ref);
    const row = id === null ? undefined : byId.get(id);
    if (!row) {
      return refusal(
        "blob_not_found",
        `${ref} names no blob this agent holds. Run the tool that produced it again and pass the ref it answers.`,
        { ref },
      );
    }
    if (row.removedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
      return refusal(
        "blob_expired",
        `${ref} has expired: a blob lives ${TTL_HOURS} hours from its write, and this one's time has passed. Run the tool that produced it again and pass the new ref.`,
        { ref },
      );
    }
  }
  return null;
}

/**
 * What the door answers when the run may go: the bytes this run may still commit under the quota,
 * which the run hands the exec as `GRAFT_BLOB_BUDGET_BYTES` (`blobBudgetEnvironment`). The door's
 * own check runs once, before the run; a module could otherwise loop `ctx.blob.write` and commit
 * 256 MiB per call with nothing bounding the total inside one run (Greptile on #145). Only the door
 * knows the live figure, so the runner is told the remainder and never reads the database.
 *
 * The remainder is the quota less the live rows **less what the door has already handed to this
 * agent's runs still in flight** (`InFlightRegistry.outstandingBudget`, `in-flight.ts`): two runs
 * admitted from the same rows would otherwise each be handed the whole remainder and together
 * commit twice it (Greptile on #148). The run holds its grant from admission until it settles, a
 * detached run's until its poll settles it or its time is up, the same places its in-flight hold
 * is released. The record is per process, which is the deployment shape in both forms today: this
 * server is the only one that starts an agent's runs (`in-flight.ts`'s header). The day two
 * replicas admit runs for one agent, the budget has to be reserved where the rows are, which is
 * ADR 0023's option C (a server-side blob seam) rather than a second copy of this registry.
 */
export type BlobAdmission = { budgetBytes: number };

/**
 * The door, as `run.ts` calls it: the quota over one read, then the input's refs over one more
 * when there are any. An admission lets the run go on with its budget; a refusal is answered as it
 * stands, `isError: true`, with a `refused` ledger row the caller writes.
 */
export async function admitBlobs(
  deps: McpDeps,
  scope: AgentScope,
  input: unknown,
): Promise<{ ok: true; admission: BlobAdmission } | { ok: false; refusal: Refusal }> {
  const ctx: ServiceContext = { db: deps.db };
  const live = await liveBlobBytes(ctx, scope, deps.blob);
  const quota = judgeBlobQuota(live);
  if (quota) return { ok: false, refusal: quota };
  const outstanding = deps.inFlight?.outstandingBudget(scope.agentId) ?? 0;
  const admission = { budgetBytes: Math.max(0, BLOB_QUOTA_BYTES - live - outstanding) };
  const { refs, tooDeep } = blobRefsIn(input);
  if (tooDeep) {
    return {
      ok: false,
      refusal: refusal(
        "input_invalid",
        `The input nests more than ${MAX_INPUT_DEPTH} levels deep, which no tool's schema calls for; flatten it.`,
        { maxDepth: MAX_INPUT_DEPTH },
      ),
    };
  }
  if (refs.length === 0) return { ok: true, admission };
  const ids = refs.map(blobIdOf).filter((id): id is string => id !== null);
  const rows = await getBlobs(ctx, scope, ids, deps.blob);
  const dead = judgeBlobRefs(refs, rows, deps.blob.now());
  return dead ? { ok: false, refusal: dead } : { ok: true, admission };
}

/**
 * The admission as the exec's environment: the budget, and the quota beside it so the runner's
 * `blob_quota` sentence names the same number the door's does. Both are `GRAFT_*`, so the runner
 * deletes them with the rest before the module loads; `runner.mjs` reads them once.
 */
export function blobBudgetEnvironment(admission: BlobAdmission): Record<string, string> {
  return {
    GRAFT_BLOB_BUDGET_BYTES: String(admission.budgetBytes),
    GRAFT_BLOB_QUOTA_BYTES: String(BLOB_QUOTA_BYTES),
  };
}
