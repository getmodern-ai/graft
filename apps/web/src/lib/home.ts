import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import type { ActivityRowOutput } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { groupAgents } from "./agent-cards";
import type { AgentListItem } from "./agent-queries";
import { api, type Jsonified } from "./api";
import { count } from "./format";
import {
  type ActivityPage,
  activityKeys,
  activityToolLabel,
  refusalSentence,
} from "./integration-activity";
import type { Integration, SuggestedIntegration } from "./integration-queries";
import { agentsPhrase, integrationsListOf, suggestedVendorsOf } from "./integrations-list";
import { toolActionWords } from "./request-row";

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

export type HomeActivityRow = Jsonified<ActivityRowOutput>;

/** The person's latest runs and answers: the activity read's first page, at Home's length. */
export const homeActivityQuery = queryOptions({
  queryKey: [...activityKeys.all, "home"] as const,
  queryFn: () => api<ActivityPage>(`/activity?limit=${HOME_ACTIVITY_ROWS}`),
  // A run or an answer lands from any agent or chat, none of which knows this read.
  staleTime: 0,
});

/** How a row ended, for its sub-line's colour: a failure or a block reads as needing a look. */
export type HomeActivityTone = "muted" | "destructive";

export type HomeActivityCopy = { title: string; detail: string; tone: HomeActivityTone };

/**
 * The integration a row names: a starter's own name, else the live integration's, else the slug,
 * which is all a row for a connection since revoked has. Null where no vendor was recorded.
 */
export function activityIntegrationName(
  vendor: string | null,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!vendor) return null;
  return integrationNameFor(vendor, names.get(vendor) ?? vendor);
}

function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * A run's or an answer's sentence and sub-line, in the Activity screen's words (GRA-330): "Codex
 * ran Find invoices in Gmail", "Ran without asking". An answer never claims "always": an allow may
 * still ask on every call (`askEveryCall`, ADR 0008), which the read does not carry.
 */
export function homeActivityCopy(
  row: HomeActivityRow,
  names: ReadonlyMap<string, string>,
): HomeActivityCopy {
  const agent = row.agent.name;
  const integration = activityIntegrationName(row.vendor, names);
  const where = integration ? ` in ${integration}` : "";
  if (row.kind === "run") {
    const tool = activityToolLabel(row.tool.wireName);
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
          title: `${possessive(agent)} ${tool} failed`,
          detail: integration ? `${integration} returned an error` : "It returned an error",
          tone: "destructive",
        };
    }
  }

  const name = integration ?? "an integration";
  const answer = row.answer ?? {};
  const allowed = answer.allow === true;
  const connected = typeof answer.connectionId === "string" && answer.connectionId !== "";
  const said = (title: string): HomeActivityCopy => ({
    title,
    detail: "Your answer",
    tone: "muted",
  });
  switch (row.source) {
    case "tool": {
      const words = row.tool ? toolActionWords(row.tool.wireName) : null;
      const action = words ? `${words} in ${name}` : `use a ${name} tool`;
      return said(
        row.decision === "deny"
          ? `You denied ${agent} permission to ${action}`
          : `You allowed ${agent} to ${action}`,
      );
    }
    case "vendor":
      return said(
        row.includesDestructive === true
          ? `You allowed ${agent} every ${name} tool, including ones that can delete`
          : `You allowed ${agent} every ${name} tool that cannot delete`,
      );
    case "ask":
      switch (row.askKind) {
        case "build":
          return said(
            allowed
              ? `You let ${agent} build its own ${name} tools`
              : `You declined ${possessive(agent)} request to build ${name} tools`,
          );
        case "scope":
          return said(
            allowed
              ? `You let ${agent} use ${name}`
              : `You declined ${possessive(agent)} request to use ${name}`,
          );
        case "connection":
          return said(
            connected
              ? `You connected ${name} for ${agent}`
              : `You declined ${possessive(agent)} request to connect ${name}`,
          );
        case "credential":
          return said(
            connected
              ? `You reconnected ${name} for ${agent}`
              : `You declined ${possessive(agent)} request to reconnect ${name}`,
          );
        default:
          return said(
            allowed || connected
              ? `You answered ${possessive(agent)} request`
              : `You declined ${possessive(agent)} request`,
          );
      }
  }
}
