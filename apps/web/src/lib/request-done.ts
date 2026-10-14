import type { DonePendingActionCard } from "@graft/server/api";

import type { Jsonified } from "./api";
import { formatRelative } from "./format";
import type { Ask, PendingAction } from "./pending-action-queries";
import { readAsk } from "./pending-action-queries";
import { requestAgentName, requestRowCopy, toolActionWords } from "./request-row";
import { toolAskIntegrationName } from "./tool-ask-copy";

/**
 * One finished request as a row of Requests > Done (GRA-312; the Figma frame "03b Requests > Done"):
 * one sentence saying what happened, a sub-line, and Change where an answer stands now that a
 * console route can change (ADR 0008 as amended 2026-10-14). The row reads the ask the agent made
 * (`readAsk`) and how it finished (GRA-292's `state`, `closedReason`, `answer`); Change never
 * replays that answer, it opens what stands (`changeTargets`, then `standingTool` and its kin).
 */

export type DoneRequest = Jsonified<DonePendingActionCard>;

/** What Change opens: the tool's answer and its integration's, or a connection's build approval. */
export type ChangeTargets = {
  /** A tool that asks: its answer can be set outright (`PUT /agents/:id/approvals/:toolId`). */
  tool: { toolId: string; label: string; destructive: boolean } | null;
  /** The integration whose standing approval, if one stands, can be widened, narrowed or withdrawn. */
  vendor: { slug: string; integrationName: string } | null;
  /** The connection whose build approval, if one stands, can be withdrawn. */
  buildConnectionId: string | null;
};

export type DoneRowCopy = {
  vendor: string | null;
  integrationName: string | null;
  title: string;
  detail: string | null;
  /** Null where nothing has a route: a read tool, a revoked agent, an ask that ended unanswered. */
  change: ChangeTargets | null;
};

/** The ask as `readAsk` narrows it; a finished card has no link, which the narrowing never reads. */
export function readDoneAsk(card: DoneRequest): Ask {
  return readAsk({ ...card, url: "" } satisfies PendingAction);
}

function possessive(name: string): string {
  return `${name}'s`;
}

/** What the agent asked for, as the tail of "Codex's request to …". */
function askedFor(ask: Ask, integrationName: string | null): string {
  switch (ask.kind) {
    case "tool": {
      const words = toolActionWords(ask.payload.toolName);
      const integration = toolAskIntegrationName(ask.payload);
      return words ? `${words} in ${integration}` : `use a ${integration} tool`;
    }
    case "build":
      return `build its own ${integrationName} tools`;
    case "connection":
      return ask.payload.widens
        ? `reach more of ${ask.payload.displayName}`
        : `connect ${ask.payload.displayName}`;
    case "connection-link":
      return `connect ${ask.payload.displayName}`;
    case "credential":
      return `reconnect ${ask.payload.connectionName}`;
    case "scope":
      return `use ${ask.payload.displayName}`;
    default:
      return "get an answer";
  }
}

function answeredWith(card: DoneRequest): { allow: boolean; connected: boolean } {
  const answer = card.answer ?? {};
  return {
    allow: answer.allow === true,
    connected: typeof answer.connectionId === "string" && answer.connectionId !== "",
  };
}

/**
 * The row's words for a finished ask. `agentActive` is whether the asking agent still stands: a
 * revoked agent's answers have nothing left to change (ADR 0007).
 */
export function doneRowCopy(card: DoneRequest, agentActive: boolean): DoneRowCopy {
  const ask = readDoneAsk(card);
  const open = requestRowCopy(ask);
  const agent = requestAgentName(card);
  const base = { vendor: open.vendor, integrationName: open.integrationName };
  const what = askedFor(ask, open.integrationName);

  if (card.state === "closed") {
    const revoked =
      card.closedReason === "agent_revoked" ? agent : (open.integrationName ?? "the integration");
    return {
      ...base,
      title: `${possessive(agent)} request to ${what}`,
      detail: `Closed when you revoked ${revoked}`,
      change: null,
    };
  }
  if (card.state === "expired") {
    return {
      ...base,
      title: `${possessive(agent)} request to ${what} expired`,
      detail: card.agent ? `${agent} will ask again if it still needs it` : null,
      change: null,
    };
  }

  const said = answeredWith(card);
  const answer = card.answer ?? {};
  switch (ask.kind) {
    case "tool": {
      const { payload } = ask;
      const integration = toolAskIntegrationName(payload);
      const words = toolActionWords(payload.toolName) ?? `use a ${integration} tool`;
      const change: ChangeTargets | null =
        agentActive && !payload.annotations.readOnlyHint
          ? {
              tool: {
                toolId: payload.toolId,
                label: sentenceCase(words),
                destructive: payload.annotations.destructiveHint === true,
              },
              vendor: { slug: payload.vendor, integrationName: integration },
              buildConnectionId: null,
            }
          : null;
      if (!said.allow) {
        return {
          ...base,
          title: `${agent} can't ${words} in ${integration}`,
          detail: "You denied it",
          change,
        };
      }
      if (answer.allowVendor === true) {
        return {
          ...base,
          title: `${agent} can use every ${integration} tool`,
          detail:
            answer.includesDestructive === true
              ? "Including ones that delete"
              : "Except ones that delete",
          change,
        };
      }
      if (answer.askEveryCall === true) {
        return {
          ...base,
          title: `${agent} can ${words} in ${integration} when you say yes`,
          detail: "Asks you every time",
          change,
        };
      }
      return {
        ...base,
        title: `${agent} can always ${words} in ${integration}`,
        detail: null,
        change,
      };
    }
    case "build": {
      const integration = open.integrationName ?? "these";
      return said.allow
        ? {
            ...base,
            title: `${agent} can build its own ${integration} tools`,
            detail: null,
            change: agentActive ? buildTargets(ask.payload.connectionId) : null,
          }
        : {
            ...base,
            title: `${agent} can't build its own ${integration} tools`,
            detail: "You declined it",
            change: null,
          };
    }
    case "scope": {
      const name = ask.payload.displayName;
      if (!said.allow) {
        return {
          ...base,
          title: `${agent} can't use ${name}`,
          detail: "You declined it",
          change: null,
        };
      }
      const build = answer.approveBuild === true;
      return {
        ...base,
        title: `${agent} can use ${name}`,
        detail: build ? "And build its own tools for it" : null,
        change: agentActive && build ? buildTargets(ask.payload.connectionId) : null,
      };
    }
    case "connection":
    case "connection-link":
    case "credential": {
      const name = ask.kind === "credential" ? ask.payload.connectionName : ask.payload.displayName;
      if (!said.connected) {
        return {
          ...base,
          title: `You declined ${possessive(agent)} request to ${what}`,
          detail: null,
          change: null,
        };
      }
      const title =
        ask.kind === "credential"
          ? `Reconnected ${name}`
          : ask.kind === "connection" && ask.payload.widens
            ? `${agent} can reach more of ${name}`
            : `Connected ${name}`;
      // What the connection's confirmation granted beside it (GRA-75, GRA-239), when it said so.
      const build = answer.approveBuild === true;
      const vendorTools = answer.allowVendor === true;
      const connectionId = card.subject.connectionId;
      return {
        ...base,
        title,
        detail: ask.kind === "credential" ? null : `For ${agent}`,
        change:
          agentActive && (build || vendorTools)
            ? {
                tool: null,
                vendor:
                  vendorTools && open.vendor
                    ? { slug: open.vendor, integrationName: open.integrationName ?? name }
                    : null,
                buildConnectionId: build ? connectionId : null,
              }
            : null,
      };
    }
    default:
      return {
        ...base,
        title: said.allow ? `You answered ${agent}` : `You declined ${possessive(agent)} request`,
        detail: null,
        change: null,
      };
  }
}

/** Change's dialog title: about what stands now, so it never repeats the row's past sentence. */
export function changeDialogTitle(agentName: string, integrationName: string | null): string {
  return integrationName
    ? `What ${agentName} can do in ${integrationName}`
    : `What ${agentName} can do`;
}

function buildTargets(connectionId: string): ChangeTargets {
  return { tool: null, vendor: null, buildConnectionId: connectionId };
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The sub-line's time: when the ask finished. `leading` when nothing precedes it on the line, so
 * "Yesterday" opens it as a sentence does.
 */
export function doneRowWhen(
  card: Pick<DoneRequest, "finishedAt">,
  leading: boolean,
  now: Date = new Date(),
): { iso: string; label: string } | null {
  const label = formatRelative(card.finishedAt, now);
  if (!label) return null;
  return { iso: card.finishedAt, label: leading ? sentenceCase(label) : label };
}

/** The tool's answer as it stands now, from `GET /approvals`; null where none stands, so it asks. */
export type StandingTool = { decision: "allow" | "deny"; askEveryCall: boolean } | null;

export function standingTool(
  approvals: readonly { toolId: string; decision: "allow" | "deny"; askEveryCall: boolean }[],
  toolId: string,
): StandingTool {
  const row = approvals.find((approval) => approval.toolId === toolId);
  return row ? { decision: row.decision, askEveryCall: row.askEveryCall } : null;
}

/** The integration's standing approval, from `GET /vendor-approvals`; null where none stands. */
export function standingVendor(
  vendorApprovals: readonly { vendor: string; includesDestructive: boolean }[],
  vendor: string,
): { includesDestructive: boolean } | null {
  const row = vendorApprovals.find((approval) => approval.vendor === vendor);
  return row ? { includesDestructive: row.includesDestructive } : null;
}

/** Whether a build approval stands for the connection, from `GET /agents/:id/build-approvals`. */
export function standingBuild(
  buildApprovals: readonly { connectionId: string }[],
  connectionId: string,
): boolean {
  return buildApprovals.some((approval) => approval.connectionId === connectionId);
}

/**
 * How the tool runs now, in a sentence: its own answer wins over the integration's (ADR 0008 as
 * amended 2026-10-09: a tool's `deny` and `askEveryCall` win), and a destructive tool passes on
 * the integration's only where that approval includes destructive ones.
 */
export function standingToolSentence(
  tool: StandingTool,
  vendor: { includesDestructive: boolean } | null,
  destructive: boolean,
): string {
  if (tool?.decision === "deny") return "Denied. Every call is refused.";
  if (tool?.askEveryCall) return "Asks you before every call.";
  if (tool?.decision === "allow") return "Allowed. It runs without asking.";
  if (vendor && (!destructive || vendor.includesDestructive)) {
    return "Runs without asking, under the integration's approval.";
  }
  return "No answer stands. It asks the next time it runs.";
}
