import type { UsageLedgerRow, VendorUsageRow } from "@graft/db/repo/usage";
import type { UsageOutcome } from "@graft/db/schema/usage";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { AgentScope, Principal } from "../tenancy";
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

export type { VendorUsageRow };

/**
 * The person's recent calls against one vendor, every agent's, newest first — what the console shows
 * beside a connection as its recent vendor calls (GRA-26). The ledger stands in for the proxy's wide
 * events here because those are not persisted; it records the invocation, not the HTTP exchange, so
 * a line says which tool ran, for which agent, and how it ended. `toolNames` are wire names to count
 * as the vendor's beside its tools' rows — the connection's `execute__<id>` tool, which has none.
 */
export async function listVendorUsage(
  ctx: ServiceContext,
  principal: Principal,
  args: { vendor: string; toolNames?: readonly string[]; limit: number },
  deps: LedgerDeps,
): Promise<VendorUsageRow[]> {
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new ServiceError("BAD_REQUEST", "The limit is a whole number of at least 1");
  }
  return deps.listUsageForVendor(ctx.db, principal.personId, {
    vendor: args.vendor,
    toolNames: args.toolNames ?? [],
    limit: args.limit,
  });
}
