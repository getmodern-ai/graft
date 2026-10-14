import type { VendorToolApprovalRow } from "@graft/db/repo/connection-access";
import type { AgentScopeMode } from "@graft/db/schema/agent";
import type { ApprovalDecision } from "@graft/db/schema/approval";

import { isForVersion } from "../approval/approval.service";
import type { ServiceContext } from "../context";
import type { Principal } from "../tenancy";
import type { ConnectionAccessDeps } from "./connection-access.deps";

/**
 * One tool approval as the access view reads it (ADR 0008): the answer, the version it was given
 * for, and whether that is the tool's current version. An `allow` for another version asks again
 * once (GRA-245), so `forCurrentVersion` is what says whether it still holds.
 */
export type ConnectionAccessToolApproval = {
  tool: VendorToolApprovalRow["tool"];
  decision: ApprovalDecision;
  askEveryCall: boolean;
  toolVersionId: string | null;
  forCurrentVersion: boolean;
  decidedAt: Date;
};

/** One active agent and what it may do with the connection and its vendor's tools. */
export type AgentConnectionAccess = {
  agent: {
    id: string;
    name: string;
    scopeMode: AgentScopeMode;
    /** The MCP client the agent was connected from (ADR 0018); null for a static-token agent. */
    connectedViaClientName: string | null;
  };
  /** Whether the agent's scope reaches the connection under its mode (ADR 0007). */
  inScope: boolean;
  /** The agent's last call against the vendor, dry runs excluded; null when it never called. */
  lastUsedAt: Date | null;
  /** Its answers for the vendor's tools, newest first. */
  toolApprovals: ConnectionAccessToolApproval[];
  /** Its standing approval for every tool of the vendor (ADR 0008 as amended 2026-10-09). */
  vendorApproval: { includesDestructive: boolean; grantedAt: Date } | null;
  /** Its build approval for this connection (ADR 0008). */
  buildApproval: { grantedAt: Date } | null;
};

/** `GET /api/connections/:id/access`'s answer. */
export type ConnectionAccess = {
  connectionId: string;
  vendor: string;
  /** Every active agent of the person's, oldest first, in scope or not. */
  agents: AgentConnectionAccess[];
};

/**
 * The integration page's Agents view (GRA-296): every active agent of the person's, whether the
 * connection is in its scope, when it last called the vendor, and every answer it holds for the
 * vendor's tools, the vendor and this connection. Seven statements however many agents there are:
 * the connection, then one per kind of record, each under the person (`repo/connection-access.ts`).
 * Null when the connection is not the person's, which the route answers as a 404.
 *
 * `executeToolName` spells a connection's own `execute__<id>` tool, which has no toolbox row and
 * is counted as the vendor's by its wire name, for every connection of the person's to the vendor,
 * since the last use is the vendor's and not this connection's alone; `@graft/mcp` owns that spelling, and the core does
 * not import it.
 */
export async function getConnectionAccess(
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  deps: ConnectionAccessDeps,
  options: { executeToolName: (connectionId: string) => string },
): Promise<ConnectionAccess | null> {
  const { personId } = principal;
  const connection = await deps.findConnection(ctx.db, personId, connectionId);
  if (!connection) return null;
  const { vendor } = connection;
  const lastVendorUse = async () => {
    const ids = await deps.listVendorConnectionIds(ctx.db, personId, vendor);
    return deps.lastVendorUseByAgent(ctx.db, personId, {
      vendor,
      toolNames: ids.map((id) => options.executeToolName(id)),
    });
  };
  const [agents, lastUses, toolApprovals, vendorApprovals, buildApprovals] = await Promise.all([
    deps.listAgentAccessForConnection(ctx.db, personId, connection.id),
    lastVendorUse(),
    deps.listVendorToolApprovals(ctx.db, personId, vendor),
    deps.listVendorApprovalsForVendor(ctx.db, personId, vendor),
    deps.listBuildApprovalsForConnection(ctx.db, personId, connection.id),
  ]);
  const lastUsed = new Map(lastUses.map((row) => [row.agentId, row.lastUsedAt]));
  const vendorApproval = new Map(vendorApprovals.map((row) => [row.agentId, row]));
  const buildApproval = new Map(buildApprovals.map((row) => [row.agentId, row]));
  const answersOf = Map.groupBy(toolApprovals, (row) => row.agentId);
  return {
    connectionId: connection.id,
    vendor,
    agents: agents.map((row) => {
      const standing = vendorApproval.get(row.id);
      const build = buildApproval.get(row.id);
      return {
        agent: {
          id: row.id,
          name: row.name,
          scopeMode: row.scopeMode,
          connectedViaClientName: row.connectedViaClientName,
        },
        inScope: row.inScope,
        lastUsedAt: lastUsed.get(row.id) ?? null,
        toolApprovals: (answersOf.get(row.id) ?? []).map((approval) => ({
          tool: approval.tool,
          decision: approval.decision,
          askEveryCall: approval.askEveryCall,
          toolVersionId: approval.toolVersionId,
          forCurrentVersion: isForVersion(approval, approval.tool.currentVersionId),
          decidedAt: approval.decidedAt,
        })),
        vendorApproval: standing
          ? { includesDestructive: standing.includesDestructive, grantedAt: standing.grantedAt }
          : null,
        buildApproval: build ? { grantedAt: build.grantedAt } : null,
      };
    }),
  };
}
