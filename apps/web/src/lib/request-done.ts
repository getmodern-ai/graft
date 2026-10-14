import { approvalDecision } from "@graft/core/approval/approval.decision";
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
 * replays that answer, it opens what stands (`ChangeTargets`, then `standingTool`,
 * `toolChangeView` and their kin, read fresh).
 */

export type DoneRequest = Jsonified<DonePendingActionCard>;

/** What Change opens: the tool's answer and its integration's, or a connection's build approval. */
export type ChangeTargets = {
  /**
   * A tool that asked: its answer can be set outright (`PUT /agents/:id/approvals/:toolId`). Its
   * annotations and version are read from the toolbox when Change opens, never from the ask.
   */
  tool: { toolId: string; label: string } | null;
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
              tool: { toolId: payload.toolId, label: sentenceCase(words) },
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
      // "Always" only where the answer turned ask-every-call off. An answer without the field (a
      // Hermes button) left the tool's setting as it stood, which the row cannot see; Change reads it.
      return {
        ...base,
        title:
          answer.askEveryCall === false
            ? `${agent} can always ${words} in ${integration}`
            : `${agent} can ${words} in ${integration}`,
        detail: answer.askEveryCall === false ? null : "You allowed it",
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
            change: agentActive
              ? buildTargets(ask.payload.connectionId, ask.payload.vendor, integration)
              : null,
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
        // An allow may grant the build approval and every non-destructive tool beside it (Full
        // access), each a row of its own: Change opens both, and the dialog shows what stands.
        change: agentActive
          ? {
              tool: null,
              vendor: { slug: ask.payload.vendor, integrationName: name },
              buildConnectionId: ask.payload.connectionId,
            }
          : null,
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
      // A connection's confirmation may grant the build approval and every non-destructive tool
      // beside it (GRA-75, GRA-239), but the answer records only `{ connectionId }`: the grants
      // are rows of their own. So Change opens both for any connection made, and the dialog shows
      // whichever stands now. A credential re-entry grants nothing.
      const connectionId = card.subject.connectionId;
      return {
        ...base,
        title,
        detail: ask.kind === "credential" ? null : `For ${agent}`,
        change:
          agentActive && ask.kind !== "credential" && connectionId
            ? {
                tool: null,
                vendor: open.vendor
                  ? { slug: open.vendor, integrationName: open.integrationName ?? name }
                  : null,
                buildConnectionId: connectionId,
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

/**
 * The toast after Change sets a tool's answer. The route keeps the ask-every-call setting as it
 * stood (`setApprovalFromConsole`), so an allow says it runs without asking only where the
 * answer the route returns has that setting off.
 */
export function decisionToast(
  decision: "allow" | "deny",
  askEveryCall: boolean,
  agentName: string,
): { title: string; description: string } {
  if (decision === "deny") {
    return { title: "Denied", description: `${agentName}'s calls to it are refused.` };
  }
  return {
    title: "Allowed",
    description: askEveryCall
      ? "It still asks you before every call, as you set it to."
      : `${agentName} runs it without asking.`,
  };
}

/** Change's dialog title: about what stands now, so it never repeats the row's past sentence. */
export function changeDialogTitle(agentName: string, integrationName: string | null): string {
  return integrationName
    ? `What ${agentName} can do in ${integrationName}`
    : `What ${agentName} can do`;
}

/**
 * A build allow's targets: the build approval, and the integration's approval beside it, since
 * that one decides whether the tools it builds ask (ADR 0008 as amended 2026-10-09: every tool of
 * the integration, future ones included).
 */
function buildTargets(
  connectionId: string,
  vendor: string,
  integrationName: string,
): ChangeTargets {
  return { tool: null, vendor: { slug: vendor, integrationName }, buildConnectionId: connectionId };
}

/**
 * The build approval's line in Change: whether what the agent builds asks before changing data,
 * which an integration's approval standing beside it decides, since that covers future tools too.
 */
export function buildApprovalSentence(
  integrationName: string | null,
  vendor: { includesDestructive: boolean } | null,
): string {
  if (!vendor || !integrationName) return "Anything it builds still asks before changing data";
  return vendor.includesDestructive
    ? `Tools it builds run without asking, because every ${integrationName} tool is allowed`
    : `Tools it builds that change data run without asking, because every ${integrationName} tool is allowed. Ones that delete still ask`;
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

/**
 * The tool's answer as it stands now, from `GET /approvals`: null where none stands.
 * `forThisVersion` is whether it was given for the version the tool runs now
 * (`approval.tool_version_id` against the toolbox's `currentVersionId`; GRA-245), since an allow
 * for another version asks again.
 */
export type StandingTool = {
  decision: "allow" | "deny";
  askEveryCall: boolean;
  forThisVersion: boolean;
} | null;

export function standingTool(
  approvals: readonly {
    toolId: string;
    decision: "allow" | "deny";
    askEveryCall: boolean;
    toolVersionId: string | null;
  }[],
  toolId: string,
  currentVersionId: string | null,
): StandingTool {
  const row = approvals.find((approval) => approval.toolId === toolId);
  if (!row) return null;
  return {
    decision: row.decision,
    askEveryCall: row.askEveryCall,
    forThisVersion: row.toolVersionId !== null && row.toolVersionId === currentVersionId,
  };
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

/** The tool as the toolbox holds it now, from `GET /tools`; null where it is gone. */
export type CurrentTool = {
  currentVersionId: string | null;
  readOnly: boolean;
  destructive: boolean;
} | null;

/** What Change's tool line says and offers, judged on the tool as it runs now. */
export type ToolChangeView = {
  sentence: string;
  allow: boolean;
  deny: boolean;
  withdraw: boolean;
  /** The ask-every-call switch's state, or null where it has nothing to change. */
  askEveryCall: boolean | null;
  /** The current version's, for the line's "Can delete" chip; never the historic ask's. */
  destructive: boolean;
};

/**
 * How the tool runs now and what can change it, by ADR 0008's gate (`approvalDecision`, as amended
 * 2026-10-09: the tool's own `deny` and `askEveryCall` win over the integration's yes, an allow
 * passes only for the version it was given for, and a destructive tool passes the integration's
 * only where that includes destructive ones), on the current version's annotations. A tool gone
 * from the toolbox, or now read-only, offers nothing to set; one with no version offers only
 * Withdraw, since `PUT /agents/:id/approvals/:toolId` refuses it.
 */
export function toolChangeView(
  current: CurrentTool,
  tool: StandingTool,
  vendor: { includesDestructive: boolean } | null,
): ToolChangeView {
  const nothing = { allow: false, deny: false, askEveryCall: null, withdraw: tool !== null };
  if (!current) {
    return {
      ...nothing,
      destructive: false,
      sentence: "This tool is no longer in your toolbox.",
    };
  }
  if (current.readOnly) {
    return { ...nothing, destructive: false, sentence: "It only reads now, so it never asks." };
  }
  const verdict = approvalDecision({
    annotations: { readOnly: false, destructive: current.destructive },
    approval: tool,
    vendorApproval: vendor,
  });
  const settable = current.currentVersionId !== null;
  const view = {
    allow: settable && !(tool?.decision === "allow" && tool.forThisVersion),
    deny: settable && tool?.decision !== "deny",
    withdraw: tool !== null,
    askEveryCall: tool?.decision === "allow" ? tool.askEveryCall : null,
    destructive: current.destructive,
  };
  if (verdict === "deny") return { ...view, sentence: "Denied. Every call is refused." };
  if (tool?.askEveryCall) return { ...view, sentence: "Asks you before every call." };
  if (verdict === "pass") {
    return {
      ...view,
      sentence: tool?.forThisVersion
        ? "Allowed. It runs without asking."
        : "Runs without asking, under the integration's approval.",
    };
  }
  if (tool?.decision === "allow") {
    return {
      ...view,
      sentence: "Allowed for an earlier version. It asks once before running this one.",
    };
  }
  return { ...view, sentence: "No answer stands. It asks the next time it runs." };
}
