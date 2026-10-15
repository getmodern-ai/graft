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

/**
 * Under the agent's key, so a write that refreshes the agent refreshes its figures too. Both reads
 * are stale at once, as `integrationsQuery` is: runs land and asks are answered from places that
 * know nothing of this page (a chat's card, the inbox, the agent itself), so every visit refetches
 * rather than drawing what the last one saw.
 */
export const agentStatsQuery = (agentId: string) =>
  queryOptions({
    queryKey: [...agentKeys.one(agentId), "stats"] as const,
    queryFn: () => api<AgentStats>(`/agents/${encodeURIComponent(agentId)}/stats`),
    staleTime: 0,
  });

/** Under `activityKeys.all`, beside the integration page's read of the same stream. */
export const agentRecentActivityQuery = (agentId: string) =>
  queryOptions({
    queryKey: [...activityKeys.all, "agent", agentId, RECENT_ACTIVITY_LIMIT] as const,
    staleTime: 0,
    queryFn: () =>
      api<ActivityPage>(
        `/activity?${new URLSearchParams({ agentId, limit: String(RECENT_ACTIVITY_LIMIT) })}`,
      ),
  });

/**
 * The header's line under the name: the client that consented (ADR 0018) or *Not recorded*, when
 * it was created, and how it signs in; an agent awaiting its software (ADR 0024) says it has not
 * signed in yet. *Created*, never *connected*: an agent Setup minted is connected by a later
 * consent, and the record keeps no moment for that.
 */
export function agentHeaderFacts(
  agent: Pick<Agent, "connectedVia" | "tokenPrefix" | "createdAt">,
): { client: string; created: string; signsIn: string } {
  const client = agent.connectedVia?.clientName ?? "Not recorded";
  return { client, created: agent.createdAt, signsIn: signsInPhrase(agent) };
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
 * connection), those with a connection in the agent's scope, named in the list's order. A revoked
 * agent can use none, whatever its scope still resolves to.
 */
export function agentIntegrationsStat(
  agent: Pick<Agent, "revokedAt">,
  connectionIds: readonly string[],
  integrations: readonly (Pick<Integration, "displayName"> & {
    connections: readonly { id: string }[];
  })[],
): IntegrationsStat {
  const inScope = new Set(agent.revokedAt ? [] : connectionIds);
  const names = integrations
    .filter((integration) => integration.connections.some((c) => inScope.has(c.id)))
    .map((integration) => integration.displayName);
  const revoked = agent.revokedAt !== null;
  return { usable: names.length, total: integrations.length, names, revoked };
}

export type IntegrationsStat = { usable: number; total: number; names: string[]; revoked: boolean };

/** "3 of 5". */
export function integrationsStatValue(stat: Pick<IntegrationsStat, "usable" | "total">): string {
  return `${stat.usable} of ${stat.total}`;
}

/** The names under it, or a sentence when there are none to name. */
export function integrationsStatDetail(stat: IntegrationsStat): string {
  if (stat.revoked) return "None, since it was revoked";
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
export type ActivityIcon =
  | "ran"
  | "failed"
  | "asked"
  | "blocked"
  | "allowed"
  | "denied"
  | "withdrawn"
  | "changed";

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
      // `execute__<connection>` has no action of its own to read; its words would be the id.
      const words = row.tool.wireName.startsWith("execute__")
        ? "run a command"
        : toolActionWords(row.tool.wireName);
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
  if (row.source === "event" && row.event)
    return eventRowView(row, row.event, subject, integration);
  if (row.source === "tool") {
    const tool = row.tool ? activityToolLabel(row.tool.wireName) : "a tool";
    return row.decision === "deny"
      ? { icon: "denied", title: `Said no to ${tool}`, integration, sentence: "you denied it" }
      : { icon: "allowed", title: `Allowed ${tool}`, integration, sentence: "you allowed it" };
  }
  if (row.source === "vendor") {
    // Without destructive tools the approval passes everything else; a tool that deletes still
    // asks (ADR 0008 as amended 2026-10-09), so the title must not claim every tool.
    return row.includesDestructive === true
      ? {
          icon: "allowed",
          title: `Allowed every ${subject} tool`,
          integration,
          sentence: "including ones that can delete",
        }
      : {
          icon: "allowed",
          title: `Allowed every ${subject} tool except ones that delete`,
          integration,
          sentence: null,
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

/**
 * An approval event (GRA-341) on the agent's page, where the agent is implied: what the person
 * did, short. Never "always": only the ask-every-call switch's own events speak of every call.
 */
function eventRowView(
  row: Extract<ActivityRow, { kind: "approval" }>,
  event: NonNullable<Extract<ActivityRow, { kind: "approval" }>["event"]>,
  subject: string,
  integration: string | null,
): ActivityRowView {
  const tool = row.tool ? activityToolLabel(row.tool.wireName) : "a tool";
  const view = (icon: ActivityIcon, title: string, sentence: string | null = null) => ({
    icon,
    title,
    integration,
    sentence,
  });
  switch (`${event.kind}:${event.action}`) {
    case "tool:allowed":
      return view("allowed", `Allowed ${tool}`, "you allowed it");
    case "tool:denied":
      return view("denied", `Said no to ${tool}`, "you denied it");
    case "tool:withdrew":
      return view("withdrawn", `Withdrew your answer on ${tool}`, "it asks again");
    case "tool:ask_every_call_on":
      return view("changed", `Asks before every call to ${tool}`);
    case "tool:ask_every_call_off":
      return view("changed", `No longer asks before every call to ${tool}`);
    case "vendor:allowed":
    case "vendor:widened":
      return row.includesDestructive === true
        ? view("allowed", `Allowed every ${subject} tool`, "including ones that can delete")
        : view("allowed", `Allowed every ${subject} tool except ones that delete`);
    case "vendor:narrowed":
      return view("changed", `Allowed every ${subject} tool except ones that delete`, "narrowed");
    case "vendor:withdrew":
      return view("withdrawn", `Withdrew every ${subject} tool`, "they ask again");
    case "build:allowed":
      return view("allowed", `Allowed building tools for ${subject}`);
    case "build:denied":
      return view("denied", `Said no to building tools for ${subject}`, "you said no");
    case "build:withdrew":
      return view("withdrawn", `Withdrew building tools for ${subject}`);
    case "connection:allowed":
      return view("allowed", `Connected ${subject}`);
    case "connection:denied":
      return view("denied", `Said no to connecting ${subject}`, "you said no");
    case "connection:revoked":
      return view("denied", `Revoked ${subject}`);
    case "scope:allowed":
      return view("allowed", `Gave it ${subject}`);
    case "scope:denied":
      return view("denied", `Said no to giving it ${subject}`, "you said no");
    case "agent:revoked":
      return view("denied", "Revoked");
    default:
      return view("changed", "Changed an answer");
  }
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
