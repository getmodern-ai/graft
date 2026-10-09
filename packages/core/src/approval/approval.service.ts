import type { ApprovalRow, BuildApprovalRow, VendorApprovalRow } from "@graft/db/repo/approval";
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
 * read-only asks once). The tool must be the person's. A second answer replaces the first. The
 * ask-every-call setting rides the same write when the answer carried one (the console card's
 * switch, the form's field) and is kept as it stood when it did not — a Hermes button carries
 * none. One upsert, so the answer path never has to touch the setting on its own.
 */
export async function setApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  toolId: string,
  decision: ApprovalDecision,
  deps: ApprovalDeps,
  options: { askEveryCall?: boolean } = {},
): Promise<ApprovalRow> {
  orNotFound(await deps.findAuthoredToolById(ctx.db, scope.personId, toolId), "Tool not found");
  return deps.upsertApproval(ctx.db, {
    agentId: scope.agentId,
    toolId,
    decision,
    decidedAt: deps.now(),
    ...(options.askEveryCall === undefined ? {} : { askEveryCall: options.askEveryCall }),
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
 * ADR 0008 applied to one call: the tool's annotations, the agent's standing approval for the tool,
 * and the agent's standing approval for the tool's integration (the amendment of 2026-10-09). A
 * read passes before either row is read; the integration's row is read only when the tool's own
 * says nothing, since a tool's own answer and setting win over it.
 */
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
  const annotations = { readOnly: tool.readOnly, destructive: tool.destructive };
  if (tool.readOnly) return approvalDecision({ annotations, approval: null });
  const approval = await deps.findApproval(ctx.db, scope, toolId);
  const vendorApproval = approval
    ? null
    : await deps.findVendorApproval(ctx.db, scope, tool.vendor);
  return approvalDecision({
    annotations,
    approval: approval
      ? { decision: approval.decision, askEveryCall: approval.askEveryCall }
      : null,
    vendorApproval: vendorApproval
      ? { includesDestructive: vendorApproval.includesDestructive }
      : null,
  });
}

/** The agent's standing approval for every tool of one integration (GRA-237), or null. */
export async function getVendorApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow | null> {
  return deps.findVendorApproval(ctx.db, scope, vendor);
}

/** What the agent's page lists beside the per-tool approvals: one row per integration allowed. */
export async function listVendorApprovals(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow[]> {
  return deps.listVendorApprovals(ctx.db, scope);
}

/**
 * The person's "Allow every <integration> tool for this agent" (ADR 0008 as amended 2026-10-09;
 * GRA-237), recorded so it holds: one row per agent and vendor, a later answer replacing the
 * destructive choice of an earlier one. Only ever the person's answer, from the console's card or
 * the ask card's `answer_ask` (ADR 0004, ADR 0006); no agent argument reaches here. The write
 * inserts only for an agent of the person's, so a scope naming another person's agent is
 * `NOT_FOUND`.
 */
export async function allowVendor(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  options: { includesDestructive: boolean },
  deps: ApprovalDeps,
): Promise<VendorApprovalRow> {
  return orNotFound(
    await deps.upsertVendorApproval(ctx.db, scope, {
      vendor,
      includesDestructive: options.includesDestructive,
      grantedAt: deps.now(),
    }),
    "Agent not found",
  );
}

/**
 * Withdraw the agent's standing approval for an integration, from the agent's page. Its tools ask
 * again on their next call, each once, unless a tool's own answer stands. Null when none stood.
 */
export async function withdrawVendorApproval(
  ctx: ServiceContext,
  scope: AgentScope,
  vendor: string,
  deps: ApprovalDeps,
): Promise<VendorApprovalRow | null> {
  return deps.deleteVendorApproval(ctx.db, scope, vendor);
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
