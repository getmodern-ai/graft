import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import type { ActivityApprovalOutput, ActivityRowOutput } from "@graft/server/api";
import { infiniteQueryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import {
  ACTIVITY_OUTCOME_FILTERS,
  ACTIVITY_OUTCOME_LABELS,
  type ActivityOutcomeFilter,
  type ActivityPage,
  activityKeys,
  LEDGER_OUTCOME,
} from "./integration-activity";
import { toolActionWords } from "./request-row";

/**
 * The Activity screen (GRA-330; GRA-286's decision): the integration page's Activity table
 * (GRA-319, `lib/integration-activity.ts`) across every integration, with the person's answers as
 * rows of their own. The three filters ride in the URL, `/activity?vendor=&agent=&outcome=`, so
 * Home's "View all", an agent page's "All" and Search link here with one applied.
 */

export type ActivityRow = Jsonified<ActivityRowOutput>;
export type ActivityApproval = Jsonified<ActivityApprovalOutput>;

/**
 * The outcome filter: the tab's three words for a call, and `answered` for the person's answers
 * alone. The read leaves the answers out whenever it filters by a call's outcome, so "Ran" lists
 * calls only and "Your answers" is the way to list the answers alone.
 */
export const ACTIVITY_SCREEN_OUTCOMES = [...ACTIVITY_OUTCOME_FILTERS, "answered"] as const;
export type ActivityScreenOutcome = (typeof ACTIVITY_SCREEN_OUTCOMES)[number];

export const ACTIVITY_SCREEN_OUTCOME_LABELS: Record<ActivityScreenOutcome, string> = {
  ...ACTIVITY_OUTCOME_LABELS,
  answered: "Your answers",
};

/** The screen's search; every key optional, so a link names only the filter it applies. */
export type ActivityScreenSearch = {
  vendor?: string;
  agent?: string;
  outcome?: ActivityScreenOutcome;
};

const MAX_ID = 200;

function idOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID
    ? value
    : undefined;
}

/**
 * The filters off the route's search: `vendor` and `agent` when each is a non-empty string within
 * the read's bound, `outcome` when it is one of the four words. Anything else is dropped, so a
 * stray value never sticks in the URL.
 */
export function readActivityScreenSearch(search: Record<string, unknown>): ActivityScreenSearch {
  const filters: ActivityScreenSearch = {};
  const vendor = idOf(search.vendor);
  const agent = idOf(search.agent);
  if (vendor) filters.vendor = vendor;
  if (agent) filters.agent = agent;
  if (
    typeof search.outcome === "string" &&
    (ACTIVITY_SCREEN_OUTCOMES as readonly string[]).includes(search.outcome)
  ) {
    filters.outcome = search.outcome as ActivityScreenOutcome;
  }
  return filters;
}

/** Whether any filter is applied, which decides the empty body's sentence. */
export function isFiltered(filters: ActivityScreenSearch): boolean {
  return (
    filters.vendor !== undefined || filters.agent !== undefined || filters.outcome !== undefined
  );
}

/**
 * The read's query string for a page: calls and answers alike (meta-tool calls and dry runs stay
 * out, the read's default), narrowed by the filters, from `cursor`. A call's outcome is the
 * ledger's word, which the read answers with calls alone; `answered` is `kind=approval`.
 */
export function activityScreenSearchParams(
  filters: ActivityScreenSearch,
  cursor: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.vendor) params.set("vendor", filters.vendor);
  if (filters.agent) params.set("agentId", filters.agent);
  if (filters.outcome === "answered") params.set("kind", "approval");
  else if (filters.outcome)
    params.set("outcome", LEDGER_OUTCOME[filters.outcome as ActivityOutcomeFilter]);
  if (cursor) params.set("cursor", cursor);
  return params;
}

/** Under `activityKeys.all`, beside the integration tab's pages. */
export const activityScreenKey = (filters: ActivityScreenSearch) =>
  [
    ...activityKeys.all,
    "screen",
    filters.vendor ?? null,
    filters.agent ?? null,
    filters.outcome ?? null,
  ] as const;

/** The person's activity, a page at a time; "Show older" fetches the next page by its cursor. */
export function activityScreenQuery(filters: ActivityScreenSearch) {
  return infiniteQueryOptions({
    queryKey: activityScreenKey(filters),
    queryFn: ({ pageParam }) =>
      api<ActivityPage>(`/activity?${activityScreenSearchParams(filters, pageParam)}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // An answer lands here from the console, a chat's card or an agent's elicitation, and a run
    // from any agent, none of which knows this read; stale at once, so every visit reads afresh.
    staleTime: 0,
  });
}

/** The rows of every page loaded, in order, calls and answers both. */
export function activityRows(pages: readonly ActivityPage[] | undefined): ActivityRow[] {
  return (pages ?? []).flatMap((page) => page.rows);
}

/** What the screen knows of the person's integrations, to name a row's. */
export type IntegrationNames = {
  /** A live integration's name by its slug (`GET /integrations`). */
  byVendor: ReadonlyMap<string, string>;
  /** A connection's display name by its id, revoked ones included (`GET /connections`). */
  byConnection: ReadonlyMap<string, string>;
};

/**
 * The integration a row names, as the person reads it: a starter's own name, else the live
 * integration's, else the connection the row recorded, else the slug itself, which is all a row
 * for a connection since deleted has. Null on a row that recorded no vendor (a line before
 * GRA-301).
 */
export function activityIntegrationName(
  row: Pick<ActivityRow, "vendor" | "connectionId">,
  names: IntegrationNames,
): string | null {
  if (!row.vendor) return null;
  const known =
    names.byVendor.get(row.vendor) ??
    (row.connectionId ? names.byConnection.get(row.connectionId) : undefined);
  return integrationNameFor(row.vendor, known ?? row.vendor);
}

/**
 * How an answer ended, for its chip (`ACTIVITY_ANSWER_CHIP`): the four answers, and since GRA-341
 * what the person did to one afterwards: withdrew it, changed how it holds (widened, narrowed, the
 * ask-every-call switch), or revoked a connection or an agent.
 */
export type ActivityAnswerOutcome =
  | "allowed"
  | "connected"
  | "denied"
  | "declined"
  | "withdrawn"
  | "changed"
  | "revoked";

export type ActivityAnswerCopy = { sentence: string; outcome: ActivityAnswerOutcome };

function possessive(name: string): string {
  return `${name}'s`;
}

/** What a tool's row lets a sentence say it does: "draft replies in Gmail". */
function toolAction(tool: ActivityApproval["tool"], integration: string): string {
  const words = tool ? toolActionWords(tool.wireName) : null;
  return words ? `${words} in ${integration}` : `use a ${integration} tool`;
}

/**
 * An answer row's sentence, the person's own words for what they did: "You allowed Codex to
 * draft replies in Gmail", "You withdrew your answer on whether Codex can draft replies in Gmail",
 * "You revoked Notion". An approval event (GRA-341) reads off what it recorded; the three older
 * sources (`repo/activity.ts`) read as before: a tool's standing answer, an integration's
 * standing approval, and an answered ask of another kind, read off its kind and answer alone,
 * since the row carries no payload. A kind this does not know still reads as an answer.
 */
export function activityAnswerCopy(
  row: Pick<
    ActivityApproval,
    "source" | "agent" | "tool" | "decision" | "includesDestructive" | "askKind" | "answer"
  > &
    Partial<Pick<ActivityApproval, "event">>,
  integrationName: string | null,
): ActivityAnswerCopy {
  // Only a connection's revoke names no agent; it was the person's act on every agent.
  const agent = row.agent?.name ?? "every agent";
  const integration = integrationName ?? "an integration";
  switch (row.source) {
    case "event":
      return row.event
        ? eventCopy(row.event, row, agent, integrationName)
        : { sentence: "You changed an answer", outcome: "changed" };
    case "tool": {
      const action = toolAction(row.tool, integration);
      // Not "always": an allow may ask on every call (`askEveryCall`, ADR 0008), which the
      // read does not carry, so the sentence claims no more than that the person said yes.
      return row.decision === "deny"
        ? { sentence: `You denied ${agent} permission to ${action}`, outcome: "denied" }
        : { sentence: `You allowed ${agent} to ${action}`, outcome: "allowed" };
    }
    case "vendor":
      return {
        sentence:
          row.includesDestructive === true
            ? `You allowed ${agent} every ${integration} tool, including ones that can delete`
            : `You allowed ${agent} every ${integration} tool that cannot delete`,
        outcome: "allowed",
      };
    case "ask":
      return askAnswerCopy(row.askKind, row.answer ?? {}, agent, integrationName);
  }
}

/**
 * An approval event's sentence. A yes never says "always": a tool's allow may ask on every call,
 * so only the switch's own events speak of every call, and an integration's allow says which of
 * its tools it covers.
 */
function eventCopy(
  event: NonNullable<ActivityApproval["event"]>,
  row: Pick<ActivityApproval, "tool" | "includesDestructive">,
  agent: string,
  integrationName: string | null,
): ActivityAnswerCopy {
  const integration = integrationName ?? "an integration";
  const tools = integrationName ? `its own ${integrationName} tools` : "its own tools";
  const fallback: ActivityAnswerCopy = { sentence: "You changed an answer", outcome: "changed" };
  switch (event.kind) {
    case "tool": {
      const action = toolAction(row.tool, integration);
      switch (event.action) {
        case "allowed":
          return { sentence: `You allowed ${agent} to ${action}`, outcome: "allowed" };
        case "denied":
          return { sentence: `You denied ${agent} permission to ${action}`, outcome: "denied" };
        case "withdrew":
          return {
            sentence: `You withdrew your answer on whether ${agent} can ${action}`,
            outcome: "withdrawn",
          };
        case "ask_every_call_on":
          return {
            sentence: `${agent} now asks before every call to ${action}`,
            outcome: "changed",
          };
        case "ask_every_call_off":
          return {
            sentence: `${agent} no longer asks before every call to ${action}`,
            outcome: "changed",
          };
        default:
          return fallback;
      }
    }
    case "vendor":
      switch (event.action) {
        case "allowed":
        case "widened":
          return {
            sentence:
              row.includesDestructive === true
                ? `You allowed ${agent} every ${integration} tool, including ones that can delete`
                : `You allowed ${agent} every ${integration} tool that cannot delete`,
            outcome: event.action === "allowed" ? "allowed" : "changed",
          };
        case "narrowed":
          return {
            sentence: `You narrowed ${possessive(agent)} ${integration} approval to tools that cannot delete`,
            outcome: "changed",
          };
        case "withdrew":
          return {
            sentence: `You withdrew ${possessive(agent)} approval for every ${integration} tool`,
            outcome: "withdrawn",
          };
        default:
          return fallback;
      }
    case "build":
      switch (event.action) {
        case "allowed":
          return { sentence: `You let ${agent} build ${tools}`, outcome: "allowed" };
        case "denied":
          return {
            sentence: `You declined ${possessive(agent)} request to build ${tools}`,
            outcome: "declined",
          };
        case "withdrew":
          return {
            sentence: `You withdrew ${possessive(agent)} permission to build ${tools}`,
            outcome: "withdrawn",
          };
        default:
          return fallback;
      }
    case "connection":
      switch (event.action) {
        case "allowed":
          return { sentence: `You connected ${integration} for ${agent}`, outcome: "connected" };
        case "denied":
          return {
            sentence: `You declined ${possessive(agent)} request to connect ${integration}`,
            outcome: "declined",
          };
        case "revoked":
          return { sentence: `You revoked ${integration}`, outcome: "revoked" };
        default:
          return fallback;
      }
    case "scope":
      return event.action === "denied"
        ? {
            sentence: `You declined ${possessive(agent)} request to use ${integration}`,
            outcome: "declined",
          }
        : { sentence: `You let ${agent} use ${integration}`, outcome: "allowed" };
    case "agent":
      return event.action === "revoked"
        ? { sentence: `You revoked ${agent}`, outcome: "revoked" }
        : fallback;
  }
}

function askAnswerCopy(
  kind: string | null,
  answer: Record<string, unknown>,
  agent: string,
  integrationName: string | null,
): ActivityAnswerCopy {
  const integration = integrationName ?? "an integration";
  const allowed = answer.allow === true;
  const connected = typeof answer.connectionId === "string" && answer.connectionId !== "";
  switch (kind) {
    case "build": {
      const tools = integrationName ? `its own ${integrationName} tools` : "its own tools";
      return allowed
        ? { sentence: `You let ${agent} build ${tools}`, outcome: "allowed" }
        : {
            sentence: `You declined ${possessive(agent)} request to build ${tools}`,
            outcome: "declined",
          };
    }
    case "scope":
      if (!allowed) {
        return {
          sentence: `You declined ${possessive(agent)} request to use ${integration}`,
          outcome: "declined",
        };
      }
      return {
        sentence:
          answer.approveBuild === true
            ? `You let ${agent} use ${integration} and build its own tools for it`
            : `You let ${agent} use ${integration}`,
        outcome: "allowed",
      };
    case "connection":
      return connected
        ? { sentence: `You connected ${integration} for ${agent}`, outcome: "connected" }
        : {
            sentence: `You declined ${possessive(agent)} request to connect ${integration}`,
            outcome: "declined",
          };
    case "credential":
      return connected
        ? { sentence: `You reconnected ${integration} for ${agent}`, outcome: "connected" }
        : {
            sentence: `You declined ${possessive(agent)} request to reconnect ${integration}`,
            outcome: "declined",
          };
    default:
      return allowed || connected
        ? { sentence: `You answered ${possessive(agent)} request`, outcome: "allowed" }
        : { sentence: `You declined ${possessive(agent)} request`, outcome: "declined" };
  }
}

/**
 * The value of a filter's "All …" option, never written to the URL. Not the integration tab's
 * `ALL` ("all"): that is a slug a vendor may have, and selecting such an integration would clear
 * the filter. A slug is lowercase letters, digits and hyphens, and an agent id is a UUID, so
 * neither can be this.
 */
export const NO_FILTER = "__all__";

/** One option of a filter's `Select`. */
export type FilterItem = { value: string; label: string };

/**
 * The integration filter's options after "All integrations": every integration the person holds or
 * held a connection of, by name, A to Z, one per slug. A slug the URL names that the list does not
 * hold (a connection deleted since, or a link written by hand) still shows what it filters by.
 */
export function integrationFilterItems(
  connections: readonly { vendor: string; displayName: string }[],
  names: IntegrationNames,
  selected: string | undefined,
): FilterItem[] {
  const bySlug = new Map<string, string>();
  for (const connection of connections) {
    if (bySlug.has(connection.vendor)) continue;
    bySlug.set(
      connection.vendor,
      integrationNameFor(
        connection.vendor,
        names.byVendor.get(connection.vendor) ?? connection.displayName,
      ),
    );
  }
  const items = [...bySlug]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (selected && !bySlug.has(selected)) {
    items.push({ value: selected, label: integrationNameFor(selected, selected) });
  }
  return items;
}
