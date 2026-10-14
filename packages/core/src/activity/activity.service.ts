import {
  type ActivityFilter,
  type ActivityKind,
  type ActivityPosition,
  type ActivityRow,
  type AgentActivityCounts,
  type AgentLastRunRow,
  activityKind,
} from "@graft/db/repo/activity";
import { type UsageOutcome, usageOutcome } from "@graft/db/schema/usage";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { AgentScope, Principal } from "../tenancy";
import type { ActivityDeps } from "./activity.deps";

/**
 * The console's activity (GRA-308): one person-wide stream of runs and approvals that Home, the
 * agent page, an integration's Activity tab and the Activity screen read with their own filters,
 * and the agent page's week of figures. Every read is under the person (`@graft/db`'s
 * `repo/activity.ts`), so an agent, a vendor or a connection of another person's matches nothing.
 */

/** A page of activity when the console names no size, and the most it may name. */
export const ACTIVITY_PAGE = 50;
export const MAX_ACTIVITY_PAGE = 100;

/** The window of the agent page's figures. */
export const AGENT_STATS_WINDOW_DAYS = 7;

export type ActivityInput = {
  agentId?: string | null;
  vendor?: string | null;
  connectionId?: string | null;
  outcome?: string | null;
  kind?: string | null;
  includeMetaTools?: boolean;
  includeDryRuns?: boolean;
  cursor?: string | null;
  limit?: number | null;
};

export type ActivityPage = {
  rows: ActivityRow[];
  /** Where the next page starts, opaque to the console; null on the last page. */
  nextCursor: string | null;
};

/**
 * A page of the person's activity, newest first. One row past the page is read to know whether
 * another exists, so the last page answers no cursor. The cursor names the page's last row by its
 * moment and key (`ActivityPosition`), so rows written meanwhile land above it and the next page
 * starts where this one stopped.
 */
export async function listActivity(
  ctx: ServiceContext,
  principal: Principal,
  input: ActivityInput,
  deps: ActivityDeps,
): Promise<ActivityPage> {
  const limit = input.limit ?? ACTIVITY_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A page of activity holds between 1 and ${MAX_ACTIVITY_PAGE}`,
    );
  }
  const filter: ActivityFilter = {
    agentId: input.agentId || null,
    vendor: input.vendor || null,
    connectionId: input.connectionId || null,
    outcome: outcomeOf(input.outcome),
    kind: kindOf(input.kind),
    includeMetaTools: input.includeMetaTools ?? false,
    includeDryRuns: input.includeDryRuns ?? false,
  };
  // Absent is the first page; present, even empty, must be a cursor, as the Done list's.
  const after = input.cursor == null ? null : decodeActivityCursor(input.cursor);
  const read = await deps.listActivity(ctx.db, principal.personId, {
    filter,
    limit: limit + 1,
    after,
  });
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: read.length > limit && last ? encodeActivityCursor(last.position) : null,
  };
}

function outcomeOf(value: string | null | undefined): UsageOutcome | null {
  if (!value) return null;
  if ((usageOutcome as readonly string[]).includes(value)) return value as UsageOutcome;
  throw new ServiceError("BAD_REQUEST", `outcome is one of ${usageOutcome.join(", ")}`);
}

function kindOf(value: string | null | undefined): ActivityKind | null {
  if (!value) return null;
  if ((activityKind as readonly string[]).includes(value)) return value as ActivityKind;
  throw new ServiceError("BAD_REQUEST", `kind is one of ${activityKind.join(", ")}`);
}

export function encodeActivityCursor(position: ActivityPosition): string {
  return Buffer.from(JSON.stringify({ t: position.at, k: position.key })).toString("base64url");
}

/** A `timestamp` as Postgres prints it, the only form `ActivityPosition.at` holds. */
const POSTGRES_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

/**
 * Whether the moment is Postgres's print of a real one. `Date` rolls an impossible day over
 * (`02-30` reads as March 2) where Postgres's cast refuses it, so the date and time are read back
 * and compared with what was written.
 */
function isCalendarTimestamp(value: string): boolean {
  if (!POSTGRES_TIMESTAMP.test(value)) return false;
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19).replace(" ", "T")
  );
}

/**
 * The cursor back. Anything that is not the shape `encodeActivityCursor` writes is a `BAD_REQUEST`
 * rather than a first page. Unsigned, as the Done list's: the statement is under the person
 * whatever it says, so a hand-built one only positions the person's own stream.
 */
export function decodeActivityCursor(cursor: string): ActivityPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const { t, k } = parsed as Record<string, unknown>;
      if (
        typeof t === "string" &&
        isCalendarTimestamp(t) &&
        typeof k === "string" &&
        k.length > 0 &&
        k.length <= 512
      ) {
        return { at: t, key: k };
      }
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ServiceError("BAD_REQUEST", "That cursor is not one this list wrote");
}

export type AgentActivityStats = AgentActivityCounts & {
  /** The window's start: the counts are of lines at or after it. */
  since: Date;
  /** The agent's newest run and its tool, whenever it was; null when it never ran one. */
  lastRun: AgentLastRunRow | null;
};

/**
 * The agent page's figures: runs over the last `AGENT_STATS_WINDOW_DAYS` days, how many of those
 * ran without asking and how many were approved, and the agent's last run with its tool. The
 * caller has already found the agent under the person; the reads are agent-scoped regardless.
 */
export async function getAgentActivityStats(
  ctx: ServiceContext,
  scope: AgentScope,
  deps: ActivityDeps,
): Promise<AgentActivityStats> {
  const since = new Date(deps.now().getTime() - AGENT_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [counts, lastRun] = await Promise.all([
    deps.countAgentActivity(ctx.db, scope, { since }),
    deps.findAgentLastRun(ctx.db, scope),
  ]);
  return { ...counts, since, lastRun };
}
