import type { AgentAccess } from "./agent-access";
import { toolTitle } from "./agent-access";
import type { ConnectionAccessView } from "./connection-queries";
import { ANSWER_CHIP, type StatusChip } from "./status-chips";

/**
 * The integration page's Agents tab (GRA-318), as pure decisions over GRA-296's access read. The
 * read is per connection, and a page lists every live connection of its vendor (GRA-287 item 1),
 * so the tab reads each and folds them here: an agent's answers for the vendor's tools and its
 * standing approval for the vendor are the vendor's and come back alike from every connection,
 * while whether the scope reaches a connection and the build approval are the connection's own
 * (ADR 0007, ADR 0008). So the Access column holds one switch per connection.
 */

/** A live connection of the page's vendor, as the tab names it. */
export type TabConnection = { id: string; displayName: string };

export type AgentConnectionSwitch = {
  connectionId: string;
  displayName: string;
  inScope: boolean;
};

export type IntegrationAgentRow = {
  agent: AgentAccess["agent"];
  lastUsedAt: string | null;
  /**
   * One row standing for the agent across the vendor's connections, for `agentAccessSummary`: in
   * scope when any connection is, and the build approval of the first connection that has one.
   */
  access: AgentAccess;
  /** One per live connection, in the page's order. */
  switches: AgentConnectionSwitch[];
  /** The build approvals the agent holds, one per connection. */
  buildApprovals: { connectionId: string; displayName: string; grantedAt: string }[];
};

/**
 * The agents, oldest first as the read answers them, one row each however many connections the
 * vendor has. A connection whose read has not answered is left out of the row's switches. The
 * read lists active agents only, so a revoked agent is never a row.
 */
export function integrationAgentRows(
  connections: readonly TabConnection[],
  accesses: readonly ConnectionAccessView[],
): IntegrationAgentRow[] {
  const byConnection = new Map(accesses.map((access) => [access.connectionId, access]));
  const rows = new Map<string, IntegrationAgentRow>();
  for (const connection of connections) {
    const access = byConnection.get(connection.id);
    if (!access) continue;
    for (const entry of access.agents) {
      let row = rows.get(entry.agent.id);
      if (!row) {
        row = {
          agent: entry.agent,
          lastUsedAt: entry.lastUsedAt,
          access: { ...entry, inScope: false, buildApproval: null },
          switches: [],
          buildApprovals: [],
        };
        rows.set(entry.agent.id, row);
      }
      row.switches.push({
        connectionId: connection.id,
        displayName: connection.displayName,
        inScope: entry.inScope,
      });
      if (entry.inScope) row.access = { ...row.access, inScope: true };
      if (entry.buildApproval) {
        row.buildApprovals.push({
          connectionId: connection.id,
          displayName: connection.displayName,
          grantedAt: entry.buildApproval.grantedAt,
        });
        // The summary words what the agent can do, so a build approval for a connection outside
        // its scope is listed among the answers but never said to let it build.
        if (entry.inScope && !row.access.buildApproval) {
          row.access = { ...row.access, buildApproval: entry.buildApproval };
        }
      }
    }
  }
  return [...rows.values()];
}

export type ToolApproval = AgentAccess["toolApprovals"][number];

/**
 * Where a tool's answer stands, as the Change menu checks it: `always` runs without asking, `ask`
 * asks on every call, `deny` refuses, and `stale` is an allow given for an earlier version, which
 * asks once more on its next call (GRA-245). A `deny` refuses before ask-every-call is read
 * (`approvalDecision`), so a deny that also asks every call is a deny.
 */
export type ToolAnswerChoice = "always" | "ask" | "deny" | "stale";

export function toolAnswerChoice(approval: ToolApproval): ToolAnswerChoice {
  if (approval.decision === "deny") return "deny";
  if (approval.askEveryCall) return "ask";
  return approval.forCurrentVersion ? "always" : "stale";
}

/** One request the Change menu makes for a tool's answer, in order. */
export type ToolAnswerWrite =
  /** `PUT /api/agents/:id/approvals/:toolId` (GRA-302), for the version the tool runs now. */
  | { kind: "decision"; decision: "allow" | "deny" }
  /** `PUT /api/approvals/:toolId/ask-every-call`, which needs an answer to stand first. */
  | { kind: "ask_every_call"; on: boolean };

/**
 * The writes that take a tool's answer to `target`. Setting an answer outright keeps the
 * ask-every-call setting as it stood (`setApprovalFromConsole`), so *Always allow* turns it off
 * after allowing and *Ask every time* turns it on, then allows. Nothing when the answer is
 * already there.
 */
export function toolAnswerWrites(
  approval: ToolApproval,
  target: Exclude<ToolAnswerChoice, "stale">,
): ToolAnswerWrite[] {
  const current = toolAnswerChoice(approval);
  if (current === target) return [];
  if (target === "deny") return [{ kind: "decision", decision: "deny" }];
  const allowed = approval.decision === "allow" && approval.forCurrentVersion;
  const allow: ToolAnswerWrite[] = allowed ? [] : [{ kind: "decision", decision: "allow" }];
  const on = target === "ask";
  const setting: ToolAnswerWrite[] =
    approval.askEveryCall === on ? [] : [{ kind: "ask_every_call", on }];
  // Ordered so that no moment between the two requests, nor a failure of the second, leaves the
  // tool running without asking when the person chose that it ask: asking is turned on before the
  // allow lands, and turned off only after it. Every answer listed here is a row, so the setting
  // can be written on a deny as well (`setAskEveryCall`).
  return on ? [...setting, ...allow] : [...allow, ...setting];
}

/** One row of *Your answers for <integration>*. */
export type IntegrationAnswer = {
  key: string;
  agent: { id: string; name: string };
  /** "Send email", "Every Gmail tool", "Build its own Gmail tools". */
  what: string;
  /** The line under it, or null. */
  detail: string | null;
  chip: StatusChip;
  at: string;
  change:
    | {
        kind: "tool";
        approval: ToolApproval;
        /**
         * The agent's standing approval for every tool of the integration covers this one, so
         * forgetting its own answer lets it run without asking rather than ask again.
         */
        forgetRunsUnasked: boolean;
      }
    | { kind: "vendor"; includesDestructive: boolean }
    | { kind: "build"; connectionId: string }
    /** A read tool's answer: reads never ask (ADR 0008), so nothing to change. */
    | { kind: "none" };
};

const TOOL_ANSWER_CHIP: Record<ToolAnswerChoice, StatusChip> = {
  always: ANSWER_CHIP.always,
  ask: ANSWER_CHIP.ask_every_time,
  deny: ANSWER_CHIP.denied,
  stale: ANSWER_CHIP.asks_next_time,
};

/**
 * Every answer the agents hold for the integration, newest first: each tool's, each standing
 * approval for every tool, and each build approval, the last named for its connection when the
 * vendor has several.
 */
export function integrationAnswers(
  rows: readonly IntegrationAgentRow[],
  integrationName: string,
  severalConnections: boolean,
): IntegrationAnswer[] {
  const answers: IntegrationAnswer[] = [];
  for (const row of rows) {
    const agent = { id: row.agent.id, name: row.agent.name };
    const standing = row.access.vendorApproval;
    for (const approval of row.access.toolApprovals) {
      // Without its own answer a tool falls to the standing approval, ones that delete only when
      // it includes them (ADR 0008 as amended 2026-10-09).
      const forgetRunsUnasked =
        standing !== null && (standing.includesDestructive || !approval.tool.destructive);
      answers.push({
        key: `tool:${agent.id}:${approval.tool.id}`,
        agent,
        what: toolTitle(approval.tool.name),
        detail: approval.tool.readOnly ? "Reads never ask" : null,
        // A read passes whatever answer a write version of it left behind (ADR 0008).
        chip: approval.tool.readOnly
          ? ANSWER_CHIP.always
          : TOOL_ANSWER_CHIP[toolAnswerChoice(approval)],
        at: approval.decidedAt,
        change: approval.tool.readOnly
          ? { kind: "none" }
          : { kind: "tool", approval, forgetRunsUnasked },
      });
    }
    if (standing) {
      answers.push({
        key: `vendor:${agent.id}`,
        agent,
        what: `Every ${integrationName} tool`,
        detail: standing.includesDestructive
          ? "Including ones that delete"
          : "Except ones that delete",
        chip: ANSWER_CHIP.always,
        at: standing.grantedAt,
        change: { kind: "vendor", includesDestructive: standing.includesDestructive },
      });
    }
    for (const build of row.buildApprovals) {
      answers.push({
        key: `build:${agent.id}:${build.connectionId}`,
        agent,
        what: `Build its own ${integrationName} tools`,
        detail: severalConnections ? build.displayName : null,
        chip: ANSWER_CHIP.allowed,
        at: build.grantedAt,
        change: { kind: "build", connectionId: build.connectionId },
      });
    }
  }
  return answers.sort((a, b) => b.at.localeCompare(a.at));
}
