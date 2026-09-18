import {
  type AgentDeps,
  type ApprovalDeps,
  addConnectionToAgentScope,
  answerPendingAction,
  type ConnectionDeps,
  type ConnectionOutput,
  consumePendingAction,
  getPendingActionForPerson,
  grantBuildApproval,
  KEYRING_PROVIDER,
  orNotFound,
  type PendingActionDeps,
  type Principal,
  type RegisterConnectionWithCredentialInput,
  registerConnectionWithCredential,
  type ServiceContext,
  ServiceError,
  setApproval,
} from "@graft/core";
import type { ApprovalRow, BuildApprovalRow } from "@graft/db/repo/approval";
import type { PendingActionRow } from "@graft/db/repo/pending-action";

import { readApprovalAnswer } from "./approval";

/**
 * Recording the person's answer to an ask — the writes the console's two answer routes make
 * (`apps/server/src/api.ts`: `POST /pending-actions/:id/answer` and
 * `POST /pending-actions/:id/connection`), factored here so the ask card's `answer_ask` tool
 * (`tools/answer-ask.ts`) records exactly what the console records, through the same functions,
 * in the same transaction shape (GRA-84; ADR 0006 as amended 2026-09-18). Two doors, one record:
 * a yes from the card and a yes from the console page are the same `build_approval` row, the same
 * `connection` row in the same agent's scope, the same `answer` on the action — with one field,
 * `via: "card"`, that says which door it came through, carried on the answer JSON and read by
 * nothing (the console shows what it always showed).
 *
 * Lives in `@graft/mcp` rather than `@graft/core` because the ask's payloads and answer shapes
 * are this package's (`approval.ts`, `connection-request.ts`), and the server imports both; the
 * server is never imported from here.
 */

/** The console's two sentences for a closed ask, shared so the card and the page say the same. */
export const ASK_ANSWERED_MESSAGE = "This action has already been answered";
export const ASK_EXPIRED_MESSAGE =
  "This action has expired — the agent will ask again if it still needs to";

/** Unanswered, untaken and in time — or the answer route's own refusal (409, 410). */
export function refuseUnlessOpen(row: PendingActionRow, now: Date): PendingActionRow {
  if (row.answeredAt || row.consumedAt) {
    throw new ServiceError("CONFLICT", ASK_ANSWERED_MESSAGE);
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new ServiceError("GONE", ASK_EXPIRED_MESSAGE);
  }
  return row;
}

/**
 * The action a submit is for: the person's, of the kind the route serves, unanswered and in time
 * — refused before anything is written. The answer's own predicate refuses again inside the
 * transaction, so two submits of one link make one connection and the second is told so.
 */
export async function openAskOfKind(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  kind: string,
  deps: PendingActionDeps,
): Promise<PendingActionRow> {
  const row = orNotFound(
    await getPendingActionForPerson(ctx, principal, id, deps),
    "Pending action not found",
  );
  if (row.kind !== kind) {
    throw new ServiceError("BAD_REQUEST", `This action is a ${row.kind} ask, not a ${kind} one`);
  }
  return refuseUnlessOpen(row, deps.now());
}

export type ApprovalAnswerDeps = { approval: ApprovalDeps; pendingAction: PendingActionDeps };

export type ApprovalAnswerRecord = {
  pendingAction: PendingActionRow;
  approval?: ApprovalRow;
  buildApproval?: BuildApprovalRow;
};

/**
 * The person's answer to a `tool` or `build` ask, `{ allow, askEveryCall? }` plus whatever the
 * door adds. Recording the answer and writing the approval it is for happen in one transaction:
 * for a `tool` ask the answer becomes the standing `approval` row (`allow` or `deny` — a no holds
 * too, ADR 0008), and `askEveryCall` with an allow sets the tool's per-call opt-in on or off,
 * absent leaving it as it stands (ADR 0008, amendment of 2026-09-15); for a `build` ask an
 * `allow` grants the build approval and a decline writes nothing, so the next `acquire` asks
 * again. Any other kind records the answer and nothing else, which a waiting connection call
 * reads as a decline.
 *
 * **An answer the standing row now carries in full is consumed here.** Otherwise it would outlive
 * the row: a yes left answered-but-unconsumed would still be found and honoured by a call made
 * after the approval was withdrawn, which is exactly what withdrawing is meant to prevent. The two
 * answers the agent's next call must read for itself stay unconsumed — a yes on a tool set to ask
 * every call (the row says allow and the rule still says ask, so this call's yes is the action's)
 * and a build decline (no row records it). A call that is waiting sees the consumed action as
 * `CONFLICT` and reads the rule again (`approval.ts`), which is how it proceeds on a yes and
 * refuses on a no.
 */
export async function recordApprovalAnswer(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  answer: Record<string, unknown> & { allow: boolean; askEveryCall?: boolean },
  deps: ApprovalAnswerDeps,
): Promise<ApprovalAnswerRecord> {
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const action = await answerPendingAction(scoped, principal, id, answer, deps.pendingAction);
    const scope = { personId: principal.personId, agentId: action.agentId };
    const said = readApprovalAnswer(action.answer);
    /** Mark the answer spent; the agent may have taken it between the two statements, which is fine. */
    const settle = async () => {
      try {
        await consumePendingAction(scoped, scope, action.id, deps.pendingAction);
      } catch (error) {
        if (!(error instanceof ServiceError && error.code === "CONFLICT")) throw error;
      }
    };
    if (action.kind === "tool" && typeof action.payload.toolId === "string") {
      const toolId = action.payload.toolId;
      // The setting rides the yes in the same write. Not `setAskEveryCall`: that is the agent
      // page's act and spends waiting answers, and this answer may have to wait for the agent.
      const approval = await setApproval(
        scoped,
        scope,
        toolId,
        said.allow ? "allow" : "deny",
        deps.approval,
        said.allow && said.askEveryCall !== undefined ? { askEveryCall: said.askEveryCall } : {},
      );
      if (!said.allow || !approval.askEveryCall) await settle();
      return { pendingAction: action, approval };
    }
    if (action.kind === "build" && said.allow && typeof action.payload.connectionId === "string") {
      const buildApproval = await grantBuildApproval(
        scoped,
        scope,
        action.payload.connectionId,
        deps.approval,
      );
      await settle();
      return { pendingAction: action, buildApproval };
    }
    return { pendingAction: action };
  });
}

/** What the person confirms: the proposal as edited (or as proposed), the credential, and GRA-75's build choice. */
export type ConnectionConfirmation = RegisterConnectionWithCredentialInput & {
  approveBuild?: boolean;
};

/**
 * The server's hook for an authorization-code connection (ADR 0005): start the consent and hand
 * back what the route answers. Null for every other scheme. Bound by `apps/server/src/api.ts`;
 * the card never reaches it, since a scheme with a client secret is not answerable there.
 */
export type ConsentStarter = (
  ctx: ServiceContext,
  principal: Principal,
  connectionId: string,
  scheme: string,
  pendingActionId: string,
) => Promise<{ connection: ConnectionOutput; authorizeUrl: string } | null>;

export type ConnectionConfirmationDeps = {
  connection: ConnectionDeps;
  agent: AgentDeps;
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
};

export type ConnectionConfirmationRecord = {
  connection: ConnectionOutput;
  pendingAction: PendingActionRow;
  /** Present when a consent was started and the ask stays open for the callback to answer. */
  authorizeUrl?: string;
  buildApproval?: BuildApprovalRow;
};

/**
 * The person's confirmation of a `connection` ask (GRA-28; ADR 0006): the proposal becomes a
 * connection with its credential written once through the vault's encrypt half — or with none,
 * for a scheme that takes none (GRA-66) — the connection joins the requesting agent's scope and
 * no other agent's (ADR 0007), and the action's answer records `{ connectionId }` and nothing of
 * the credential. One transaction, so a refused host or a mistyped field leaves no row, no scope
 * change and no answer. With `approveBuild` the same transaction records the asking agent's build
 * approval for the new connection (GRA-75; ADR 0008, amendment of 2026-09-18), so the next
 * `acquire` finds it standing and asks nothing.
 *
 * The row belongs to the provider the ask was routed to (ADR 0019; `request_connection` recorded
 * it on the payload, and an ask made before providers existed is the keyring's). The person edits
 * the proposal, not its routing: a confirmation naming another provider is refused.
 *
 * An authorization-code connection is not connected until the consent completes: with a
 * `consent` hook the ask stays open and the callback answers it (`apps/server/src/oauth.ts`), so
 * the agent's call says connected only when the vendor can be called (ADR 0005). Without one —
 * the card's path, which never reaches such a scheme — the answer is recorded here.
 */
export async function confirmConnectionAsk(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  submit: ConnectionConfirmation,
  deps: ConnectionConfirmationDeps,
  options: { consent?: ConsentStarter; answerExtra?: Record<string, unknown> } = {},
): Promise<ConnectionConfirmationRecord> {
  return ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const action = await openAskOfKind(scoped, principal, id, "connection", deps.pendingAction);
    const routed =
      typeof action.payload.provider === "string" ? action.payload.provider : KEYRING_PROVIDER;
    if (submit.provider !== undefined && submit.provider !== routed) {
      throw new ServiceError(
        "BAD_REQUEST",
        `This ask was routed to the ${routed} provider; a connection answering it cannot name another`,
      );
    }
    const { approveBuild, ...registration } = submit;
    const connection = await registerConnectionWithCredential(
      scoped,
      principal,
      { ...registration, provider: routed },
      deps.connection,
    );
    await addConnectionToAgentScope(scoped, principal, action.agentId, connection.id, deps.agent);
    const buildApproval = approveBuild
      ? await grantBuildApproval(
          scoped,
          { personId: principal.personId, agentId: action.agentId },
          connection.id,
          deps.approval,
        )
      : undefined;
    const granted = buildApproval ? { buildApproval } : {};
    const consent = options.consent
      ? await options.consent(scoped, principal, connection.id, connection.scheme, action.id)
      : null;
    if (consent) {
      return {
        connection: consent.connection,
        pendingAction: action,
        authorizeUrl: consent.authorizeUrl,
        ...granted,
      };
    }
    const pendingAction = await answerPendingAction(
      scoped,
      principal,
      action.id,
      { connectionId: connection.id, ...options.answerExtra },
      deps.pendingAction,
    );
    return { connection, pendingAction, ...granted };
  });
}
