import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";

import type { DbOrTx } from "../index";
import { agent } from "../schema/agent";
import { type ApprovalDecision, approval, vendorApproval } from "../schema/approval";
import {
  type ApprovalEventAction,
  type ApprovalEventKind,
  type ApprovalEventVia,
  approvalEvent,
} from "../schema/approval-event";
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
 * person answered, withdrew, changed or revoked something. Since GRA-341 an approval row is an
 * `approval_event`, appended when the change was made; the three older records (a tool's standing
 * answer, an integration's standing approval, an answered ask that is not a tool's) are read only
 * where no event covers them, which is every answer given before the events existed. Every branch
 * names the person, on the row itself or on the agent row it joins, and on the tool and the
 * connection where it reads one (ADR 0007).
 */

export const activityKind = ["run", "approval"] as const;
export type ActivityKind = (typeof activityKind)[number];

/**
 * Where an `approval` row came from. `event`: an `approval_event` row, at its `at` (GRA-341), the
 * record of every answer, withdraw, change and revoke made since it existed. The other three are
 * the record before it, each read only where no event covers it, so nothing is shown twice:
 * `tool`, the `approval` row at its `decided_at`, unless an answer event for the tool and agent is
 * at or after that moment; `vendor`, the `vendor_approval` row at its `granted_at`, on the same
 * rule; `ask`, an answered pending action of any kind but `tool` at its `answered_at`, unless an
 * event names it as the ask it answered. A standing row answered before the events and withdrawn
 * after is gone, so the withdraw's event is all that shows of it.
 */
export const activityApprovalSource = ["event", "tool", "vendor", "ask"] as const;
export type ActivityApprovalSource = (typeof activityApprovalSource)[number];

/**
 * A row's place in the stream: its moment as Postgres prints it, to the microsecond, and a key
 * unique across the five branches (`run:<id>`, `tool_approval:<agent>:<tool>`,
 * `vendor_approval:<agent>:<vendor>`, `ask:<id>`, `event:<id>`). The order and the cursor are both on this pair,
 * so a row written after a page was read lands above it and moves nothing below. The key compares
 * under `collate "C"`, bytewise, so the order is the same on any database's default collation.
 */
export type ActivityPosition = { at: string; key: string };

type ActivityRowBase = {
  position: ActivityPosition;
  at: Date;
  /** The integration's slug, or null where nothing recorded it (a meta-tool, a line before GRA-301). */
  vendor: string | null;
  /** The connection the line ran against, or the ask was about; null where none is recorded. */
  connectionId: string | null;
};

/** The tool's row as the stream joins it, null when the line has none (a meta-tool, `execute__`, a gone tool). */
export type ActivityTool = { id: string; vendor: string; name: string; description: string };

export type ActivityRunRow = ActivityRowBase & {
  kind: "run";
  agentId: string;
  agentName: string;
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

/** What an `event` row records (`schema/approval-event.ts` says what each word means). */
export type ActivityEvent = {
  kind: ApprovalEventKind;
  action: ApprovalEventAction;
  via: ApprovalEventVia;
};

export type ActivityApprovalRow = ActivityRowBase & {
  kind: "approval";
  /** Null only on an `event` with no agent: a connection's revoke, the person's act on every agent. */
  agentId: string | null;
  agentName: string | null;
  source: ActivityApprovalSource;
  /**
   * The pending action's id for `ask`, and for an `event` that answered one; null for a standing
   * row, which has no id of its own.
   */
  pendingActionId: string | null;
  /** The tool a `tool` approval or a `tool` event is for, while its row stands; null otherwise. */
  tool: ActivityTool | null;
  /** The answer on a `tool` approval; null for the other sources. */
  decision: ApprovalDecision | null;
  /** Whether a `vendor` approval, or a `vendor` event, passes destructive tools too; else null. */
  includesDestructive: boolean | null;
  /** The ask's kind for `ask` (`connection`, `build`, `scope`, …); null for the other sources. */
  askKind: string | null;
  /** The ask's answer as recorded, as the Done list reads it; null for the other sources. */
  answer: Record<string, unknown> | null;
  /** What an `event` recorded; null for the other three sources. */
  event: ActivityEvent | null;
};

export type ActivityRow = ActivityRunRow | ActivityApprovalRow;

/**
 * The stream's filters, each of which changes the statement rather than the page the client gets.
 * `outcome` is a run's, so naming one leaves the approval branches out, as `kind: "run"` does; a
 * `connectionId` leaves out the two standing branches, which are per tool and per integration and
 * name no connection. An `agentId` leaves out the events that name no agent. Meta-tool lines and
 * dry runs are left out unless asked for.
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
  agent_id: string | null;
  agent_name: string | null;
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
  event_kind: ApprovalEventKind | null;
  event_action: ApprovalEventAction | null;
  event_via: ApprovalEventVia | null;
};

/** The three columns only the event branch fills, as every other branch selects them. */
const NO_EVENT = sql.raw(
  "null::text as event_kind, null::text as event_action, null::text as event_via",
);

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
  return sql`select 'run' as kind, ${key} as key, ${usageLedger.createdAt} as at, ${usageLedger.agentId} as agent_id, ${agent.name} as agent_name, ${vendor} as vendor, ${usageLedger.connectionId} as connection_id, ${usageLedger.id} as id, ${usageLedger.toolName} as wire_name, ${authoredTool.id} as tool_id, ${authoredTool.vendor} as tool_vendor, ${authoredTool.name} as tool_short_name, ${authoredTool.description} as tool_description, ${usageLedger.outcome} as outcome, ${usageLedger.reason} as reason, ${usageLedger.asked} as asked, ${usageLedger.latencyMs} as latency_ms, ${usageLedger.dryRun} as dry_run, null::text as source, null::text as decision, null::boolean as includes_destructive, null::text as ask_kind, null::jsonb as answer, ${NO_EVENT} from ${usageLedger} inner join ${agent} on ${usageLedger.agentId} = ${agent.id} left join ${authoredTool} on (${usageLedger.toolId} = ${authoredTool.id} and ${authoredTool.personId} = ${personId}) left join ${connection} on (${usageLedger.connectionId} = ${connection.id} and ${connection.personId} = ${personId}) where ${where(
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
  return sql`select 'approval' as kind, ${key} as key, ${approval.decidedAt} as at, ${approval.agentId} as agent_id, ${agent.name} as agent_name, ${authoredTool.vendor} as vendor, null::text as connection_id, null::text as id, null::text as wire_name, ${authoredTool.id} as tool_id, ${authoredTool.vendor} as tool_vendor, ${authoredTool.name} as tool_short_name, ${authoredTool.description} as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'tool' as source, ${approval.decision} as decision, null::boolean as includes_destructive, null::text as ask_kind, null::jsonb as answer, ${NO_EVENT} from ${approval} inner join ${agent} on ${approval.agentId} = ${agent.id} inner join ${authoredTool} on (${approval.toolId} = ${authoredTool.id} and ${authoredTool.personId} = ${personId}) where ${where(
    [
      eq(agent.personId, personId),
      sql`not exists (select 1 from ${approvalEvent} where ${approvalEvent.personId} = ${personId} and ${approvalEvent.agentId} = ${approval.agentId} and ${approvalEvent.kind} = 'tool' and ${approvalEvent.toolId} = ${approval.toolId} and ${approvalEvent.action} in ('allowed', 'denied') and ${approvalEvent.at} >= ${approval.decidedAt})`,
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
  return sql`select 'approval' as kind, ${key} as key, ${vendorApproval.grantedAt} as at, ${vendorApproval.agentId} as agent_id, ${agent.name} as agent_name, ${vendorApproval.vendor} as vendor, null::text as connection_id, null::text as id, null::text as wire_name, null::text as tool_id, null::text as tool_vendor, null::text as tool_short_name, null::text as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'vendor' as source, null::text as decision, ${vendorApproval.includesDestructive} as includes_destructive, null::text as ask_kind, null::jsonb as answer, ${NO_EVENT} from ${vendorApproval} inner join ${agent} on ${vendorApproval.agentId} = ${agent.id} where ${where(
    [
      eq(agent.personId, personId),
      sql`not exists (select 1 from ${approvalEvent} where ${approvalEvent.personId} = ${personId} and ${approvalEvent.agentId} = ${vendorApproval.agentId} and ${approvalEvent.kind} = 'vendor' and ${approvalEvent.vendor} = ${vendorApproval.vendor} and ${approvalEvent.action} in ('allowed', 'widened', 'narrowed') and ${approvalEvent.at} >= ${vendorApproval.grantedAt})`,
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
  return sql`select 'approval' as kind, ${key} as key, ${pendingAction.answeredAt} as at, ${pendingAction.agentId} as agent_id, ${agent.name} as agent_name, ${vendor} as vendor, ${connectionId} as connection_id, ${pendingAction.id} as id, null::text as wire_name, null::text as tool_id, null::text as tool_vendor, null::text as tool_short_name, null::text as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'ask' as source, null::text as decision, null::boolean as includes_destructive, ${pendingAction.kind} as ask_kind, ${pendingAction.answer} as answer, ${NO_EVENT} from ${pendingAction} inner join ${agent} on ${pendingAction.agentId} = ${agent.id} where ${where(
    [
      eq(agent.personId, personId),
      sql`${pendingAction.answeredAt} is not null`,
      sql`${pendingAction.kind} <> 'tool'`,
      sql`not exists (select 1 from ${approvalEvent} where ${approvalEvent.personId} = ${personId} and ${approvalEvent.pendingActionId} = ${pendingAction.id})`,
      filter.agentId ? eq(pendingAction.agentId, filter.agentId) : undefined,
      filter.vendor ? sql`${vendor} = ${filter.vendor}` : undefined,
      filter.connectionId ? sql`${connectionId} = ${filter.connectionId}` : undefined,
      before(sql`${pendingAction.answeredAt}`, key, after),
    ],
  )} order by ${pendingAction.answeredAt} desc, ${key} desc`;
}

/**
 * The events (GRA-341), under the person on the row itself. The agent and the tool are joined
 * under the person too, and left joined: a connection's revoke names no agent, and a tool whose
 * row is gone still leaves its event. The integration and the connection are the event's own
 * columns, so a filter by either needs no join.
 */
function eventBranch(personId: string, filter: ActivityFilter, after?: ActivityPosition | null) {
  const key = sql`('event:' || ${approvalEvent.id}) collate "C"`;
  return sql`select 'approval' as kind, ${key} as key, ${approvalEvent.at} as at, ${approvalEvent.agentId} as agent_id, ${agent.name} as agent_name, ${approvalEvent.vendor} as vendor, ${approvalEvent.connectionId} as connection_id, ${approvalEvent.pendingActionId} as id, null::text as wire_name, ${authoredTool.id} as tool_id, ${authoredTool.vendor} as tool_vendor, ${authoredTool.name} as tool_short_name, ${authoredTool.description} as tool_description, null::text as outcome, null::text as reason, null::boolean as asked, null::integer as latency_ms, null::boolean as dry_run, 'event' as source, null::text as decision, ${approvalEvent.includesDestructive} as includes_destructive, null::text as ask_kind, null::jsonb as answer, ${approvalEvent.kind} as event_kind, ${approvalEvent.action} as event_action, ${approvalEvent.via} as event_via from ${approvalEvent} left join ${agent} on (${approvalEvent.agentId} = ${agent.id} and ${agent.personId} = ${personId}) left join ${authoredTool} on (${approvalEvent.toolId} = ${authoredTool.id} and ${authoredTool.personId} = ${personId}) where ${where(
    [
      eq(approvalEvent.personId, personId),
      filter.agentId ? eq(approvalEvent.agentId, filter.agentId) : undefined,
      filter.vendor ? eq(approvalEvent.vendor, filter.vendor) : undefined,
      filter.connectionId ? eq(approvalEvent.connectionId, filter.connectionId) : undefined,
      before(sql`${approvalEvent.at}`, key, after),
    ],
  )} order by ${approvalEvent.at} desc, ${key} desc`;
}

/**
 * The branches a filter keeps. `outcome` and `kind: "run"` keep the runs alone; a `connectionId`
 * keeps the runs, the asks and the events, the three that record one.
 */
export function activityBranches(
  filter: ActivityFilter,
): ("run" | "tool_approval" | "vendor_approval" | "ask" | "event")[] {
  const runs = filter.kind !== "approval";
  const approvals = filter.kind !== "run" && !filter.outcome;
  return [
    ...(runs ? (["run"] as const) : []),
    ...(approvals && !filter.connectionId ? (["tool_approval", "vendor_approval"] as const) : []),
    ...(approvals ? (["ask", "event"] as const) : []),
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
    event: eventBranch,
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
      agentId: raw.agent_id ?? "",
      agentName: raw.agent_name ?? "",
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
  // An event whose agent row was not found under the person names no agent, as a revoke does.
  const agentId = raw.agent_name === null ? null : raw.agent_id;
  return {
    ...base,
    kind: "approval",
    agentId,
    agentName: agentId === null ? null : raw.agent_name,
    source: raw.source ?? "ask",
    pendingActionId: raw.source === "ask" || raw.source === "event" ? raw.id : null,
    tool,
    decision: raw.decision,
    includesDestructive: raw.includes_destructive,
    askKind: raw.ask_kind,
    answer: raw.answer,
    event:
      raw.source === "event" && raw.event_kind && raw.event_action && raw.event_via
        ? { kind: raw.event_kind, action: raw.event_action, via: raw.event_via }
        : null,
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
