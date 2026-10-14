import { and, desc, eq, gte, inArray, max, ne, or } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { authoredTool } from "../schema/tool";
import { type NewUsageLedgerRow, usageLedger } from "../schema/usage";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * The usage ledger's reads and writes (ADR 0009, ADR 0012). Append-only: nothing here updates or
 * deletes a row, which is what makes the table safe to aggregate at any moment.
 */

export type UsageLedgerRow = typeof usageLedger.$inferSelect;

export async function insertUsage(db: DbOrTx, row: NewUsageLedgerRow): Promise<UsageLedgerRow> {
  const [inserted] = await db.insert(usageLedger).values(row).returning();
  if (!inserted) throw new Error("Insert of usage row returned no row");
  return inserted;
}

/** An agent's recent invocations, newest first, optionally since a moment. */
export async function listUsage(
  db: DbOrTx,
  scope: AgentScope,
  args: { limit: number; since?: Date },
): Promise<UsageLedgerRow[]> {
  return db
    .select()
    .from(usageLedger)
    .where(
      and(
        inArray(usageLedger.agentId, scopedAgentIds(db, scope)),
        args.since ? gte(usageLedger.createdAt, args.since) : undefined,
      ),
    )
    .orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
    .limit(args.limit);
}

/**
 * When each tool was last invoked by this agent — the contraction rule's other clock (ADR 0009),
 * read from the ledger rather than from `working_set.last_used_at` when the sweep wants the record
 * and not the cache of it. Meta-tool lines (`tool_id` null) are excluded by the grouping.
 */
export async function lastUsedAtByTool(
  db: DbOrTx,
  scope: AgentScope,
): Promise<{ toolId: string; lastUsedAt: Date }[]> {
  const rows = await db
    .select({ toolId: usageLedger.toolId, lastUsedAt: max(usageLedger.createdAt) })
    .from(usageLedger)
    .where(inArray(usageLedger.agentId, scopedAgentIds(db, scope)))
    .groupBy(usageLedger.toolId);
  return rows.flatMap((row) =>
    row.toolId && row.lastUsedAt ? [{ toolId: row.toolId, lastUsedAt: row.lastUsedAt }] : [],
  );
}

/** A ledger line with the name of the agent that wrote it — the console's "recent vendor calls" row. */
export type VendorUsageRow = UsageLedgerRow & { agentName: string };

/**
 * The person's recent calls against one vendor, across every agent they own, newest first — the
 * console's "recent vendor calls" on a connection (GRA-26). Person-scoped through `agent.person_id`
 * the way the pending-action reads are, since a connection is the person's and not one agent's
 * (ADR 0007). A call is the vendor's when its tool row carries the vendor — how a tool is bound to
 * a connection — or when its wire name is one the caller names: the connection's own
 * `execute__<id>` tool has no toolbox row (CONTEXT.md, *Tool*), so it is matched by name.
 */
export async function listUsageForVendor(
  db: DbOrTx,
  personId: string,
  args: { vendor: string; toolNames: readonly string[]; limit: number },
): Promise<VendorUsageRow[]> {
  const rows = await db
    .select({ usage: usageLedger, agentName: agent.name })
    .from(usageLedger)
    .innerJoin(agent, eq(usageLedger.agentId, agent.id))
    .leftJoin(authoredTool, eq(usageLedger.toolId, authoredTool.id))
    .where(
      and(
        eq(agent.personId, personId),
        or(
          eq(authoredTool.vendor, args.vendor),
          args.toolNames.length > 0 ? inArray(usageLedger.toolName, args.toolNames) : undefined,
        ),
      ),
    )
    .orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
    .limit(args.limit);
  return rows.map(({ usage, agentName }) => ({ ...usage, agentName }));
}

/** The last run of one tool across the person's agents, with the agent that made it. */
export type ToolLastRunRow = {
  toolId: string;
  lastRunAt: Date;
  outcome: "ok" | "error";
  agentId: string;
  agentName: string;
};

/**
 * When each of the person's tools of one vendor last ran, and for which agent: the integration
 * page's "Ran 2m ago by Codex" (GRA-293). Person-wide, unlike `lastUsedAtByTool`, so scoped through
 * both owners, `agent.person_id` and `authored_tool.person_id`. A dry run is a proof and not a run,
 * and a refused call never reached the sandbox, so neither counts; a revoked agent's runs do, since
 * they happened. One row per tool, `distinct on` the tool, the newest line winning.
 */
export async function lastRunByToolForPerson(
  db: DbOrTx,
  personId: string,
  args: { vendor: string },
): Promise<ToolLastRunRow[]> {
  const rows = await db
    .selectDistinctOn([usageLedger.toolId], {
      toolId: usageLedger.toolId,
      lastRunAt: usageLedger.createdAt,
      outcome: usageLedger.outcome,
      agentId: usageLedger.agentId,
      agentName: agent.name,
    })
    .from(usageLedger)
    .innerJoin(agent, eq(usageLedger.agentId, agent.id))
    .innerJoin(authoredTool, eq(usageLedger.toolId, authoredTool.id))
    .where(
      and(
        eq(agent.personId, personId),
        eq(authoredTool.personId, personId),
        eq(authoredTool.vendor, args.vendor),
        eq(usageLedger.dryRun, false),
        ne(usageLedger.outcome, "refused"),
      ),
    )
    .orderBy(usageLedger.toolId, desc(usageLedger.createdAt), desc(usageLedger.id));
  return rows.flatMap(({ toolId, outcome, ...rest }) =>
    toolId && outcome !== "refused" ? [{ ...rest, toolId, outcome }] : [],
  );
}
