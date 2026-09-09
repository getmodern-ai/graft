import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ApprovalDecision } from "@graft/db/schema/approval";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import { type ApprovalVerdict, approvalDecision } from "./approval.decision";
import type { ApprovalDeps } from "./approval.deps";

/**
 * Approvals (CONTEXT.md; ADR 0008): get and set the standing answer per agent per tool, relax a
 * destructive tool's per-call ask, get and grant the once-per-agent-per-connection build approval,
 * and decide a call. The rule itself is `approvalDecision`, pure; this file reads the rows it
 * needs and applies it.
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
 * The person's answer to a tool's ask, recorded so it holds (ADR 0008: a write asks once). The tool
 * must be the person's. A second answer replaces the first; the relaxation, if any, is kept.
 */
export async function setApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  decision: ApprovalDecision,
  deps: ApprovalDeps,
): Promise<ApprovalRow> {
  orNotFound(await deps.findAuthoredToolById(ctx.db, scope.personId, toolId), "Tool not found");
  return deps.upsertApproval(ctx.db, {
    agentId: scope.agentId,
    toolId,
    decision,
    decidedAt: deps.now(),
  });
}

/**
 * Relax a destructive tool's per-call ask, from the console (ADR 0008). Refused as `BAD_REQUEST`
 * for a tool that is not destructive — there is nothing to relax — and `NOT_FOUND` when no approval
 * stands yet: relaxing is an amendment to an answer, not an answer.
 */
export async function relaxDestructiveApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, toolId),
    "Tool not found",
  );
  if (!tool.destructive) {
    throw new ServiceError("BAD_REQUEST", "Only a destructive tool's per-call ask can be relaxed");
  }
  return orNotFound(
    await deps.relaxApproval(ctx.db, scope, toolId),
    "No approval stands for this tool yet — answer its first ask before relaxing it",
  );
}

/**
 * Withdraw the standing answer, from the console (ADR 0008: the record is the person's to revisit).
 * The tool asks again on its next call, as if never answered — the one way back from a `deny`, and
 * the way to make a relaxed destructive tool ask per call again. Null when nothing stood.
 */
export async function revokeApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalRow | null> {
  orNotFound(await deps.findAuthoredToolById(ctx.db, scope.personId, toolId), "Tool not found");
  return deps.deleteApproval(ctx.db, scope, toolId);
}

/** ADR 0008 applied to one call: the tool's annotations and the agent's standing approval. */
export async function decideToolCall(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  deps: ApprovalDeps,
): Promise<ApprovalVerdict> {
  const tool = orNotFound(
    await deps.findAuthoredToolById(ctx.db, scope.personId, toolId),
    "Tool not found",
  );
  const approval = await deps.findApproval(ctx.db, scope, toolId);
  return approvalDecision({
    annotations: { readOnly: tool.readOnly, destructive: tool.destructive },
    approval: approval
      ? { decision: approval.decision, perCallRelaxed: approval.perCallRelaxed }
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
