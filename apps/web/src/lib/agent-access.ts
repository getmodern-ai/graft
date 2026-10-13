import type { ConnectionAccessView } from "./connection-queries";

/**
 * What an agent can run without asking, in the person's words: the line and the line under it in
 * the integration page's Agents view (GRA-296), from one agent's row of
 * `GET /api/connections/:id/access`. The rule it words is ADR 0008 as amended: reads never ask; a
 * tool's own answer holds for the version it was given for, unless that tool asks every call; the
 * standing approval for the integration covers every tool without an answer of its own, ones that
 * delete only when ticked. Each approval carries its tool's annotations, so nothing else is read.
 */

export type AgentAccess = ConnectionAccessView["agents"][number];

export type AgentAccessSummary = {
  /** "Every Gmail tool, except ones that delete", "Reads, plus Draft reply", "Reads only", "No access". */
  summary: string;
  /** The line under it, or null when there is nothing more to say. */
  detail: string | null;
};

/** A tool's kebab-case name as words: `draft-reply` reads "Draft reply". */
export function toolTitle(name: string): string {
  const words = name.split("-").filter((word) => word.length > 0);
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "A", "A and B", "A and 3 more". */
function listTools(titles: readonly string[]): string {
  if (titles.length <= 2) return titles.join(" and ");
  return `${titles[0]} and ${titles.length - 1} more`;
}

export function agentAccessSummary(
  access: AgentAccess,
  integrationName: string,
): AgentAccessSummary {
  if (!access.inScope) {
    return {
      summary: "No access",
      detail: `Turn on to let ${access.agent.name} use ${integrationName}`,
    };
  }
  // A read never asks, so its answer changes nothing this line says.
  const answers = access.toolApprovals.filter((approval) => !approval.tool.readOnly);
  const asksEveryCall = answers
    .filter((approval) => approval.askEveryCall)
    .map((approval) => toolTitle(approval.tool.name));
  const allowed = answers
    .filter(
      (approval) =>
        approval.decision === "allow" && approval.forCurrentVersion && !approval.askEveryCall,
    )
    .map((approval) => toolTitle(approval.tool.name));

  const standing = access.vendorApproval;
  const summary = standing
    ? standing.includesDestructive
      ? `Every ${integrationName} tool`
      : `Every ${integrationName} tool, except ones that delete`
    : allowed.length > 0
      ? `Reads, plus ${listTools(allowed)}`
      : "Reads only";

  if (asksEveryCall.length > 0) {
    const verb = asksEveryCall.length === 1 ? "asks" : "ask";
    return { summary, detail: `${listTools(asksEveryCall)} ${verb} every time` };
  }
  if (access.buildApproval) {
    return { summary, detail: `Can also build its own ${integrationName} tools` };
  }
  if (standing) {
    return { summary, detail: standing.includesDestructive ? null : "Ones that delete ask first" };
  }
  return {
    summary,
    detail:
      allowed.length > 0
        ? "Anything else that changes data asks first"
        : "Anything that changes data asks first",
  };
}
