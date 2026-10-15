import { integrationNameFor } from "@graft/core/approval/vendor-approval.rules";
import type { ConnectionSubmitBody } from "@graft/server/api";

import { draftFromProposal, isOAuthDraft, validateConnectionDraft } from "./connection-form";
import { formatRelative } from "./format";
import type { Ask, PendingAction, PendingAnswer } from "./pending-action-queries";
import { providerLabel } from "./provider-name";
import { toolAskIntegrationName } from "./tool-ask-copy";

/**
 * One open request as a row of the Requests list (GRA-310; the Figma frame "03a Requests > Open"):
 * the integration the ask is about, one sentence naming the agent and what it wants, a sub-line,
 * and two buttons. Every kind `readAsk` knows has a variant here, `other` included, so a row never
 * reads a payload on faith. `requestRowAnswer` is the body a primary that needs no input posts.
 */

/**
 * What the primary button does: answer on the spot, confirm a keyless connection, open the Allow
 * menu (a tool's ask, GRA-311), or open the ask in the request dialog.
 */
export type RequestRowPrimary = "answer" | "confirm" | "menu" | "open";

/** Which shape of a kind the row drew; a connection ask has five (form, link, keyless, widen, fallback). */
export type RequestRowVariant =
  | "tool"
  | "build"
  | "connection-form"
  | "connection-link"
  | "connection-keyless"
  | "connection-widen"
  | "connection-fallback"
  | "credential"
  | "scope"
  | "other";

export type RequestRowCopy = {
  variant: RequestRowVariant;
  /** The integration's slug and name, for its mark; null when the ask names none. */
  vendor: string | null;
  integrationName: string | null;
  /** "Codex wants to send email in Gmail". */
  title: string;
  /** A tool that can delete or overwrite data: the row's "Can delete" chip (ADR 0008). */
  destructive: boolean;
  /** The sub-line's sentence before the time; null when the time stands alone. */
  detail: string | null;
  decline: "Deny" | "Decline";
  primary: { label: string; does: RequestRowPrimary };
};

/** An ask expiring sooner than this shows when it expires instead of when it was asked. */
export const EXPIRY_SHOWN_WITHIN_MS = 6 * 60 * 60 * 1000;

const DETAIL_MAX = 120;

/** The agent as the sentence names it; an ask outlives a revoked agent (ADR 0007). */
export function requestAgentName(action: Pick<PendingAction, "agent">): string {
  return action.agent?.name ?? "A revoked agent";
}

/**
 * What a tool does, in the sentence: the wire name's own part, `<vendor>__<name>`, read as words.
 * Tool names are verb first (`send_email`, `delete-event`), so "wants to send email" reads.
 */
export function toolActionWords(toolName: string): string | null {
  const own = toolName.includes("__") ? toolName.slice(toolName.indexOf("__") + 2) : toolName;
  const words = own
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words === "" ? null : words;
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}…` : flat;
}

function hostsPhrase(hosts: readonly string[]): string {
  const [first, ...rest] = hosts;
  if (!first) return "more hosts";
  if (rest.length === 0) return first;
  return `${first} and ${rest.length} more`;
}

function providerFallbackFrom(payload: Record<string, unknown>): string | null {
  const fallback = payload.providerFallback;
  if (typeof fallback !== "object" || fallback === null) return null;
  const from = (fallback as { from?: unknown }).from;
  return typeof from === "string" && from !== "" ? from : null;
}

/**
 * "asked 3 times" when the agent asked again for an ask still open (GRA-300; the card's
 * `askedCount`), null for an ask asked once or a card that says nothing about it.
 */
export function askedTimesPhrase(action: Pick<PendingAction, "askedCount">): string | null {
  const count = action.askedCount;
  return typeof count === "number" && Number.isInteger(count) && count > 1
    ? `asked ${count} times`
    : null;
}

/**
 * The row's words for an ask: its kind's sentence and sub-line, with how many times it was asked
 * appended to the sub-line when more than once.
 */
export function requestRowCopy(ask: Ask): RequestRowCopy {
  const copy = kindRowCopy(ask);
  const asked = askedTimesPhrase(ask.action);
  if (!asked) return copy;
  return { ...copy, detail: copy.detail ? `${copy.detail} · ${asked}` : asked };
}

/**
 * The account a tool's ask runs as, for "As …": the connection's own account label when the server
 * knows it (GRA-300), else the connection's name where the person named it apart from the
 * integration (several accounts of one integration). Null when neither says anything.
 */
function toolAskAccount(ask: Extract<Ask, { kind: "tool" }>, integration: string): string | null {
  const account = ask.action.account;
  if (typeof account === "string" && account.trim() !== "") return account;
  const name = ask.payload.connectionName;
  return name !== integration ? name : null;
}

function kindRowCopy(ask: Ask): RequestRowCopy {
  const agent = requestAgentName(ask.action);
  switch (ask.kind) {
    case "tool": {
      const { payload } = ask;
      const integration = toolAskIntegrationName(payload);
      const action = toolActionWords(payload.toolName);
      const account = toolAskAccount(ask, integration);
      return {
        variant: "tool",
        vendor: payload.vendor,
        integrationName: integration,
        title: action
          ? `${agent} wants to ${action} in ${integration}`
          : `${agent} wants to use a ${integration} tool`,
        destructive: payload.annotations.destructiveHint === true,
        detail: account ? `As ${account}` : null,
        decline: "Deny",
        primary: { label: "Allow", does: "menu" },
      };
    }
    case "build": {
      const { payload } = ask;
      const integration = integrationNameFor(payload.vendor, payload.connectionName);
      return {
        variant: "build",
        vendor: payload.vendor,
        integrationName: integration,
        title: `${agent} wants to build its own ${integration} tools`,
        destructive: false,
        detail: "Anything it builds still asks before changing data",
        decline: "Decline",
        primary: { label: "Allow", does: "answer" },
      };
    }
    case "connection": {
      const { payload } = ask;
      const name = payload.displayName;
      const base = {
        vendor: payload.vendor,
        integrationName: name,
        destructive: false,
        decline: "Decline" as const,
      };
      // A widening is about a keyless row the person holds (GRA-167): nothing to enter.
      if (payload.widens) {
        return {
          ...base,
          variant: "connection-widen",
          title: `${agent} wants to reach more of ${name}`,
          detail: `Adds ${hostsPhrase(payload.widens.addedHosts)}`,
          primary: { label: "Confirm", does: "confirm" },
        };
      }
      if (payload.scheme === "none") {
        return {
          ...base,
          variant: "connection-keyless",
          title: `${agent} wants to connect ${name}`,
          detail: "A public API, no key needed",
          primary: { label: "Confirm", does: "confirm" },
        };
      }
      const from = providerFallbackFrom(ask.action.payload);
      if (from) {
        return {
          ...base,
          variant: "connection-fallback",
          title: `${agent} wants to connect ${name}`,
          detail: `${providerLabel(from)} couldn't start its sign-in, so connect it here`,
          primary: { label: "Connect", does: "open" },
        };
      }
      return {
        ...base,
        variant: "connection-form",
        title: `${agent} wants to connect ${name}`,
        detail: isOAuthDraft(payload)
          ? `Needs you to sign in to ${name}`
          : `Needs your ${name} key`,
        primary: { label: "Connect", does: "open" },
      };
    }
    case "connection-link": {
      const { payload } = ask;
      return {
        variant: "connection-link",
        vendor: payload.vendor,
        integrationName: payload.displayName,
        title: `${agent} wants to connect ${payload.displayName}`,
        destructive: false,
        detail: `Sign in through ${providerLabel(payload.provider)}`,
        decline: "Decline",
        primary: { label: "Connect", does: "open" },
      };
    }
    case "credential": {
      const { payload } = ask;
      const name = payload.connectionName;
      const oauth = isOAuthDraft(payload);
      return {
        variant: "credential",
        vendor: payload.vendor,
        integrationName: integrationNameFor(payload.vendor, name),
        title: oauth
          ? `${agent} needs you to sign in to ${name} again`
          : payload.revoked
            ? `${agent} wants to reconnect ${name}`
            : `${agent} needs a new key for ${name}`,
        destructive: false,
        detail: payload.revoked
          ? "Its tools can't run until you reconnect"
          : payload.reason
            ? cut(payload.reason)
            : `${name} stopped accepting what Graft holds`,
        decline: "Decline",
        primary: {
          label: oauth ? "Sign in" : payload.revoked ? "Reconnect" : "Update key",
          does: "open",
        },
      };
    }
    case "scope": {
      const { payload } = ask;
      return {
        variant: "scope",
        vendor: payload.vendor,
        integrationName: payload.displayName,
        title: `${agent} wants to use ${payload.displayName}`,
        destructive: false,
        detail: "You've already connected it",
        decline: "Decline",
        primary: { label: "Allow", does: "answer" },
      };
    }
    default: {
      const vendor = ask.action.payload.vendor;
      return {
        variant: "other",
        vendor: typeof vendor === "string" ? vendor : null,
        integrationName: null,
        title: `${agent} is waiting on an answer`,
        destructive: false,
        detail: "The console can't show this kind of request yet; open it to see what was sent",
        decline: "Decline",
        primary: { label: "Open", does: "open" },
      };
    }
  }
}

/**
 * The sub-line's time: when the ask expires once that is near, else when it was asked. Null for a
 * moment that does not parse.
 */
export function requestRowWhen(
  action: Pick<PendingAction, "createdAt" | "expiresAt">,
  now: Date = new Date(),
): { iso: string; label: string } | null {
  const expires = new Date(action.expiresAt).getTime();
  if (Number.isFinite(expires) && expires - now.getTime() < EXPIRY_SHOWN_WITHIN_MS) {
    const relative = formatRelative(action.expiresAt, now);
    return relative ? { iso: action.expiresAt, label: `expires ${relative}` } : null;
  }
  const relative = formatRelative(action.createdAt, now);
  return relative ? { iso: action.createdAt, label: relative } : null;
}

/**
 * What a primary that needs no input posts, or null where the ask needs the person's input. **No
 * standing grant rides on it**: the row draws neither the build choice nor the integration's
 * tools, and a grant is sent only where the person was shown it (GRA-274,
 * `lib/connection-choices.ts`). Both go through the answer routes the cards use: a build or scope
 * ask through `POST /pending-actions/:id/answer`, a keyless connection or a widening through
 * `POST /pending-actions/:id/connection` with the proposal as the agent made it.
 */
export function requestRowAnswer(
  ask: Ask,
):
  | { route: "answer"; body: PendingAnswer }
  | { route: "connection"; body: ConnectionSubmitBody }
  | null {
  if (ask.kind === "build") return { route: "answer", body: { allow: true } };
  if (ask.kind === "scope") return { route: "answer", body: { allow: true, approveBuild: false } };
  if (ask.kind === "connection" && (ask.payload.widens || ask.payload.scheme === "none")) {
    const verdict = validateConnectionDraft(draftFromProposal(ask.payload));
    if (!verdict.ok) return null;
    return {
      route: "connection",
      body: { ...verdict.value, approveBuild: false, allowVendor: false },
    };
  }
  return null;
}
