import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ApprovalDecision } from "@graft/db/schema/approval";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import {
  type ApprovalVerdict,
  answerCarriesTo,
  approvalDecision,
  type ToolAnnotations,
} from "./approval.decision";
import type { ApprovalDeps } from "./approval.deps";

/**
 * Approvals (CONTEXT.md; ADR 0008): get and set the standing answer per agent per tool, turn a
 * tool's ask-every-call setting on or off, get and grant the once-per-agent-per-connection build
 * approval, and decide a call. The rule itself is `approvalDecision`, pure; this file reads the
 * rows it needs and applies it.
 */

export async function getApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow | null> {
  return deps.findApproval(ctx.db, scope, toolId);
}

export async function listApprovals(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ApprovalDeps,
): Promise<ApprovalRow[]> {
  return deps.listApprovals(ctx.db, scope);
}

/**
 * The version an ask was about, as the ask showed it (GRA-245, Greptile on #190): the id the ask's
 * payload or the gate's subject names, and the annotations the person read. `versionId` is null on
 * an ask made before asks named one, which records an answer that holds for no version, so the
 * tool asks once more.
 */
export type AskedVersion = {
  versionId: string | null;
  annotations: ToolAnnotations;
};

/**
 * The person's answer to a tool's ask, recorded so it holds (ADR 0008: any tool that is not
 * read-only asks once). The tool must be the person's. A second answer replaces the first. The
 * ask-every-call setting rides the same write when the answer carried one (the console card's
 * switch, the form's field) and is kept as it stood when it did not — a Hermes button carries
 * none. One upsert, so the answer path never has to touch the setting on its own.
 *
 * **An answer is for the version the person was shown** (`options.asked`; GRA-245, Greptile on
 * #190), never the tool's version when the answer arrives: an ask about v1 answered after v2
 * became current records for v1, and v2 still asks. Two exceptions, both under the tool row's lock
 * a stock advance takes, so an answer and an advance serialise:
 *
 * - an allow on a stock copy whose later versions were all advances that do not widen what the ask
 *   showed lands on the current version, as `advanceStockCopy` would have carried it had the answer
 *   come first (`answerCarriesTo`; ADR 0008 as amended 2026-10-09);
 * - an allow for an older version leaves an allow already standing for the current one where it
 *   is, so a late answer to an old ask never takes a standing yes back.
 */
export async function setApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  decision: ApprovalDecision,
  deps: ApprovalDeps,
  options: { asked: AskedVersion; askEveryCall?: boolean },
): Promise<ApprovalRow> {
  return ctx.db.transaction(async (tx) => {
    const tool = orNotFound(
      await deps.findAuthoredToolForUpdate(tx, scope.personId, toolId),
      "Tool not found",
    );
    const asked = options.asked.versionId;
    let toolVersionId = asked;
    if (decision === "allow" && asked !== tool.currentVersionId) {
      const current = tool.currentVersionId;
      const carries =
        asked !== null &&
        current !== null &&
        answerCarriesTo({
          versions: await deps.listToolVersionOrigins(tx, scope.personId, toolId),
          fromVersionId: asked,
          toVersionId: current,
          shown: options.asked.annotations,
          to: { readOnly: tool.readOnly, destructive: tool.destructive },
        });
      if (carries) {
        toolVersionId = current;
      } else {
        const standing = await deps.findApproval(tx, scope, toolId);
        if (standing?.decision === "allow" && isForVersion(standing, current)) return standing;
      }
    }
    return deps.upsertApproval(tx, {
      agentId: scope.agentId,
      toolId,
      decision,
      decidedAt: deps.now(),
      toolVersionId,
      ...(options.askEveryCall === undefined ? {} : { askEveryCall: options.askEveryCall }),
    });
  });
}

/**
 * Turn a tool's ask-every-call setting on or off for one agent, from the agent's page (ADR 0008,
 * amendment of 2026-09-15: asking on every call is the person's opt-in per tool, both ways).
 * Refused as `BAD_REQUEST` for a read-only tool — it never asks, so there is nothing to set — and
 * `NOT_FOUND` when no approval stands yet: the setting is an amendment to an answer, not an answer.
 *
 * A yes the person gave while the setting was on may still be waiting, answered and unconsumed,
 * for the agent's next call to take. It was given under the setting as it stood, so it is spent
 * here rather than carried into the new state — otherwise it would be found by a later call and
 * applied as if the person had just said it. The answer path does not come through here: it
 * writes the setting with the answer (`setApproval`), because the answer it is recording is the
 * one that must stay for the agent.
 */
export async function setAskEveryCall(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  on: boolean,
  deps: ApprovalDeps,
): Promise<ApprovalRow> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, toolId),
    "Tool not found",
  );
  if (tool.readOnly) {
    throw new ServiceError(
      "BAD_REQUEST",
      "A read-only tool never asks, so it cannot ask every call",
    );
  }
  const row = orNotFound(
    await deps.updateAskEveryCall(ctx.db, scope, toolId, on),
    "No approval stands for this tool yet — answer its first ask before changing how it asks",
  );
  await deps.settleAnsweredToolActions(ctx.db, scope, toolId, deps.now());
  return row;
}

/**
 * Withdraw the standing answer, from the console (ADR 0008: the record is the person's to revisit).
 * The tool asks again on its next call, as if never answered — the one way back from a `deny`.
 * The ask-every-call setting goes with the row; the next answer starts it off again. A per-call
 * yes still waiting for the agent is spent with it, for the reason `setAskEveryCall` gives: left
 * behind, it would re-create the row the person just removed. Null when nothing stood.
 */
export async function revokeApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow | null> {
  orNotFound(await deps.findAuthoredToolById(ctx.db, scope.personId, toolId), "Tool not found");
  const row = await deps.deleteApproval(ctx.db, scope, toolId);
  await deps.settleAnsweredToolActions(ctx.db, scope, toolId, deps.now());
  return row;
}

/**
 * Whether a standing answer was given for this version (ADR 0008: a republished write tool asks
 * again once; GRA-245). Null on either side is no version, which asks.
 */
export function isForVersion(
  approval: Pick<ApprovalRow, "toolVersionId">,
  versionId: string | null,
): boolean {
  return approval.toolVersionId !== null && approval.toolVersionId === versionId;
}

/**
 * ADR 0008 applied to one call, judged on **the version the call runs** (GRA-245, Greptile on
 * #190): the caller pins the version before the gate and passes its id and annotations, and the
 * standing answer counts only when it was given for that version, so a version made current and
 * approved meanwhile never lets an earlier one run on its approval.
 */
export async function decideToolCall(
  ctx: ServiceContext,
  scope: AgentScope,
  target: { toolId: string; versionId: string; annotations: ToolAnnotations },
  deps: ApprovalDeps,
): Promise<ApprovalVerdict> {
  orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, target.toolId),
    "Tool not found",
  );
  const approval = await deps.findApproval(ctx.db, scope, target.toolId);
  return approvalDecision({
    annotations: target.annotations,
    approval: approval
      ? {
          decision: approval.decision,
          askEveryCall: approval.askEveryCall,
          forThisVersion: isForVersion(approval, target.versionId),
        }
      : null,
  });
}

export async function getBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: ApprovalDeps,
): Promise<BuildApprovalRow | null> {
  return deps.findBuildApproval(ctx.db, scope, connectionId);
}

/**
 * Grant `acquire` against a connection, once per agent per connection (ADR 0008). The connection
 * must be the person's; whether it is in the agent's *scope* is `acquire`'s own check, made before
 * it asks. Idempotent: a repeated grant answers the standing row.
 */
export async function grantBuildApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: ApprovalDeps,
): Promise<BuildApprovalRow> {
  orNotFound(
    await deps.findConnection(ctx.db, scope.personId, connectionId),
    "Connection not found",
  );
  const inserted = await deps.insertBuildApproval(ctx.db, {
    agentId: scope.agentId,
    connectionId,
    grantedAt: deps.now(),
  });
  if (inserted) return inserted;
  return orNotFound(
    await deps.findBuildApproval(ctx.db, scope, connectionId),
    "Connection not found",
  );
}
