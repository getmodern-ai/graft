import type { PendingActionRow } from "@graft/db/repo/pending-action";

import type { ServiceContext } from "../context";
import { orNotFound, ServiceError } from "../errors";
import type { AgentScope, Principal } from "../tenancy";
import type { PendingActionDeps } from "./pending-action.deps";

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
  /** The meta-tool's own word for what is being asked — `approval`, `connection`, `credential`. */
  kind: string;
  payload: Record<string, unknown>;
  ttlMs?: number;
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

/** The console's list: unanswered and not yet expired, across all of the person's agents. */
export async function listOpenPendingActions(
  ctx: ServiceContext,
  principal: Principal,
  deps: PendingActionDeps,
): Promise<PendingActionRow[]> {
  return deps.listOpenPendingActions(ctx.db, principal.personId, deps.now());
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
