import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { ApprovalDecision } from "@graft/db/schema/approval";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import { type ApprovalVerdict, approvalDecision } from "./approval.decision";
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
 * The person's answer to a tool's ask, recorded so it holds (ADR 0008: any tool that is not
 * read-only asks once). The tool must be the person's. A second answer replaces the first; the
 * ask-every-call setting, if any, is kept.
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
 * Turn a tool's ask-every-call setting on or off for one agent, from the ask or the agent's page
 * (ADR 0008, amendment of 2026-09-15: asking on every call is the person's opt-in per tool, both
 * ways). Refused as `BAD_REQUEST` for a read-only tool — it never asks, so there is nothing to set
 * — and `NOT_FOUND` when no approval stands yet: the setting is an amendment to an answer, not an
 * answer.
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
  return orNotFound(
    await deps.updateAskEveryCall(ctx.db, scope, toolId, on),
    "No approval stands for this tool yet — answer its first ask before changing how it asks",
  );
}

/**
 * Withdraw the standing answer, from the console (ADR 0008: the record is the person's to revisit).
 * The tool asks again on its next call, as if never answered — the one way back from a `deny`.
 * The ask-every-call setting goes with the row; the next answer starts it off again. Null when
 * nothing stood.
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
      ? { decision: approval.decision, askEveryCall: approval.askEveryCall }
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
