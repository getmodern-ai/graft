import type { UsageOutcome } from "@graft/db/schema/usage";
import type { ActivityOutput, ActivityRunOutput } from "@graft/server/api";
import { infiniteQueryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import { toolActionWords } from "./request-row";

/**
 * The integration page's Activity tab (GRA-319): the person's activity read (GRA-308,
 * `GET /api/activity`) narrowed to one vendor's runs, with the tab's two filters riding in the
 * URL's search beside `?tab=activity`. The decisions are pure functions here; the tab is
 * `components/integration/activity-tab.tsx`.
 */

export type ActivityPage = Jsonified<ActivityOutput>;
export type ActivityRun = Jsonified<ActivityRunOutput>;

/** The outcome filter in the person's words; the URL carries these, the server the ledger's. */
export const ACTIVITY_OUTCOME_FILTERS = ["ran", "failed", "blocked"] as const;
export type ActivityOutcomeFilter = (typeof ACTIVITY_OUTCOME_FILTERS)[number];

const LEDGER_OUTCOME: Record<ActivityOutcomeFilter, UsageOutcome> = {
  ran: "ok",
  failed: "error",
  blocked: "refused",
};

export const ACTIVITY_OUTCOME_LABELS: Record<ActivityOutcomeFilter, string> = {
  ran: "Ran",
  failed: "Failed",
  blocked: "Blocked",
};

/** The value the filters' selects use for "no filter"; never written to the URL. */
export const ALL = "all";

export type ActivityFilters = { agent?: string; outcome?: ActivityOutcomeFilter };

/**
 * The filters off the route's search: `agent` when it is a non-empty string, `outcome` when it is
 * one of the three words. Anything else is dropped, so a stray value never sticks in the URL.
 * Read only on the Activity tab: another tab's link writes `{ tab }` alone, which clears them.
 */
export function readActivityFilters(search: Record<string, unknown>): ActivityFilters {
  if (search.tab !== "activity") return {};
  const filters: ActivityFilters = {};
  const { agent, outcome } = search;
  if (typeof agent === "string" && agent.length > 0 && agent.length <= 200) filters.agent = agent;
  if (
    typeof outcome === "string" &&
    (ACTIVITY_OUTCOME_FILTERS as readonly string[]).includes(outcome)
  ) {
    filters.outcome = outcome as ActivityOutcomeFilter;
  }
  return filters;
}

/**
 * The read's query string for a page: the vendor's runs (`kind=run`; meta-tool calls and dry runs
 * stay out, as the read leaves them by default), narrowed by the filters, from `cursor`.
 */
export function activitySearchParams(
  vendor: string,
  filters: ActivityFilters,
  cursor: string | null,
): URLSearchParams {
  const params = new URLSearchParams({ vendor, kind: "run" });
  if (filters.agent) params.set("agentId", filters.agent);
  if (filters.outcome) params.set("outcome", LEDGER_OUTCOME[filters.outcome]);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export const activityKeys = {
  all: ["activity"] as const,
  integration: (vendor: string, filters: ActivityFilters) =>
    ["activity", "integration", vendor, filters.agent ?? null, filters.outcome ?? null] as const,
};

/** One vendor's runs, a page at a time; "Show older calls" fetches the next page by its cursor. */
export function integrationActivityQuery(vendor: string, filters: ActivityFilters) {
  return infiniteQueryOptions({
    queryKey: activityKeys.integration(vendor, filters),
    queryFn: ({ pageParam }) =>
      api<ActivityPage>(`/activity?${activitySearchParams(vendor, filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * The runs of every page loaded, in order. The read answers runs alone under `kind=run`; the
 * narrowing keeps the type honest rather than trusting it.
 */
export function activityRuns(pages: readonly ActivityPage[] | undefined): ActivityRun[] {
  return (pages ?? []).flatMap((page) =>
    page.rows.filter((row): row is ActivityRun => row.kind === "run"),
  );
}

/**
 * A blocked call's `reason` (GRA-301) as a short sentence for the chip's tooltip. The common
 * refusals have their own; every other code reads as the generic sentence, so a raw code never
 * reaches the person. Null on a row with no reason (an `ok` line, or one written before GRA-301).
 */
const REFUSAL_SENTENCES: Record<string, string> = {
  approval_declined: "You declined it",
  tool_denied: "You denied it",
  awaiting_approval: "Waiting for you",
  approval_expired: "Your answer did not come in time",
  connection_revoked: "The connection was revoked",
  connection_not_in_scope: "The agent was not given this connection",
  input_invalid: "The agent sent input the tool does not take",
};

export function refusalSentence(reason: string | null): string | null {
  if (!reason) return null;
  return REFUSAL_SENTENCES[reason] ?? "Graft stopped it before it ran";
}

/**
 * The tool as the row names it: the wire name's own part read as words with a capital
 * ("send_email" is "Send email"); `execute__<connection>`, the by-hand command tool, has no name of
 * its own to read.
 */
export function activityToolLabel(wireName: string): string {
  if (wireName.startsWith("execute__")) return "Command run directly";
  const words = toolActionWords(wireName);
  if (!words) return wireName;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Time taken, in seconds to a tenth as the frame prints it. A blocked call never ran, so it says
 * so where the frame draws a dash (console copy has no dashes); anything under a tenth is
 * "<0.1 s" rather than a misleading zero.
 */
export function timeTakenLabel(run: Pick<ActivityRun, "latencyMs" | "outcome">): string {
  if (run.outcome === "refused") return "Not run";
  if (run.latencyMs < 100) return "<0.1 s";
  return `${(run.latencyMs / 1000).toFixed(1)} s`;
}

/** The footnote under the table, worded to what the ledger holds and nothing more. */
export function activityFootnote(integrationName: string): string {
  return `Graft records which tool ran, for which agent, how it ended and how long it took. It never records what a tool read from or sent to ${integrationName}.`;
}
