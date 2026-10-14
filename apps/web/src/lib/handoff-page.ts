import { FROM_CARD_CLOSE_MS } from "@graft/core/connection/card.rules";
import type { HandoffRefusalDetails } from "@graft/server/api";

import { ApiError, type Jsonified } from "./api";
import { formatRelative } from "./format";

/**
 * What the handoff page does once an ask is answered (GRA-144; ADR 0006 as amended 2026-09-21).
 *
 * The page a relayed handoff opens — `/pending/<id>?t=<token>` — is a focused page outside the
 * console shell: one request, then done. Which "done" depends on how the person arrived, read from
 * the route's search and nothing else, so the decision is a function and the route only carries it
 * out.
 *
 * - A **handoff visit** (`t` present) — a terminal harness's relayed URL, or a chat product's card
 *   popup — closes itself: the agent finds the answer on its next call, and the person was
 *   somewhere else a moment ago. The card popup also tells its opener first (`from=card`, the
 *   contract `card.rules.ts` describes), which a terminal's tab has no opener to tell.
 * - A **console visit** (no `t`, the deep link typed or followed by hand) goes back to the list, as
 *   the page always did.
 *
 * A browser refuses `window.close()` on a tab the person opened themselves, so a handoff visit that
 * is still open a moment after asking shows the answered page instead (`handoffAnswered`, the
 * frames' *Connected*; GRA-287's sixth decision keeps the self-close and makes that page the
 * fallback) — the same fallback the OAuth callback page uses (`routes/oauth.callback.tsx`).
 *
 * Person-facing copy says *request* for the ask (CONTEXT.md, *Request*) and never *link*, which
 * *Handoff* keeps off the page (GRA-282, GRA-314).
 */
export type HandoffVisit = { t?: string; from?: "card" };

export type AfterAnswer = { kind: "close"; announce: boolean } | { kind: "back-to-list" };

export function afterAnswer(visit: HandoffVisit): AfterAnswer {
  if (visit.t === undefined || visit.t.length === 0) return { kind: "back-to-list" };
  return { kind: "close", announce: visit.from === "card" };
}

/** How long the settled card stays before the page tries to close — the card popup's own delay. */
export const HANDOFF_CLOSE_MS = FROM_CARD_CLOSE_MS;
/** How long after asking to close before the page concludes the browser refused. */
export const HANDOFF_CLOSE_CHECK_MS = 200;

/** The answered page when nothing is known of the answer: the cache lost it, or no ask was read. */
export const HANDOFF_ANSWERED = {
  title: "Done",
  message:
    "You can close this tab. Your agent picks up the answer on its next call, and Requests in Graft has the record.",
} as const;

/** What the answered page needs of the ask it settled. */
export type AnsweredAsk = {
  kind: string;
  agentName: string | null;
  integrationName: string | null;
  answer: Record<string, unknown> | null;
};

/** The answered page: a title, the sentence under it, and the access line for a connection. */
export type HandoffAnswered = { title: string; message: string; access: string | null };

const CONNECTING_KINDS = new Set(["connection", "credential", "scope"]);

/**
 * The page a handoff visit shows when its tab will not close (frame 10c, *Connected*): what the
 * answer did in the person's words, where to go next, and, where the answer records what the agent
 * may do (a scope ask's, GRA-314), the access line the page offers to change.
 */
export function handoffAnswered(ask: AnsweredAsk | null): HandoffAnswered {
  if (!ask?.answer) return { ...HANDOFF_ANSWERED, access: null };
  const agent = ask.agentName ?? "Your agent";
  const integration = ask.integrationName ?? "The integration";
  const backTo = `Go back to ${agent}. It picks up where it left off.`;
  const connected = typeof ask.answer.connectionId === "string" || ask.answer.allow === true;
  if (!connected) {
    return {
      title: "Declined",
      message: `${agent} is told on its next call. You can close this tab.`,
      access: null,
    };
  }
  if (!CONNECTING_KINDS.has(ask.kind)) {
    return { title: "Allowed", message: backTo, access: null };
  }
  return {
    title: ask.kind === "scope" ? `${agent} can use ${integration}` : `${integration} is connected`,
    message: backTo,
    access: accessLine(agent, ask.answer),
  };
}

function accessLine(agent: string, answer: Record<string, unknown>): string | null {
  if (typeof answer.approveBuild !== "boolean" && typeof answer.allowVendor !== "boolean") {
    return null;
  }
  return answer.approveBuild === true && answer.allowVendor === true
    ? `${agent} has full access. Tools that can delete still ask.`
    : `${agent} asks you first.`;
}

/** The refusals the server names in `details.reason` for a handoff read (`@graft/mcp`'s `handoff.ts`). */
export type HandoffRefusalReason = HandoffRefusalDetails["reason"];

const REASONS: readonly HandoffRefusalReason[] = ["tampered", "expired", "consumed", "closed"];

/** The server's `details` on a refused handoff read, or null for any other failure. */
export function handoffRefusalDetails(error: unknown): Jsonified<HandoffRefusalDetails> | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("reason" in details)) return null;
  const reason = (details as { reason: unknown }).reason;
  if (!REASONS.includes(reason as HandoffRefusalReason)) return null;
  return details as Jsonified<HandoffRefusalDetails>;
}

/** The server's `details.reason` on a refused handoff read, or null for any other failure. */
export function handoffRefusalReason(error: unknown): HandoffRefusalReason | null {
  return handoffRefusalDetails(error)?.reason ?? null;
}

/**
 * Whether a failed handoff read stays out of the global query toast (the read's
 * `meta.quietError`, which `query-error-retry.ts` asks). A refusal (a 4xx: used, expired, closed,
 * never issued, not found) never toasts: the page draws it, and Retry cannot change it (GRA-334). A
 * server failure and a request that never arrived still toast, since Retry is what helps there.
 */
export function handoffReadIsQuiet(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * The refusal page: `expired` draws the hourglass (frame 10d) for an ask that ran out or a revoke
 * closed, `refused` the warning for the rest.
 */
export type HandoffRefusal = { kind: "expired" | "refused"; title: string; message: string };

const NOTHING_ANSWERED = "Nothing has been approved or declined.";

/**
 * The refusal page's headline and sentence for a request that does not open. An expired or closed
 * ask names the agent, the integration and when it asked, which the server adds for the owning
 * person (GRA-314); without them the sentences stand alone.
 */
export function handoffRefusal(error: unknown, now: Date = new Date()): HandoffRefusal {
  if (!(error instanceof ApiError)) {
    return {
      kind: "refused",
      title: "This request can't be opened",
      message: `Could not reach Graft. ${NOTHING_ANSWERED}`,
    };
  }
  const details = handoffRefusalDetails(error);
  const agent = details?.agentName ?? null;
  const integration = details?.integrationName ?? null;
  switch (details?.reason) {
    // A used request is an answered one: "nothing has been approved or declined" would be false.
    case "consumed":
      return {
        kind: "refused",
        title: "This request was already answered",
        message: "Your agent has taken the answer. Requests in Graft has the record.",
      };
    case "expired": {
      const ago = details.askedAt ? formatRelative(details.askedAt, now) : "";
      const asked = agent && ago ? `${agent} asked ${ago}. ` : "";
      const again = integration
        ? `If it still needs ${integration}, it'll ask again.`
        : "If your agent still needs it, it'll ask again.";
      return { kind: "expired", title: "This request has expired", message: `${asked}${again}` };
    }
    case "closed": {
      const who = agent ?? "Your agent";
      const message =
        details.closedReason === "agent_revoked"
          ? `${who} was revoked, so its request closed without an answer.`
          : `${integration ?? "The connection"} was revoked, so ${agent ? `${agent}'s` : "the"} request closed without an answer. If ${agent ?? "your agent"} still needs it, it'll ask again once you reconnect.`;
      return { kind: "expired", title: "This request was closed", message };
    }
    case "tampered":
      return {
        kind: "refused",
        title: "Graft did not issue this request",
        message: `The address may be incomplete; open it again from your agent. ${NOTHING_ANSWERED}`,
      };
    default:
      return error.status === 404
        ? {
            kind: "refused",
            title: "There is no such request",
            message: `It may belong to another account. ${NOTHING_ANSWERED}`,
          }
        : {
            kind: "refused",
            title: "This request can't be opened",
            message: `${error.message.replace(/\.$/, "")}. ${NOTHING_ANSWERED}`,
          };
  }
}

/** What a handoff visit draws. */
export type HandoffView<A> =
  | { kind: "loading" }
  | { kind: "ask"; action: A }
  | { kind: "answered" }
  | ({ kind: "refused" } & Omit<HandoffRefusal, "kind"> & { refusal: HandoffRefusal["kind"] });

/**
 * A handoff visit's view from its read and whether this page answered (GRA-334).
 *
 * An answer given on this page settles it, whatever a later read says: once the agent takes the
 * answer, and for an answer the answer route consumes itself (a tool ask's, ADR 0008), every read
 * is a `409 consumed`. So after an answer from here the page shows the settled card when the cache
 * holds the answer and the answered page when it does not, never the refusal. Before that, a
 * refused read is the refusal page, except that a settled ask already on screen stays.
 */
export function handoffView<A extends { answeredAt: string | null }>(read: {
  pending: boolean;
  error: unknown;
  action: A | undefined;
  answeredHere: boolean;
  now?: Date;
}): HandoffView<A> {
  const { pending, error, action, answeredHere } = read;
  if (answeredHere) {
    if (action?.answeredAt) return { kind: "ask", action };
    if (error) return { kind: "answered" };
  }
  if (pending) return { kind: "loading" };
  if (action && (!error || action.answeredAt)) return { kind: "ask", action };
  const { kind: refusal, title, message } = handoffRefusal(error, read.now);
  return { kind: "refused", refusal, title, message };
}

/**
 * The line under the request's card (the frames' footnote): how long it stays answerable, then,
 * where a secret is typed, that Graft keeps it encrypted, else where to go once answered.
 */
export function handoffFootnote(
  input: {
    expiresAt: string;
    agentName: string | null;
    secret: boolean;
    /** The Requests dialog (GRA-311): the person is in the console already, so no "go back". */
    inConsole?: boolean;
  },
  now: Date = new Date(),
): string {
  const left = formatRelative(input.expiresAt, now);
  const expires = left ? `Expires ${left}` : "";
  const then = input.secret
    ? "Your key is stored by Graft, encrypted"
    : input.inConsole
      ? ""
      : `After you answer, go back to ${input.agentName ?? "your agent"}`;
  return [expires, then].filter((part) => part !== "").join(" · ");
}

/** The document title while the page is up: the agent's name when the ask names one. */
export function handoffTitle(agentName?: string | null): string {
  return agentName ? `Graft — ${agentName} asks` : "Graft — Pending action";
}
