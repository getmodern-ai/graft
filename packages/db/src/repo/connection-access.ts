import { and, asc, desc, eq, exists, inArray, isNull, max, or, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { type AgentScopeMode, agent, agentConnection } from "../schema/agent";
import { type ApprovalDecision, approval, buildApproval, vendorApproval } from "../schema/approval";
import { connection } from "../schema/connection";
import { authoredTool } from "../schema/tool";
import { usageLedger } from "../schema/usage";

/**
 * The reads behind a connection's access view (GRA-296): every active agent of the person and what
 * each may do with one connection and its vendor's tools, in a fixed number of statements however
 * many agents there are. Each statement is person-scoped (ADR 0007): it names the person on the
 * agent row it joins, and on the connection or the tool where it reads one, so a connection or a
 * vendor of another person's answers nothing. The service reads the connection first and answers
 * 404 for one that is not the person's (`@graft/core`'s `getConnectionAccess`).
 */

/** An active agent and whether its scope reaches the connection under its mode. */
export type AgentAccessRow = {
  id: string;
  name: string;
  scopeMode: AgentScopeMode;
  connectedViaClientName: string | null;
  createdAt: Date;
  inScope: boolean;
};

/**
 * The person's active agents, oldest first, each with whether the connection is in its scope:
 * every connection of the person's for an agent on `all`, the list's rows for one on `listed`, as
 * `repo/agent.ts`'s `listScopeConnectionIds` resolves it. The connection is held to the person
 * inside the expression, so another person's id is in nobody's scope.
 */
export async function listAgentAccessForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
): Promise<AgentAccessRow[]> {
  const ownConnection = exists(
    db
      .select({ id: connection.id })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.personId, personId))),
  );
  const listed = exists(
    db
      .select({ agentId: agentConnection.agentId })
      .from(agentConnection)
      .where(
        and(eq(agentConnection.agentId, agent.id), eq(agentConnection.connectionId, connectionId)),
      ),
  );
  return db
    .select({
      id: agent.id,
      name: agent.name,
      scopeMode: agent.scopeMode,
      connectedViaClientName: agent.connectedViaClientName,
      createdAt: agent.createdAt,
      inScope: sql<boolean>`(${and(ownConnection, or(eq(agent.scopeMode, "all"), listed))})`,
    })
    .from(agent)
    .where(and(eq(agent.personId, personId), isNull(agent.revokedAt)))
    .orderBy(asc(agent.createdAt), asc(agent.id));
}

/**
 * Every connection id of the person's for the vendor, revoked rows included: a call through any of
 * them was a use of the vendor, which is how `lastVendorUseByAgent` counts the execute tools.
 */
export async function listVendorConnectionIds(
  db: DbOrTx,
  personId: string,
  vendor: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: connection.id })
    .from(connection)
    .where(and(eq(connection.personId, personId), eq(connection.vendor, vendor)))
    .orderBy(asc(connection.id));
  return rows.map((row) => row.id);
}

/**
 * When each of the person's agents last called the vendor, dry runs excluded: a dry run is
 * `acquire` proving a draft (ADR 0012), not the agent using the integration. A call is the
 * vendor's as `repo/usage.ts`'s `listUsageForVendor` reads it: its tool row carries the vendor, or
 * its wire name is one the caller names (the `execute__<id>` of each of the person's connections
 * to the vendor, which have no row).
 */
export async function lastVendorUseByAgent(
  db: DbOrTx,
  personId: string,
  args: { vendor: string; toolNames: readonly string[] },
): Promise<{ agentId: string; lastUsedAt: Date }[]> {
  const rows = await db
    .select({ agentId: usageLedger.agentId, lastUsedAt: max(usageLedger.createdAt) })
    .from(usageLedger)
    .innerJoin(agent, eq(usageLedger.agentId, agent.id))
    .leftJoin(authoredTool, eq(usageLedger.toolId, authoredTool.id))
    .where(
      and(
        eq(agent.personId, personId),
        eq(usageLedger.dryRun, false),
        or(
          eq(authoredTool.vendor, args.vendor),
          args.toolNames.length > 0 ? inArray(usageLedger.toolName, args.toolNames) : undefined,
        ),
      ),
    )
    .groupBy(usageLedger.agentId);
  return rows.flatMap((row) =>
    row.lastUsedAt ? [{ agentId: row.agentId, lastUsedAt: row.lastUsedAt }] : [],
  );
}

/** One agent's standing answer for one of the vendor's tools, with the tool it is about. */
export type VendorToolApprovalRow = {
  agentId: string;
  decision: ApprovalDecision;
  askEveryCall: boolean;
  toolVersionId: string | null;
  decidedAt: Date;
  tool: {
    id: string;
    vendor: string;
    name: string;
    description: string;
    readOnly: boolean;
    destructive: boolean;
    currentVersionId: string | null;
  };
};

/**
 * Every active agent's answer for every tool of the vendor in the person's toolbox, newest first:
 * the agent and the tool both held to the person (ADR 0008: per agent, per tool).
 */
export async function listVendorToolApprovals(
  db: DbOrTx,
  personId: string,
  vendor: string,
): Promise<VendorToolApprovalRow[]> {
  return db
    .select({
      agentId: approval.agentId,
      decision: approval.decision,
      askEveryCall: approval.askEveryCall,
      toolVersionId: approval.toolVersionId,
      decidedAt: approval.decidedAt,
      tool: {
        id: authoredTool.id,
        vendor: authoredTool.vendor,
        name: authoredTool.name,
        description: authoredTool.description,
        readOnly: authoredTool.readOnly,
        destructive: authoredTool.destructive,
        currentVersionId: authoredTool.currentVersionId,
      },
    })
    .from(approval)
    .innerJoin(agent, eq(approval.agentId, agent.id))
    .innerJoin(authoredTool, eq(approval.toolId, authoredTool.id))
    .where(
      and(
        eq(agent.personId, personId),
        isNull(agent.revokedAt),
        eq(authoredTool.personId, personId),
        eq(authoredTool.vendor, vendor),
      ),
    )
    .orderBy(desc(approval.decidedAt), asc(approval.agentId), asc(authoredTool.id));
}

/** Every active agent's standing approval for the vendor (ADR 0008 as amended 2026-10-09). */
export async function listVendorApprovalsForVendor(
  db: DbOrTx,
  personId: string,
  vendor: string,
): Promise<{ agentId: string; includesDestructive: boolean; grantedAt: Date }[]> {
  return db
    .select({
      agentId: vendorApproval.agentId,
      includesDestructive: vendorApproval.includesDestructive,
      grantedAt: vendorApproval.grantedAt,
    })
    .from(vendorApproval)
    .innerJoin(agent, eq(vendorApproval.agentId, agent.id))
    .where(
      and(eq(agent.personId, personId), isNull(agent.revokedAt), eq(vendorApproval.vendor, vendor)),
    )
    .orderBy(asc(vendorApproval.agentId));
}

/** Every active agent's build approval for the connection (ADR 0008), the connection the person's. */
export async function listBuildApprovalsForConnection(
  db: DbOrTx,
  personId: string,
  connectionId: string,
): Promise<{ agentId: string; grantedAt: Date }[]> {
  return db
    .select({ agentId: buildApproval.agentId, grantedAt: buildApproval.grantedAt })
    .from(buildApproval)
    .innerJoin(agent, eq(buildApproval.agentId, agent.id))
    .innerJoin(connection, eq(buildApproval.connectionId, connection.id))
    .where(
      and(
        eq(agent.personId, personId),
        isNull(agent.revokedAt),
        eq(connection.personId, personId),
        eq(connection.id, connectionId),
      ),
    )
    .orderBy(asc(buildApproval.agentId));
}
