import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { type ApprovalDecision, approval, vendorApproval } from "../schema/approval";
import { connection } from "../schema/connection";
import { pendingAction } from "../schema/pending-action";
import { authoredTool } from "../schema/tool";
import { type UsageOutcome, usageLedger } from "../schema/usage";
import { scopedAgentIds } from "./agent";
import type { AgentScope } from "./scope";

/**
 * The console's activity (GRA-308): one person-wide stream that Home, the agent page, the
 * integration page's Activity tab and the Activity screen each read with their own filters. Two
 * kinds of row, newest first: a `run` is a usage-ledger line, and an `approval` is a moment the
 * person answered, from three records (a tool's standing answer, an integration's standing
 * approval, an answered ask that is not a tool's). Every branch names the person on the agent row
 * it joins, and on the tool and the connection where it reads one (ADR 0007).
 */

export const activityKind = ["run", "approval"] as const;
export type ActivityKind = (typeof activityKind)[number];

/**
 * Where an `approval` row came from. `tool`: the `approval` row, at its `decided_at`. `vendor`: the
 * `vendor_approval` row, at its `granted_at`. `ask`: an answered pending action, at its
 * `answered_at`, of any kind but `tool`, whose answer is the `approval` or `vendor_approval` row it
 * wrote (`@graft/mcp`'s `ask-answer.ts`), so it is not shown twice. A standing row re-decided moves
 * to its new moment; the earlier answer is on Requests' Done list.
 */
export const activityApprovalSource = ["tool", "vendor", "ask"] as const;
export type ActivityApprovalSource = (typeof activityApprovalSource)[number];

/**
 * A row's place in the stream: its moment as Postgres prints it, to the microsecond, and a key
 * unique across the four branches (`run:<id>`, `tool_approval:<agent>:<tool>`,
 * `vendor_approval:<agent>:<vendor>`, `ask:<id>`). The order and the cursor are both on this pair,
 * so a row written after a page was read lands above it and moves nothing below. The key compares
 * under `collate "C"`, bytewise, so the order is the same on any database's default collation.
 */
export type ActivityPosition = { at: string; key: string };

type ActivityRowBase = {
  position: ActivityPosition;
  at: Date;
  agentId: string;
  agentName: string;
  /** The integration's slug, or null where nothing recorded it (a meta-tool, a line before GRA-301). */
  vendor: string | null;
  /** The connection the line ran against, or the ask was about; null where none is recorded. */
  connectionId: string | null;
};

/** The tool's row as the stream joins it, null when the line has none (a meta-tool, `execute__`, a gone tool). */
export type ActivityTool = { id: string; vendor: string; name: string; description: string };

export type ActivityRunRow = ActivityRowBase & {
  kind: "run";
  id: string;
  /** The wire name the ledger stored, which outlives the tool's row. */
  toolName: string;
  tool: ActivityTool | null;
  outcome: UsageOutcome;
  reason: string | null;
  asked: boolean | null;
  latencyMs: number;
  dryRun: boolean;
};

export type ActivityApprovalRow = ActivityRowBase & {
  kind: "approval";
  source: ActivityApprovalSource;
  /** The pending action's id for `ask`; null for a standing row, which has no id of its own. */
  pendingActionId: string | null;
  /** The tool a `tool` approval is for; null for the other two sources. */
  tool: ActivityTool | null;
  /** The answer on a `tool` approval; null for the other two. */
  decision: ApprovalDecision | null;
  /** Whether a `vendor` approval passes destructive tools too; null for the other two. */
  includesDestructive: boolean | null;
  /** The ask's kind for `ask` (`connection`, `build`, `scope`, …); null for the other two. */
  askKind: string | null;
  /** The ask's answer as recorded, as the Done list reads it; null for the other two. */
  answer: Record<string, unknown> | null;
};

export type ActivityRow = ActivityRunRow | ActivityApprovalRow;

/**
 * The stream's filters, each of which changes the statement rather than the page the client gets.
 * `outcome` is a run's, so naming one leaves the approval branches out, as `kind: "run"` does; a
 * `connectionId` leaves out the two standing branches, which are per tool and per integration and
 * name no connection. Meta-tool lines and dry runs are left out unless asked for.
 */
export type ActivityFilter = {
  agentId?: string | null;
  vendor?: string | null;
  connectionId?: string | null;
  outcome?: UsageOutcome | null;
  kind?: ActivityKind | null;
  includeMetaTools?: boolean;
  includeDryRuns?: boolean;
};

type RawActivityRow = {
  kind: ActivityKind;
  key: string;
  at: string;
  agent_id: string;
  agent_name: string;
  vendor: string | null;
  connection_id: string | null;
  id: string | null;
  wire_name: string | null;
  tool_id: string | null;
  tool_vendor: string | null;
  tool_short_name: string | null;
  tool_description: string | null;
  outcome: UsageOutcome | null;
  reason: string | null;
  asked: boolean | null;
  latency_ms: number | null;
  dry_run: boolean | null;
  source: ActivityApprovalSource | null;
  decision: ApprovalDecision | null;
  includes_destructive: boolean | null;
  ask_kind: string | null;
  answer: Record<string, unknown> | null;
};

/**
 * A meta-tool carries a single underscore and never the separator, which every authored and
 * execute tool's wire name carries (`@graft/mcp`'s `tool-names.ts`), so the shape alone tells them
 * apart, a tool whose row is gone included. `strpos` rather than `like`, where `_` is a wildcard.
 */
const notMetaTool = sql`strpos(${usageLedger.toolName}, '__') > 0`;

function before(at: SQL, key: SQL, after: ActivityPosition | null | undefined): SQL | undefined {
  return after ? sql`(${at}, ${key}) < (${after.at}::timestamp, ${after.key})` : undefined;
}

function where(conditions: (SQL | undefined)[]): SQL {
  return and(...conditions) ?? sql`true`;
}

function runBranch(personId: string, filter: ActivityFilter, after?: ActivityPosition | null) {
  const key = sql`('run:' || ${usageLedger.id}) collate "C"`;
  const vendor = sql`coalesce(${authoredTool.vendor}, ${connection.vendor})`;
  return sql`select 'run' as kind, ${key} as key, ${usageLedger.createdAt} as at, ${usageLedger.agentId} as agent_id, ${agent.name} as agent_name, ${vendor} as vendor, ${usageLedger.connectionId} as connection_id, ${usageLedger.id} as id, ${usageLedger.toolName} as wire_name, ${authoredTool.id} as tool_id, ${authoredTool.vendor} as tool_vendor, ${authoredTool.name} as tool_short_name, ${authoredTool.description} as tool_description, ${usageLedger.outcome} as outcome, ${usageLedger.reason} as reason, ${usageLedger.asked} as asked, ${usageLedger.latencyMs} as latency_ms, ${usageLedger.dryRun} as dry_run, null::text as source, null::text as decision, null::boolean as includes_destructive, null::text as ask_kind, null::jsonb as answer from ${usageLedger} inner join ${agent} on ${usageLedger.agentId} = ${agent.id} left join ${authoredTool} on (${usageLedger.toolId} = ${authoredTool.id} and ${authoredTool.personId} = ${personId}) left join ${connection} on (${usageLedger.connectionId} = ${connection.id} and ${connection.personId} = ${personId}) where ${where(
    [
      eq(agent.personId, personId),
      filter.agentId ? eq(usageLedger.agentId, filter.agentId) : undefined,
      filter.includeDryRuns ? undefined : eq(usageLedger.dryRun, false),
      filter.includeMetaTools ? undefined : notMetaTool,
      filter.outcome ? eq(usageLedger.outcome, filter.outcome) : undefined,
      filter.vendor ? sql`${vendor} = ${filter.vendor}` : undefined,
      filter.connectionId ? eq(usageLedger.connectionId, filter.connectionId) : undefined,
      before(sql`${usageLedger.createdAt}`, key, after),
    ],
  )} order by ${usageLedger.createdAt} desc, ${key} desc`;
}

function toolApprovalBranch(
  personId: string,
  filter: ActivityFilter,
  after?: ActivityPosition | null,
) {
  const key = sql`('tool_approval:' || ${approval.agentId} || ':' || ${approval.toolId}) collate "C"`;
  return sql`select 'approval' as kind, ${key} as key, ${approval.decidedAt} as at, ${approval.agentId} as agent_id, ${agent.name} as agent_name, ${authoredTool.vendor} as vendor, null::text as connection_id, null::text as id, null::text as wire_name, ${authoredTool.id} as tool_id, ${authoredTool.vendor} as tool_vendor, ${authoredTool.name} as tool_short_name, ${authoredTool.description} as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'tool' as source, ${approval.decision} as decision, null::boolean as includes_destructive, null::text as ask_kind, null::jsonb as answer from ${approval} inner join ${agent} on ${approval.agentId} = ${agent.id} inner join ${authoredTool} on (${approval.toolId} = ${authoredTool.id} and ${authoredTool.personId} = ${personId}) where ${where(
    [
      eq(agent.personId, personId),
      filter.agentId ? eq(approval.agentId, filter.agentId) : undefined,
      filter.vendor ? eq(authoredTool.vendor, filter.vendor) : undefined,
      before(sql`${approval.decidedAt}`, key, after),
    ],
  )} order by ${approval.decidedAt} desc, ${key} desc`;
}

function vendorApprovalBranch(
  personId: string,
  filter: ActivityFilter,
  after?: ActivityPosition | null,
) {
  const key = sql`('vendor_approval:' || ${vendorApproval.agentId} || ':' || ${vendorApproval.vendor}) collate "C"`;
  return sql`select 'approval' as kind, ${key} as key, ${vendorApproval.grantedAt} as at, ${vendorApproval.agentId} as agent_id, ${agent.name} as agent_name, ${vendorApproval.vendor} as vendor, null::text as connection_id, null::text as id, null::text as wire_name, null::text as tool_id, null::text as tool_vendor, null::text as tool_short_name, null::text as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'vendor' as source, null::text as decision, ${vendorApproval.includesDestructive} as includes_destructive, null::text as ask_kind, null::jsonb as answer from ${vendorApproval} inner join ${agent} on ${vendorApproval.agentId} = ${agent.id} where ${where(
    [
      eq(agent.personId, personId),
      filter.agentId ? eq(vendorApproval.agentId, filter.agentId) : undefined,
      filter.vendor ? eq(vendorApproval.vendor, filter.vendor) : undefined,
      before(sql`${vendorApproval.grantedAt}`, key, after),
    ],
  )} order by ${vendorApproval.grantedAt} desc, ${key} desc`;
}

function askBranch(personId: string, filter: ActivityFilter, after?: ActivityPosition | null) {
  const key = sql`('ask:' || ${pendingAction.id}) collate "C"`;
  // As `@graft/core`'s `pendingActionSubject` reads them: the vendor the ask's payload names, and
  // the connection on its column or, for a proposal, the one it was answered with.
  const vendor = sql`${pendingAction.payload} ->> 'vendor'`;
  const connectionId = sql`coalesce(${pendingAction.connectionId}, ${pendingAction.answer} ->> 'connectionId')`;
  return sql`select 'approval' as kind, ${key} as key, ${pendingAction.answeredAt} as at, ${pendingAction.agentId} as agent_id, ${agent.name} as agent_name, ${vendor} as vendor, ${connectionId} as connection_id, ${pendingAction.id} as id, null::text as wire_name, null::text as tool_id, null::text as tool_vendor, null::text as tool_short_name, null::text as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'ask' as source, null::text as decision, null::boolean as includes_destructive, ${pendingAction.kind} as ask_kind, ${pendingAction.answer} as answer from ${pendingAction} inner join ${agent} on ${pendingAction.agentId} = ${agent.id} where ${where(
    [
      eq(agent.personId, personId),
      sql`${pendingAction.answeredAt} is not null`,
      sql`${pendingAction.kind} <> 'tool'`,
      filter.agentId ? eq(pendingAction.agentId, filter.agentId) : undefined,
      filter.vendor ? sql`${vendor} = ${filter.vendor}` : undefined,
      filter.connectionId ? sql`${connectionId} = ${filter.connectionId}` : undefined,
      before(sql`${pendingAction.answeredAt}`, key, after),
    ],
  )} order by ${pendingAction.answeredAt} desc, ${key} desc`;
}

/**
 * The branches a filter keeps. `outcome` and `kind: "run"` keep the runs alone; a `connectionId`
 * keeps the runs and the asks, the two that record one.
 */
export function activityBranches(
  filter: ActivityFilter,
): ("run" | "tool_approval" | "vendor_approval" | "ask")[] {
  const runs = filter.kind !== "approval";
  const approvals = filter.kind !== "run" && !filter.outcome;
  return [
    ...(runs ? (["run"] as const) : []),
    ...(approvals && !filter.connectionId ? (["tool_approval", "vendor_approval"] as const) : []),
    ...(approvals ? (["ask"] as const) : []),
  ];
}

/**
 * A page of the person's activity, newest first, at most `limit` rows after `after`. Each branch
 * is ordered and limited on its own, so Postgres reads at most `limit` rows of each before the
 * merge rather than the person's whole history.
 */
export async function listActivity(
  db: DbOrTx,
  personId: string,
  args: { filter: ActivityFilter; limit: number; after?: ActivityPosition | null },
): Promise<ActivityRow[]> {
  const builders = {
    run: runBranch,
    tool_approval: toolApprovalBranch,
    vendor_approval: vendorApprovalBranch,
    ask: askBranch,
  };
  const branches = activityBranches(args.filter).map(
    (name) => sql`(${builders[name](personId, args.filter, args.after)} limit ${args.limit})`,
  );
  if (branches.length === 0) return [];
  const result = await db.execute<RawActivityRow>(
    sql`select * from (${sql.join(branches, sql` union all `)}) as activity order by activity.at desc, activity.key collate "C" desc limit ${args.limit}`,
  );
  return result.rows.map(toActivityRow);
}

/** A `timestamp` column as Postgres prints it, which is UTC here, read as drizzle reads one. */
function parseTimestamp(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

function toActivityRow(raw: RawActivityRow): ActivityRow {
  const base: ActivityRowBase = {
    position: { at: raw.at, key: raw.key },
    at: parseTimestamp(raw.at),
    agentId: raw.agent_id,
    agentName: raw.agent_name,
    vendor: raw.vendor,
    connectionId: raw.connection_id,
  };
  const tool: ActivityTool | null =
    raw.tool_id && raw.tool_vendor && raw.tool_short_name !== null
      ? {
          id: raw.tool_id,
          vendor: raw.tool_vendor,
          name: raw.tool_short_name,
          description: raw.tool_description ?? "",
        }
      : null;
  if (raw.kind === "run") {
    return {
      ...base,
      kind: "run",
      id: raw.id ?? raw.key.slice("run:".length),
      toolName: raw.wire_name ?? "",
      tool,
      outcome: raw.outcome ?? "ok",
      reason: raw.reason,
      asked: raw.asked,
      latencyMs: raw.latency_ms ?? 0,
      dryRun: raw.dry_run ?? false,
    };
  }
  return {
    ...base,
    kind: "approval",
    source: raw.source ?? "ask",
    pendingActionId: raw.source === "ask" ? raw.id : null,
    tool,
    decision: raw.decision,
    includesDestructive: raw.includes_destructive,
    askKind: raw.ask_kind,
    answer: raw.answer,
  };
}

/** The agent page's stats (GRA-308), over runs since a moment. */
export type AgentActivityCounts = {
  /** Lines that reached the sandbox: `ok` and `error`. */
  runs: number;
  /** `ok` with no ask on the call (`asked = false`). */
  ranWithoutAsking: number;
  /** `ok` on a call that asked and was answered yes (`asked = true`). */
  approved: number;
};

/**
 * One agent's counts since `since`, meta-tools and dry runs left out, in one agent-scoped
 * statement (both ids of the scope). A line before GRA-301 has `asked` null and counts as a run
 * and as neither of the other two.
 */
export async function countAgentActivity(
  db: DbOrTx,
  scope: AgentScope,
  args: { since: Date },
): Promise<AgentActivityCounts> {
  const [row] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${usageLedger.outcome} <> 'refused')`.mapWith(
        Number,
      ),
      ranWithoutAsking:
        sql<number>`count(*) filter (where ${usageLedger.outcome} = 'ok' and ${usageLedger.asked} = false)`.mapWith(
          Number,
        ),
      approved:
        sql<number>`count(*) filter (where ${usageLedger.outcome} = 'ok' and ${usageLedger.asked} = true)`.mapWith(
          Number,
        ),
    })
    .from(usageLedger)
    .where(
      and(
        inArray(usageLedger.agentId, scopedAgentIds(db, scope)),
        eq(usageLedger.dryRun, false),
        notMetaTool,
        sql`${usageLedger.createdAt} >= ${sql.param(args.since, usageLedger.createdAt)}`,
      ),
    );
  return {
    runs: row?.runs ?? 0,
    ranWithoutAsking: row?.ranWithoutAsking ?? 0,
    approved: row?.approved ?? 0,
  };
}

/** The agent's newest line, with its tool where the row still stands. */
export type AgentLastRunRow = {
  at: Date;
  toolName: string;
  tool: ActivityTool | null;
  outcome: UsageOutcome;
};

/**
 * The agent's last activity and that line's tool: its newest line of any outcome, meta-tools and
 * dry runs left out, agent-scoped, the tool joined under the scope's person. Null when it never
 * ran one.
 */
export async function findAgentLastRun(
  db: DbOrTx,
  scope: AgentScope,
): Promise<AgentLastRunRow | null> {
  const [row] = await db
    .select({
      at: usageLedger.createdAt,
      toolName: usageLedger.toolName,
      outcome: usageLedger.outcome,
      toolId: authoredTool.id,
      toolVendor: authoredTool.vendor,
      toolShortName: authoredTool.name,
      toolDescription: authoredTool.description,
    })
    .from(usageLedger)
    .leftJoin(
      authoredTool,
      and(eq(usageLedger.toolId, authoredTool.id), eq(authoredTool.personId, scope.personId)),
    )
    .where(
      and(
        inArray(usageLedger.agentId, scopedAgentIds(db, scope)),
        eq(usageLedger.dryRun, false),
        notMetaTool,
      ),
    )
    .orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
    .limit(1);
  if (!row) return null;
  return {
    at: row.at,
    toolName: row.toolName,
    outcome: row.outcome,
    tool:
      row.toolId && row.toolVendor && row.toolShortName !== null
        ? {
            id: row.toolId,
            vendor: row.toolVendor,
            name: row.toolShortName,
            description: row.toolDescription ?? "",
          }
        : null,
  };
}
