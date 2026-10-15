import { queryOptions } from "@tanstack/react-query";

import {
  type ActivityAnswerOutcome,
  type ActivityRow,
  activityAnswerCopy,
  activityIntegrationName,
  type IntegrationNames,
} from "./activity-screen";
import { groupAgents } from "./agent-cards";
import type { AgentListItem } from "./agent-queries";
import { api } from "./api";
import { count } from "./format";
import {
  type ActivityPage,
  activityKeys,
  activityToolLabel,
  refusalSentence,
} from "./integration-activity";
import type { Integration, SuggestedIntegration } from "./integration-queries";
import { agentsPhrase, integrationsListOf, suggestedVendorsOf } from "./integrations-list";

/**
 * Home (GRA-327; Figma 2040:5486), as pure decisions over the reads each panel owns: how many
 * rows a panel draws, and the sentences its rows say. `routes/_auth/_shell/index.tsx` and
 * `components/home/*` draw what these answer. The words follow the screens each panel summarises,
 * so a row reads the same here as on the screen its "See all" opens.
 */

/** Rows *Needs you* draws before "See all requests" carries the rest. */
export const NEEDS_YOU_ROWS = 4;
/** Active agents *Your agents* lists before "All agents" carries the rest. */
export const HOME_AGENT_ROWS = 6;
/** Integrations *Connected integrations* lists, those needing the person first. */
export const HOME_INTEGRATION_ROWS = 5;
/** The latest runs and answers *Recent activity* reads. */
export const HOME_ACTIVITY_ROWS = 5;
/** Tiles *Suggested for your agents* draws, one row of them at full width. */
export const HOME_SUGGESTED_TILES = 4;

/** The first `limit` of a list, and how many it leaves out. */
export function firstOf<T>(rows: readonly T[], limit: number): { shown: T[]; more: number } {
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/**
 * *Needs you*'s rows: the sign-in rows first, then the asks, as Requests' Open list orders them
 * (GRA-313), cut to `NEEDS_YOU_ROWS` together, so the first rows here are the first rows there.
 */
export function needsYouRows<S, A>(
  signIns: readonly S[],
  asks: readonly A[],
): { signIns: S[]; asks: A[]; more: number } {
  const shownSignIns = signIns.slice(0, NEEDS_YOU_ROWS);
  const shownAsks = asks.slice(0, NEEDS_YOU_ROWS - shownSignIns.length);
  return {
    signIns: shownSignIns,
    asks: shownAsks,
    more: signIns.length + asks.length - shownSignIns.length - shownAsks.length,
  };
}

/** The active agents, in the server's order; a revoked agent is the agents screen's to show. */
export function homeAgents<T extends Pick<AgentListItem, "revokedAt">>(agents: readonly T[]) {
  return firstOf(groupAgents(agents).active, HOME_AGENT_ROWS);
}

/**
 * The integrations Home lists: the Integrations screen's default order (one that needs the person
 * first, worst first, then the most recently used), cut to `HOME_INTEGRATION_ROWS`.
 */
export function homeIntegrations(rows: readonly Integration[]) {
  return firstOf(integrationsListOf(rows, { query: "", sort: "attention" }), HOME_INTEGRATION_ROWS);
}

/** "3 tools, used by Claude and Codex"; "No tools yet, no agent can use it". */
export function integrationUsageLine(row: Pick<Integration, "toolCount" | "agents">): string {
  const tools = row.toolCount === 0 ? "No tools yet" : count(row.toolCount, "tool");
  const agents =
    row.agents.length === 0 ? "no agent can use it" : `used by ${agentsPhrase(row.agents)}`;
  return `${tools}, ${agents}`;
}

/**
 * The suggested tiles: GRA-305's read one per vendor, less any connected since (the Integrations
 * banner's `suggestedVendorsOf`), cut to one row.
 */
export function homeSuggestions(
  suggestions: readonly SuggestedIntegration[],
  integrations: readonly Pick<Integration, "vendor">[],
): SuggestedIntegration[] {
  return suggestedVendorsOf(suggestions, integrations).slice(0, HOME_SUGGESTED_TILES);
}

/**
 * A suggested tile's line: who asked and where the ask stands, never what the agent was asked
 * about (ADR 0001 as amended 2026-10-14: the person's own asks, and nothing quoted from a chat).
 */
export function suggestionLine(suggestion: Pick<SuggestedIntegration, "agent" | "ask">): string {
  const agent = suggestion.agent.name;
  switch (suggestion.ask.state) {
    case "open":
      return `${agent} is waiting on this one`;
    case "declined":
      return `${agent} asked for it, and you declined`;
    case "expired":
      return `${agent} asked for it`;
  }
}

/** The person's latest runs and answers: the activity read's first page, at Home's length. */
export const homeActivityQuery = queryOptions({
  queryKey: [...activityKeys.all, "home"] as const,
  queryFn: () => api<ActivityPage>(`/activity?limit=${HOME_ACTIVITY_ROWS}`),
  // A run or an answer lands from any agent or chat, none of which knows this read.
  staleTime: 0,
});

/**
 * What Home knows of the person's integrations to name a row's, from the integrations read alone:
 * a live integration by its slug, a live connection by its id. A row for a connection revoked
 * since names the slug, as the Activity screen does for one deleted (`activityIntegrationName`).
 */
export function homeIntegrationNames(integrations: readonly Integration[]): IntegrationNames {
  return {
    byVendor: new Map(integrations.map((row) => [row.vendor, row.displayName])),
    byConnection: new Map(
      integrations.flatMap((row) =>
        row.connections.map((connection) => [connection.id, connection.displayName] as const),
      ),
    ),
  };
}

/** How a row ended, for its sub-line's colour: a failure or a block reads as needing a look. */
export type HomeActivityTone = "muted" | "destructive";

export type HomeActivityCopy = { title: string; detail: string; tone: HomeActivityTone };

/**
 * A failed run's sub-line by the ledger's `reason` (`@graft/db`'s `schema/usage.ts`). None of the
 * words says the integration answered with an error: a failure is also Graft's sandbox or the
 * tool's own code, and the ledger does not tell a vendor's error apart from those.
 */
const FAILURE_SENTENCES: Record<string, string> = {
  timeout: "It took too long and was stopped",
  killed: "It was stopped before it finished",
  still_running: "It was still running when Graft stopped waiting",
  sandbox_unavailable: "Graft could not start it",
};

export function failureSentence(reason: string | null): string {
  return (reason ? FAILURE_SENTENCES[reason] : undefined) ?? "It could not finish";
}

/** The outcomes that are an answer the person gave, which Home's sub-line calls one. */
const ANSWERS = new Set<ActivityAnswerOutcome>(["allowed", "connected", "denied", "declined"]);

/**
 * A row as one sentence and a sub-line: "Codex ran Find invoices in Gmail", "Ran without asking".
 * A run is said here from the Activity table's own pieces (`activityToolLabel`,
 * `refusalSentence`); an answer is the Activity screen's sentence (`activityAnswerCopy`).
 */
export function homeActivityCopy(row: ActivityRow, names: IntegrationNames): HomeActivityCopy {
  const integration = activityIntegrationName(row, names);
  if (row.kind === "approval") {
    const copy = activityAnswerCopy(row, integration);
    return {
      title: copy.sentence,
      // A withdraw, a change or a revoke is something the person did, not an answer they gave.
      detail: ANSWERS.has(copy.outcome) ? "Your answer" : "Your change",
      tone: "muted",
    };
  }
  const agent = row.agent.name;
  const tool = activityToolLabel(row.tool.wireName);
  const where = integration ? ` in ${integration}` : "";
  switch (row.outcome) {
    case "ok":
      return {
        title: `${agent} ran ${tool}${where}`,
        detail: row.asked === false ? "Ran without asking" : row.asked ? "You allowed it" : "Ran",
        tone: "muted",
      };
    case "refused":
      return {
        title: `${agent} was blocked from ${tool}${where}`,
        detail: refusalSentence(row.reason) ?? "Graft stopped it before it ran",
        tone: "destructive",
      };
    default:
      return {
        title: `${agent}'s ${tool} failed`,
        detail: failureSentence(row.reason),
        tone: "destructive",
      };
  }
}
