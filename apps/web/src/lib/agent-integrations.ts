import { approvalDecision } from "@graft/core/approval/approval.decision";

import { listTools, toolTitle } from "./agent-access";
import type { Approval, VendorApproval } from "./approval-queries";
import { type Connection, type ConnectionStatus, connectionStatus } from "./connection-queries";
import { count } from "./format";
import type { Integration } from "./integration-queries";
import { connectionOn, type ScopeState } from "./scope-toggles";

/**
 * The agent page's *Integrations X can use* panel (GRA-326; Figma 2047:7614), as pure decisions
 * over reads the page already holds: the person's connections, the agent's scope, the toolbox and
 * the agent's answers. One row per integration, one switch per connection under it (GRA-294's
 * switches are per connection, so an integration with two connections never turns both with one
 * write), and the line under the name that says what the agent may run without asking.
 *
 * The line is ADR 0008's rule applied tool by tool through `@graft/core`'s `approvalDecision`, the
 * gate's own function, so the console cannot word an answer the gate would judge otherwise.
 */

type Tool = {
  id: string;
  vendor: string;
  name: string;
  readOnly: boolean;
  destructive: boolean;
  currentVersionId: string | null;
};

type ToolCounts = Pick<Integration, "vendor" | "toolCount">;
type ApprovalAnswer = Pick<Approval, "toolId" | "decision" | "askEveryCall" | "toolVersionId">;
type VendorAnswer = Pick<VendorApproval, "vendor" | "includesDestructive">;

export type AgentIntegrationConnection = {
  connection: Connection;
  status: ConnectionStatus;
  /** The connection's switch: in the agent's scope (`scope-toggles.ts`'s `connectionOn`). */
  on: boolean;
};

export type AgentIntegrationRow = {
  vendor: string;
  displayName: string;
  connections: AgentIntegrationConnection[];
  /**
   * Every tool the integration offers the person, ready-made ones not yet used included (GRA-345);
   * null until the toolbox, the answers and the integrations are read.
   */
  toolCount: number | null;
  /** Some connection on the row needs the person before its tools run again. */
  needsReconnect: boolean;
  /** "6 tools · reads run without asking, Send asks every time". */
  line: string;
};

/** "Send asks", "Send and Archive ask": the verb agrees with how many tools the list names. */
const named = (titles: readonly string[], one: string, many: string) =>
  `${listTools(titles)} ${titles.length === 1 ? one : many}`;

/**
 * What the agent may run of one integration's tools without asking, in the person's words. Reads
 * never ask; each tool that changes data is judged as the gate would judge its current version.
 *
 * `unusedTools` counts the ready-made tools not yet in the toolbox (GRA-345). No answer can name
 * one before its first use copies it in, so the clause never says every tool runs without asking
 * while one of them may ask: any change with no standing approval, one that deletes under an
 * approval that leaves those out. Their annotations are not read here, so the clause says what
 * such a tool would do rather than naming it.
 */
export function integrationAccessClause(
  tools: readonly Tool[],
  approvals: readonly ApprovalAnswer[],
  vendorApproval: VendorAnswer | null,
  unusedTools = 0,
): string {
  const byTool = new Map(approvals.map((approval) => [approval.toolId, approval]));
  const passes: string[] = [];
  const everyCall: string[] = [];
  const asksFirst: string[] = [];
  const refused: string[] = [];
  for (const tool of tools) {
    if (tool.readOnly || tool.currentVersionId === null) continue;
    const own = byTool.get(tool.id) ?? null;
    const verdict = approvalDecision({
      annotations: tool,
      approval: own && {
        decision: own.decision,
        askEveryCall: own.askEveryCall,
        forThisVersion: own.toolVersionId !== null && own.toolVersionId === tool.currentVersionId,
      },
      vendorApproval,
    });
    const title = toolTitle(tool.name);
    if (verdict === "pass") passes.push(title);
    else if (verdict === "deny") refused.push(title);
    else if (own?.decision === "allow" && own.askEveryCall) everyCall.push(title);
    else asksFirst.push(title);
  }

  const exceptions: string[] = [];
  if (everyCall.length > 0) {
    exceptions.push(`${named(everyCall, "asks", "ask")} every time`);
  }
  if (refused.length > 0) {
    exceptions.push(`${named(refused, "is", "are")} refused`);
  }

  // An unused ready-made tool is judged with no answer of its own: the standing approval covers it
  // unless it deletes and the approval leaves those out; with no standing approval, a change asks.
  const unusedAsk = unusedTools > 0 && !vendorApproval?.includesDestructive;
  if (vendorApproval && (passes.length > 0 || unusedTools > 0)) {
    // The standing approval covers the rest, so the exceptions are named and the rest summed up.
    if (asksFirst.length > 0) {
      exceptions.push(`${named(asksFirst, "asks", "ask")} first`);
    }
    if (unusedAsk) exceptions.push("ready-made tools that delete ask first");
    if (exceptions.length === 0) return "every tool runs without asking";
    return [...exceptions, "the rest run without asking"].join(", ");
  }
  if (passes.length > 0 && exceptions.length === 0 && asksFirst.length === 0 && !unusedAsk) {
    return "every tool runs without asking";
  }
  const free = passes.length > 0 ? `reads and ${listTools(passes)}` : "reads";
  const clauses = [`${free} run without asking`, ...exceptions];
  if (asksFirst.length > 0 || unusedAsk) {
    clauses.push(passes.length > 0 ? "other changes ask first" : "changes ask first");
  }
  return clauses.join(", ");
}

/**
 * The line under a row's name. `access` is null while the toolbox and the answers are not read (or
 * their read failed): the line then says only what the scope and the connections say, which the
 * page already holds, so the switches never wait on it.
 */
export function integrationAccessLine(input: {
  agentName: string;
  on: boolean;
  /** Every connection the agent reaches on the row needs the person. */
  blocked: boolean;
  access: { toolCount: number; clause: string } | null;
}): string {
  const { access } = input;
  if (access === null) {
    if (!input.on) return `Not available to ${input.agentName}`;
    if (input.blocked) return "Can't run until you reconnect";
    return `Available to ${input.agentName}`;
  }
  const tools = access.toolCount === 0 ? "No tools yet" : count(access.toolCount, "tool");
  if (!input.on) return `${tools} · not available to ${input.agentName}`;
  if (input.blocked) return `${tools} · can't run until you reconnect`;
  if (access.toolCount === 0) return `${tools} · ${input.agentName} can build them`;
  return `${tools} · ${access.clause}`;
}

/**
 * The panel's rows, by integration name. A revoked connection is left out unless the agent's list
 * still names it, where its switch is the one way to take it out (the scope editor this panel
 * replaced listed revoked rows for the same reason); under `all` it is reached by no switch, since
 * turning it off would narrow the agent for a connection nothing can use.
 */
export function agentIntegrationRows(input: {
  agentName: string;
  connections: readonly Connection[];
  scope: ScopeState;
  /**
   * The toolbox, the agent's answers and the integrations read's tool counts, or null until all
   * four are read. A vendor the integrations read has no row of (every connection revoked) counts
   * its toolbox tools.
   */
  access: {
    tools: readonly Tool[];
    approvals: readonly ApprovalAnswer[];
    vendorApprovals: readonly VendorAnswer[];
    toolCounts: readonly ToolCounts[];
  } | null;
}): AgentIntegrationRow[] {
  const byVendor = new Map<string, AgentIntegrationConnection[]>();
  const oldestFirst = [...input.connections].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const connection of oldestFirst) {
    const on = connectionOn(input.scope, connection.id);
    if (connection.revokedAt !== null && !(input.scope.mode === "listed" && on)) continue;
    const list = byVendor.get(connection.vendor) ?? [];
    list.push({ connection, status: connectionStatus(connection), on });
    byVendor.set(connection.vendor, list);
  }

  const rows: AgentIntegrationRow[] = [];
  for (const [vendor, connections] of byVendor) {
    const { access } = input;
    const tools = (access?.tools ?? []).filter(
      (tool) => tool.vendor === vendor && tool.currentVersionId !== null,
    );
    const reached = connections.filter((entry) => entry.on);
    const vendorApproval = access?.vendorApprovals.find((row) => row.vendor === vendor) ?? null;
    const offered =
      access?.toolCounts.find((row) => row.vendor === vendor)?.toolCount ?? tools.length;
    const [oldest] = connections;
    rows.push({
      vendor,
      displayName: oldest?.connection.displayName ?? vendor,
      connections,
      toolCount: access ? offered : null,
      needsReconnect: connections.some((entry) => entry.status !== "connected"),
      line: integrationAccessLine({
        agentName: input.agentName,
        on: reached.length > 0,
        blocked: reached.length > 0 && reached.every((entry) => entry.status !== "connected"),
        access: access && {
          toolCount: offered,
          clause: integrationAccessClause(
            tools,
            access.approvals,
            vendorApproval,
            Math.max(0, offered - tools.length),
          ),
        },
      }),
    });
  }
  return rows.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
      a.vendor.localeCompare(b.vendor),
  );
}

/** The bottom switch's words (GRA-287 item 4: the default stays `all`, and off is not recommended). */
export function laterSwitchCopy(agentName: string): { title: string; description: string } {
  return {
    title: `Give ${agentName} integrations I connect later`,
    description: `On: ${agentName} can use each new integration as soon as you connect it. Off: you turn each one on here.`,
  };
}
