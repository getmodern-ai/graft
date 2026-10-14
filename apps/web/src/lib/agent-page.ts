import type { AgentStatsOutput } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { type Agent, agentKeys } from "./agent-queries";
import { api, type Jsonified } from "./api";
import {
  type ActivityPage,
  activityKeys,
  activityToolLabel,
  refusalSentence,
} from "./integration-activity";
import type { Integration } from "./integration-queries";
import type { PendingAction } from "./pending-action-queries";
import { toolActionWords } from "./request-row";

/**
 * The agent page's top and right column (GRA-325; Figma 2047:7614): the header's facts line, the
 * four stats and the recent activity, as pure decisions. The figures are `GET /api/agents/:id/stats`
 * and the rows `GET /api/activity?agentId=` (GRA-308), both of which already leave meta-tool calls
 * and dry runs out; the components are `components/agent/agent-{header,stats,recent-activity}.tsx`.
 */

export type AgentStats = Jsonified<AgentStatsOutput>;
export type ActivityRow = ActivityPage["rows"][number];

/** How many rows the page's recent activity draws; the Activity screen has the rest. */
export const RECENT_ACTIVITY_LIMIT = 5;

/** Under the agent's key, so a write that refreshes the agent refreshes its figures too. */
export const agentStatsQuery = (agentId: string) =>
  queryOptions({
    queryKey: [...agentKeys.one(agentId), "stats"] as const,
    queryFn: () => api<AgentStats>(`/agents/${encodeURIComponent(agentId)}/stats`),
  });

/** Under `activityKeys.all`, beside the integration page's read of the same stream. */
export const agentRecentActivityQuery = (agentId: string) =>
  queryOptions({
    queryKey: [...activityKeys.all, "agent", agentId, RECENT_ACTIVITY_LIMIT] as const,
    queryFn: () =>
      api<ActivityPage>(
        `/activity?${new URLSearchParams({ agentId, limit: String(RECENT_ACTIVITY_LIMIT) })}`,
      ),
  });

/**
 * The header's line under the name: the client that consented (ADR 0018) or *Not recorded*, since
 * when, and how it signs in. A static-token agent's moment is its creation, which is when the
 * token was minted; an agent awaiting its software (ADR 0024) has neither yet and says so.
 */
export function agentHeaderFacts(
  agent: Pick<Agent, "connectedVia" | "tokenPrefix" | "createdAt">,
): { client: string; since: { verb: string; at: string }; signsIn: string } {
  const client = agent.connectedVia?.clientName ?? "Not recorded";
  const verb = agent.connectedVia ? "connected" : "created";
  return { client, since: { verb, at: agent.createdAt }, signsIn: signsInPhrase(agent) };
}

function signsInPhrase(agent: Pick<Agent, "connectedVia" | "tokenPrefix">): string {
  if (agent.connectedVia && agent.tokenPrefix) return "signs in with OAuth or a token";
  if (agent.connectedVia) return "signs in with OAuth";
  if (agent.tokenPrefix) return "signs in with a token";
  return "not signed in yet";
}

/** Waiting on you: the open asks this agent put, from the list Requests reads. */
export function agentRequestCount(
  pendingActions: readonly Pick<PendingAction, "agentId">[],
  agentId: string,
): number {
  return pendingActions.filter((action) => action.agentId === agentId).length;
}

/**
 * Integrations it can use, "N of M": of the person's integrations (one per vendor with a live
 * connection), those with a connection in the agent's scope, named in the list's order.
 */
export function agentIntegrationsStat(
  connectionIds: readonly string[],
  integrations: readonly (Pick<Integration, "displayName"> & {
    connections: readonly { id: string }[];
  })[],
): { usable: number; total: number; names: string[] } {
  const inScope = new Set(connectionIds);
  const names = integrations
    .filter((integration) => integration.connections.some((c) => inScope.has(c.id)))
    .map((integration) => integration.displayName);
  return { usable: names.length, total: integrations.length, names };
}

/** "3 of 5". */
export function integrationsStatValue(stat: { usable: number; total: number }): string {
  return `${stat.usable} of ${stat.total}`;
}

/** The names under it, or a sentence when there are none to name. */
export function integrationsStatDetail(stat: { usable: number; total: number; names: string[] }) {
  if (stat.total === 0) return "No integrations connected yet";
  if (stat.usable === 0) return "None of yours yet";
  return stat.names.join(", ");
}

/**
 * The run split as GRA-286 defines it: of the week's runs, those the gate passed with no ask and
 * those the person approved. A run that ended another way (a failure, a refusal) is in the total
 * and in neither half, so the halves are not made to add up.
 */
export function runsSplitLine(stats: Pick<AgentStats, "runs" | "ranWithoutAsking" | "approved">) {
  if (stats.runs === 0) return "Nothing ran in the last 7 days";
  return `${stats.ranWithoutAsking} ran without asking · ${stats.approved} approved`;
}

/** What a row's status icon shows, one per way a row can end. */
export type ActivityIcon = "ran" | "failed" | "asked" | "blocked" | "allowed" | "denied";

export type ActivityRowView = {
  icon: ActivityIcon;
  title: string;
  /** The integration's name, or null where nothing recorded one. */
  integration: string | null;
  /** How it went in words, after the time; null when there is nothing to add. */
  sentence: string | null;
};

/** The integration a row names: its display name when the person holds it, else the slug. */
export function integrationNameOf(
  vendor: string | null,
  integrations: readonly Pick<Integration, "vendor" | "displayName">[],
): string | null {
  if (!vendor) return null;
  return integrations.find((integration) => integration.vendor === vendor)?.displayName ?? vendor;
}

/**
 * One row of the recent activity in the person's words (Figma's "Ran …", "Asked to …", "Blocked
 * from …"). A run reads off the ledger's `outcome`, `reason` and `asked` (`@graft/db`'s
 * `schema/usage.ts` gives their meanings); an approval is a moment the person answered.
 */
export function activityRowView(row: ActivityRow, integration: string | null): ActivityRowView {
  if (row.kind === "run") {
    const tool = activityToolLabel(row.tool.wireName);
    if (row.outcome === "ok") {
      const sentence =
        row.asked === true ? "you approved it" : row.asked === false ? "ran without asking" : null;
      return { icon: "ran", title: `Ran ${tool}`, integration, sentence };
    }
    if (row.outcome === "error") {
      return { icon: "failed", title: `${tool} failed`, integration, sentence: null };
    }
    if (row.reason === "awaiting_approval") {
      const words = toolActionWords(row.tool.wireName);
      return {
        icon: "asked",
        title: words ? `Asked to ${words}` : `Asked to run ${tool}`,
        integration,
        sentence: lowerFirst(refusalSentence(row.reason)),
      };
    }
    return {
      icon: "blocked",
      title: `Blocked from ${tool}`,
      integration,
      sentence: lowerFirst(refusalSentence(row.reason) ?? "Graft stopped it before it ran"),
    };
  }

  const subject = integration ?? "an integration";
  if (row.source === "tool") {
    const tool = row.tool ? activityToolLabel(row.tool.wireName) : "a tool";
    return row.decision === "deny"
      ? { icon: "denied", title: `Said no to ${tool}`, integration, sentence: "you denied it" }
      : { icon: "allowed", title: `Allowed ${tool}`, integration, sentence: "you allowed it" };
  }
  if (row.source === "vendor") {
    return {
      icon: "allowed",
      title: `Allowed every ${subject} tool`,
      integration,
      sentence: row.includesDestructive ? "including ones that delete" : null,
    };
  }
  const declined = row.answer?.allow === false;
  return {
    icon: declined ? "denied" : "allowed",
    title: askTitle(row.askKind, subject, declined),
    integration,
    sentence: declined ? "you said no" : null,
  };
}

function askTitle(kind: string | null, subject: string, declined: boolean): string {
  switch (kind) {
    case "connection":
      return declined ? `Said no to connecting ${subject}` : `Connected ${subject}`;
    case "build":
      return declined
        ? `Said no to building tools for ${subject}`
        : `Allowed building tools for ${subject}`;
    case "scope":
      return declined ? `Said no to giving it ${subject}` : `Gave it ${subject}`;
    default:
      return declined ? "Said no to a request" : "Answered a request";
  }
}

/** A sentence read mid-line, after the time; a name keeps its capital. */
function lowerFirst(sentence: string | null): string | null {
  if (!sentence) return null;
  if (sentence.startsWith("Graft")) return sentence;
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** Last active: the last run's tool under the time, or nothing ran yet. */
export function lastActiveDetail(stats: Pick<AgentStats, "lastRun">): string {
  if (!stats.lastRun) return "No tool has run yet";
  return activityToolLabel(stats.lastRun.tool.wireName);
}

/**
 * The Activity screen filtered by the agent (GRA-330's `?agent=`), as a plain href: *All* links
 * there whether or not that route has landed.
 */
export function agentActivityHref(agentId: string): string {
  return `/activity?${new URLSearchParams({ agent: agentId })}`;
}
