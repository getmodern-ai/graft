import type { DonePendingActionCursor, PendingActionRow } from "@graft/db/repo/pending-action";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope, Principal } from "../tenancy";
import type { PendingActionDeps } from "./pending-action.deps";
import { pendingActionFinishedAt } from "./pending-action.rules";

/**
 * Pending actions (ADR 0006): the durable record behind a handoff. A meta-tool creates one with an
 * expiry and waits; the person answers it from the console; the tool consumes the answer once. An
 * expired action is refused on both sides, so a late answer lands nowhere and a waiting tool gets a
 * clear refusal rather than a wait that never ends.
 */

/** How long an action waits by default — long enough for a person who is not at a keyboard. */
export const DEFAULT_PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreatePendingActionInput = {
  /** The meta-tool's own word for what is being asked — `tool`, `build`, `connection`, `credential`. */
  kind: string;
  payload: Record<string, unknown>;
  ttlMs?: number;
  /** The connection the ask is about, when it is about one — the column a revoke closes asks by (ADR 0007). */
  connectionId?: string | null;
};

export async function createPendingAction(
  ctx: ServiceContext,
  scope: AgentScope,
  input: CreatePendingActionInput,
  deps: PendingActionDeps,
): Promise<PendingActionRow> {
  const ttl = input.ttlMs ?? DEFAULT_PENDING_ACTION_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_PENDING_ACTION_TTL_MS) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A pending action waits between 1 ms and ${MAX_PENDING_ACTION_TTL_MS} ms`,
    );
  }
  if (input.kind.trim().length === 0) {
    throw new ServiceError("BAD_REQUEST", "A pending action has a kind");
  }
  const now = deps.now();
  return deps.insertPendingAction(ctx.db, {
    id: deps.newId(),
    agentId: scope.agentId,
    kind: input.kind,
    payload: input.payload,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    expiresAt: new Date(now.getTime() + ttl),
    createdAt: now,
  });
}

/** The waiting tool's read of its own action. */
export async function getPendingAction(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  deps: PendingActionDeps,
): Promise<PendingActionRow | null> {
  return deps.findPendingAction(ctx.db, scope, id);
}

/** The console's read of one action, whichever of the person's agents raised it (GRA-23's card). */
export async function getPendingActionForPerson(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  deps: PendingActionDeps,
): Promise<PendingActionRow | null> {
  return deps.findPendingActionForPerson(ctx.db, principal.personId, id);
}

/** The console's list: unanswered and not yet expired, across all of the person's agents. */
export async function listOpenPendingActions(
  ctx: ServiceContext,
  principal: Principal,
  deps: PendingActionDeps,
): Promise<PendingActionRow[]> {
  return deps.listOpenPendingActions(ctx.db, principal.personId, deps.now());
}

/** A page of the Done list when the console names no size, and the most it may name. */
export const DONE_PENDING_ACTIONS_PAGE = 50;
export const MAX_DONE_PENDING_ACTIONS_PAGE = 100;

export type DonePendingActionsPage = {
  rows: PendingActionRow[];
  /** Where the next page starts, opaque to the console; null on the last page. */
  nextCursor: string | null;
};

/**
 * The console's Done list (GRA-292): answered, expired and revoke-closed asks across the person's
 * agents, newest finish first, a page at a time. One row past the page is read to know whether
 * another page exists, so the last page answers no cursor rather than a cursor to an empty page.
 * The cursor names the page's last row by its finish and id (`DonePendingActionCursor`), which
 * stays put while asks finish meanwhile (the repo's `finishedAt` says why).
 */
export async function listDonePendingActions(
  ctx: ServiceContext,
  principal: Principal,
  input: { cursor?: string | null; limit?: number | null },
  deps: PendingActionDeps,
): Promise<DonePendingActionsPage> {
  const limit = input.limit ?? DONE_PENDING_ACTIONS_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DONE_PENDING_ACTIONS_PAGE) {
    throw new ServiceError(
      "BAD_REQUEST",
      `A page of finished asks holds between 1 and ${MAX_DONE_PENDING_ACTIONS_PAGE}`,
    );
  }
  const after = input.cursor ? decodeDoneCursor(input.cursor) : null;
  const read = await deps.listDonePendingActions(ctx.db, principal.personId, {
    now: deps.now(),
    limit: limit + 1,
    after,
  });
  const rows = read.slice(0, limit);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor:
      read.length > limit && last
        ? encodeDoneCursor({ finishedAt: pendingActionFinishedAt(last), id: last.id })
        : null,
  };
}

export function encodeDoneCursor(cursor: DonePendingActionCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.finishedAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

/** The cursor back; anything that is not one this server wrote is a `BAD_REQUEST`, never a first page. */
export function decodeDoneCursor(cursor: string): DonePendingActionCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object") {
      const { t, id } = parsed as Record<string, unknown>;
      const finishedAt = typeof t === "string" ? new Date(t) : null;
      if (finishedAt && !Number.isNaN(finishedAt.getTime()) && typeof id === "string" && id) {
        return { finishedAt, id };
      }
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ServiceError("BAD_REQUEST", "That cursor is not one this list wrote");
}

/**
 * The person's answer. The repo refuses an answered or expired action in the statement; this reads
 * the row back only to say *which* — `GONE` for expired, `CONFLICT` for already answered,
 * `NOT_FOUND` for the rest — because the console's next sentence turns on it.
 */
export async function answerPendingAction(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  answer: Record<string, unknown>,
  deps: PendingActionDeps,
): Promise<PendingActionRow> {
  const now = deps.now();
  const answered = await deps.answerPendingAction(ctx.db, principal.personId, id, {
    answer,
    answeredAt: now,
  });
  if (answered) return answered;

  const row = orNotFound(
    await deps.findPendingActionForPerson(ctx.db, principal.personId, id),
    "Pending action not found",
  );
  if (row.answeredAt) throw new ServiceError("CONFLICT", "This action has already been answered");
  throw new ServiceError(
    "GONE",
    "This action has expired — the agent will ask again if it still needs to",
  );
}

/**
 * The waiting tool takes the answer, once. Null while the action is still unanswered and in time;
 * `GONE` once it has expired unanswered, so the tool returns a clear refusal; `CONFLICT` when the
 * answer was already taken.
 */
export async function consumePendingAction(
  ctx: ServiceContext,
  scope: AgentScope,
  id: string,
  deps: PendingActionDeps,
): Promise<PendingActionRow | null> {
  const now = deps.now();
  const consumed = await deps.consumePendingAction(ctx.db, scope, id, now);
  if (consumed) return consumed;

  const row = orNotFound(
    await deps.findPendingAction(ctx.db, scope, id),
    "Pending action not found",
  );
  if (row.consumedAt) throw new ServiceError("CONFLICT", "This action's answer was already taken");
  if (row.answeredAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new ServiceError("GONE", "This action expired without an answer");
  }
  return null;
}
