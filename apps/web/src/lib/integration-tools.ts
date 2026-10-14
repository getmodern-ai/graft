import { approvalDecision } from "@graft/core/approval/approval.decision";

import type { ConnectionAccessView, ToolboxTool } from "./connection-queries";
import { formatRelative } from "./format";
import type { IntegrationToolRow } from "./integration-queries";
import { type PendingAction, readAsk } from "./pending-action-queries";
import { versionOrigin } from "./tool-versions";

/**
 * The integration page's Tools tab (GRA-317; Figma 2044:7001), as pure functions over the
 * integration's tools read (GRA-293), the toolbox read's lineage (GRA-242), the open asks and the
 * connections' access reads (GRA-296). The tab draws what these answer.
 */

/** The person's tools first, as the read orders them; the stock tools not yet copied in behind "Show more". */
export function splitIntegrationTools(tools: readonly IntegrationToolRow[]): {
  toolbox: IntegrationToolRow[];
  stock: IntegrationToolRow[];
} {
  return {
    toolbox: tools.filter((tool) => tool.source === "toolbox"),
    stock: tools.filter((tool) => tool.source === "stock"),
  };
}

/**
 * When each tool was last asked about and not yet answered: the newest open `tool` ask per tool
 * id, across every agent. A tool ask names the tool's row, so a stock tool not yet copied in has
 * none.
 */
export function openToolAsksByTool(
  actions: readonly PendingAction[],
  now: Date = new Date(),
): Map<string, string> {
  const newest = new Map<string, string>();
  for (const action of actions) {
    if (action.answeredAt !== null || new Date(action.expiresAt).getTime() <= now.getTime()) {
      continue;
    }
    const ask = readAsk(action);
    if (ask.kind !== "tool") continue;
    const seen = newest.get(ask.payload.toolId);
    if (!seen || seen < action.createdAt) newest.set(ask.payload.toolId, action.createdAt);
  }
  return newest;
}

/**
 * The line under a tool's description: an open ask first, since it is waiting on the person; then
 * its last run; then where it came from. `waiting` is the line drawn in the primary tone.
 */
export type ToolStatusLine = { kind: "waiting" | "ran" | "origin"; text: string };

export function toolStatusLine(
  tool: Pick<IntegrationToolRow, "source" | "toolId" | "lastRun">,
  context: {
    openAsks: ReadonlyMap<string, string>;
    toolbox: readonly Pick<ToolboxTool, "id" | "versions">[];
    now?: Date;
  },
): ToolStatusLine {
  const now = context.now ?? new Date();
  const askedAt = tool.toolId ? context.openAsks.get(tool.toolId) : undefined;
  if (askedAt)
    return { kind: "waiting", text: `Waiting for you · ${formatRelative(askedAt, now)}` };
  if (tool.lastRun) {
    const when = formatRelative(tool.lastRun.at, now);
    const agent = tool.lastRun.agent.name;
    return {
      kind: "ran",
      text:
        tool.lastRun.outcome === "ok" ? `Ran ${when} by ${agent}` : `Failed ${when} for ${agent}`,
    };
  }
  if (tool.source === "stock") return { kind: "origin", text: "Ready-made" };
  const current = context.toolbox
    .find((row) => row.id === tool.toolId)
    ?.versions.find((version) => version.current);
  return { kind: "origin", text: current ? versionOrigin(current) : "Written by your agent" };
}

export type ToolAccessAgent = ConnectionAccessView["agents"][number];

/**
 * The agents that can use the integration, from every live connection's access read: an agent is
 * in when any connection of the vendor is in its scope. Its answers for the vendor's tools and its
 * standing approval are the vendor's, the same on every connection's read, so the first read's
 * copy is kept.
 */
export function agentsWithAccess(views: readonly ConnectionAccessView[]): ToolAccessAgent[] {
  const byId = new Map<string, ToolAccessAgent>();
  for (const view of views) {
    for (const row of view.agents) {
      if (!row.inScope) continue;
      if (!byId.has(row.agent.id)) byId.set(row.agent.id, row);
    }
  }
  return [...byId.values()];
}

/** "Codex", "Codex and Claude", "Codex and 2 more". */
function listNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} more`;
}

/**
 * The Approval column's read-only summary for one tool across the agents that can use the
 * integration (ADR 0008 as amended 2026-10-14: the column summarises, editing is per agent on the
 * Agents tab). Each agent is judged by the gate's own rule, `approvalDecision`, over its answer for
 * the tool and its standing approval for the integration; a tool's own `allow` that asks every
 * call is told apart from one that asks first, the first time a version runs. `agentsTab` is false for a read, which offers no
 * ask option and so links nowhere.
 */
export type ToolApprovalSummary = { summary: string; detail: string | null; agentsTab: boolean };

export function toolApprovalSummary(
  tool: Pick<IntegrationToolRow, "toolId" | "annotations">,
  agents: readonly ToolAccessAgent[],
): ToolApprovalSummary {
  if (tool.annotations.readOnly) {
    return { summary: "Runs without asking", detail: null, agentsTab: false };
  }
  if (agents.length === 0) {
    return { summary: "No agent can use it", detail: null, agentsTab: true };
  }
  const allowed: string[] = [];
  const everyTime: string[] = [];
  const denied: string[] = [];
  const first: string[] = [];
  for (const row of agents) {
    const own = tool.toolId
      ? (row.toolApprovals.find((approval) => approval.tool.id === tool.toolId) ?? null)
      : null;
    const verdict = approvalDecision({
      annotations: tool.annotations,
      approval: own
        ? {
            decision: own.decision,
            askEveryCall: own.askEveryCall,
            forThisVersion: own.forCurrentVersion,
          }
        : null,
      vendorApproval: row.vendorApproval,
    });
    if (verdict === "pass") allowed.push(row.agent.name);
    else if (verdict === "deny") denied.push(row.agent.name);
    else if (own?.decision === "allow" && own.askEveryCall) everyTime.push(row.agent.name);
    else first.push(row.agent.name);
  }
  const lines: string[] = [];
  if (allowed.length > 0) {
    lines.push(
      allowed.length < agents.length
        ? `Allowed for ${allowed.length} of ${agents.length} agents`
        : agents.length === 1
          ? `Allowed for ${allowed[0]}`
          : `Allowed for all ${agents.length} agents`,
    );
  }
  if (everyTime.length > 0) lines.push(`Asks every time for ${listNames(everyTime)}`);
  if (denied.length > 0) lines.push(`Denied for ${listNames(denied)}`);
  // With nothing else to say, every agent asks first and the summary says so on its own.
  if (first.length > 0 && lines.length > 0) lines.push(`Asks first for ${listNames(first)}`);
  const [summary = "Asks first", ...rest] = lines;
  return { summary, detail: rest.length > 0 ? rest.join(" · ") : null, agentsTab: true };
}
