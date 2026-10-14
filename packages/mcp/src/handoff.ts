import { createHmac, timingSafeEqual } from "node:crypto";

import type { PendingActionClosedReason } from "@graft/db/schema/pending-action";

/**
 * The **handoff** URL for a pending action (CONTEXT.md, *Handoff*; ADR 0006): what a tool returns
 * when the harness cannot ask the person in place, and what the person opens in the console to
 * answer. ADR 0006 calls the URL a phishing-shaped artefact and says what makes it safe to hand
 * around — signed, bound to the agent that requested it, expiring — and this file is those three
 * properties as code, plus the fourth the ticket adds: a link whose action was already consumed is
 * refused as reused.
 *
 * The token is an HMAC-SHA256 over the action's id, the requesting agent's id and the expiry, keyed
 * by `GRAFT_HANDOFF_SECRET`, and carries no payload of its own: the console resolves the action by
 * id under the person's session and recomputes the mark from the row, so a link cannot be edited to
 * point at another action or another agent without the mark going stale. Expiry and reuse are read
 * from the row too — the row is the record (ADR 0006), the token only proves the link is the one
 * Graft issued for it.
 */

/** What the console lands on: `<GRAFT_CONSOLE_URL>/pending/<id>?t=<token>`. */
export const HANDOFF_PATH = "/pending";
export const HANDOFF_TOKEN_PARAM = "t";

/** The handoff's configuration, from the environment; `apps/server` builds it and hands it across. */
export type HandoffConfig = {
  /** `GRAFT_CONSOLE_URL` — the base every handoff URL is built on. */
  consoleUrl: string;
  /** `GRAFT_HANDOFF_SECRET` — what signs the token. */
  secret: string;
  /** How long a call waits for the answer before returning `awaiting_approval`. */
  waitMs: number;
  /** How long a pending action stays answerable. */
  ttlMs: number;
  /** How often the waiting call looks for the answer; a test sets it low. */
  pollMs?: number;
};

/** The part of a pending action the token is computed over and the verification reads. */
export type HandoffSubject = {
  id: string;
  agentId: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  answeredAt?: Date | null;
  /** Set when a revoke closed the ask unanswered (migration 0019, GRA-292). */
  closedReason?: PendingActionClosedReason | null;
};

function mark(subject: Pick<HandoffSubject, "id" | "agentId" | "expiresAt">, secret: string) {
  return createHmac("sha256", secret)
    .update(`${subject.id}\n${subject.agentId}\n${subject.expiresAt.getTime()}`)
    .digest();
}

/** The token for one action: base64url of the mark, 43 characters. */
export function signHandoffToken(
  subject: Pick<HandoffSubject, "id" | "agentId" | "expiresAt">,
  secret: string,
): string {
  return mark(subject, secret).toString("base64url");
}

/** The URL the agent relays. `consoleUrl` may carry a path; a trailing slash is not doubled. */
export function handoffUrl(consoleUrl: string, pendingActionId: string, token: string): string {
  const base = consoleUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ [HANDOFF_TOKEN_PARAM]: token });
  return `${base}${HANDOFF_PATH}/${encodeURIComponent(pendingActionId)}?${query}`;
}

export type HandoffRefusalReason = "tampered" | "expired" | "consumed" | "closed";

export type HandoffVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: HandoffRefusalReason;
      message: string;
      closedReason?: PendingActionClosedReason;
    };

/**
 * Verify a link against its row. Tampering is checked first and in constant time, so a forged token
 * learns nothing about the action's state; then reuse, then expiry — a consumed link is "already
 * used" even once it has also expired, which is the more useful sentence.
 *
 * **Except an ask a revoke closed unanswered**, which is `closed` before anything else (GRA-314):
 * the revoke stamps `expires_at` to its own moment, and the mark is computed over it, so the link
 * no longer verifies and would read as one Graft never issued. Call this only on a row read under
 * the owning person, as the console's read does: the owner sees the same close on the Done list,
 * so saying it to them reveals nothing.
 */
export function verifyHandoff(args: {
  token: string | null | undefined;
  subject: HandoffSubject;
  secret: string;
  now: Date;
}): HandoffVerdict {
  const closedReason = args.subject.closedReason;
  if (closedReason && !args.subject.answeredAt) {
    return {
      ok: false,
      reason: "closed",
      closedReason,
      message:
        closedReason === "agent_revoked"
          ? "This ask was closed when its agent was revoked"
          : "This ask was closed when its connection was revoked",
    };
  }
  const expected = mark(args.subject, args.secret);
  const presented = decodeToken(args.token);
  if (!presented || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return {
      ok: false,
      reason: "tampered",
      message: "This handoff link is not one Graft issued for this action",
    };
  }
  if (args.subject.consumedAt) {
    return {
      ok: false,
      reason: "consumed",
      message: "This handoff link was already used; the agent has taken the answer",
    };
  }
  if (args.subject.expiresAt.getTime() <= args.now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      message: "This handoff link has expired; the agent will ask again if it still needs to",
    };
  }
  return { ok: true };
}

function decodeToken(token: string | null | undefined): Buffer | null {
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    return Buffer.from(token, "base64url");
  } catch {
    return null;
  }
}
