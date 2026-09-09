import type { UsageLedgerRow } from "@graft/db/repo/usage";
import type { UsageOutcome } from "@graft/db/schema/usage";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { AgentScope } from "../tenancy";
import type { LedgerDeps } from "./ledger.deps";

/**
 * The usage ledger (ADR 0009, ADR 0012): one line per invocation, written by the MCP server after
 * every call — meta-tools included, with no tool id — and read by the contraction rule and, later,
 * the repair and mining levels. Append-only.
 */

export type UsageInput = {
  /** Null for a meta-tool, which has no toolbox row. */
  toolId?: string | null;
  versionId?: string | null;
  toolName: string;
  outcome: UsageOutcome;
  dryRun?: boolean;
  latencyMs: number;
};

export async function recordUsage(
  ctx: ServiceContext,
  scope: AgentScope,
  input: UsageInput,
  deps: LedgerDeps,
): Promise<UsageLedgerRow> {
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
    throw new ServiceError("BAD_REQUEST", "Latency is a non-negative number of milliseconds");
  }
  if (input.toolName.trim().length === 0) {
    throw new ServiceError("BAD_REQUEST", "A ledger line names the tool that was called");
  }
  return deps.insertUsage(ctx.db, {
    id: deps.newId(),
    agentId: scope.agentId,
    toolId: input.toolId ?? null,
    versionId: input.versionId ?? null,
    toolName: input.toolName,
    outcome: input.outcome,
    dryRun: input.dryRun ?? false,
    latencyMs: Math.round(input.latencyMs),
    createdAt: deps.now(),
  });
}

export async function listUsage(
  ctx: ServiceContext,
  scope: AgentScope,
  args: { limit: number; since?: Date },
  deps: LedgerDeps,
): Promise<UsageLedgerRow[]> {
  return deps.listUsage(ctx.db, scope, args);
}

/** When each tool was last invoked by this agent — what the sweep reads (ADR 0009). */
export async function lastUsedAtByTool(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: LedgerDeps,
): Promise<{ toolId: string; lastUsedAt: Date }[]> {
  return deps.lastUsedAtByTool(ctx.db, scope);
}
