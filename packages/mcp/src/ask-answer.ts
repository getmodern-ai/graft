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
import { readScopeAnswer, SCOPE_ASK_KIND } from "./connection-request";

/**
 * Recording the person's answer to an ask — the writes the console's two answer routes make
 * (`apps/server/src/api.ts`: `POST /pending-actions/:id/answer` and
 * `POST /pending-actions/:id/connection`), factored here so the ask card's `answer_ask` tool
 * (`tools/answer-ask.ts`) records exactly what the console records, through the same functions,
 * in the same transaction shape (GRA-84; ADR 0006 as amended 2026-09-18). Two doors, one record:
 * a yes from the card and a yes from the console page are the same `build_approval` row, the same
 * `connection` row in the same agent's scope, the same `answer` on the action — with one field,
 * `via: "card"`, that says which door it came through, carried on the answer JSON and read by
 * nothing (the console shows what it always showed). The `scope` ask (GRA-104) rides the generic
 * answer too: its yes is the scope grant the agent page's picker makes and, with `approveBuild`,
 * the build approval, in the answer's transaction (`recordAnswer`).
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

export type ApprovalAnswerDeps = {
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
  /** The connection the ask is about, read again at the moment of recording (GRA-69; the header). */
  connection: ConnectionDeps;
  /** The scope write a `scope` ask's yes makes (GRA-104) — the agent page's own seam. */
  agent: AgentDeps;
};

/** A revoke that beat the answer: the ask is closed and the caller is told, after the transaction. */
type RevokedBeforeAnswer = { revoked: { connectionId: string; name: string | null } };

export type ApprovalAnswerRecord = {
  pendingAction: PendingActionRow;
  approval?: ApprovalRow;
  buildApproval?: BuildApprovalRow;
  /** For a `scope` ask's yes (GRA-104): the agent's scope after the grant. */
  connectionIds?: string[];
};

/**
 * The person's answer to a `tool`, `build` or `scope` ask, `{ allow, askEveryCall?, approveBuild? }`
 * plus whatever the door adds. Recording the answer and writing the record it is for happen in one
 * transaction: for a `tool` ask the answer becomes the standing `approval` row (`allow` or `deny`
 * — a no holds too, ADR 0008), and `askEveryCall` with an allow sets the tool's per-call opt-in on
 * or off, absent leaving it as it stands (ADR 0008, amendment of 2026-09-15); for a `build` ask an
 * `allow` grants the build approval and a decline writes nothing, so the next `acquire` asks
 * again; for a `scope` ask (GRA-104) an `allow` adds the connection to the asking agent's scope —
 * the same write the agent page's picker makes (`addConnectionToAgentScope`) — and, with
 * `approveBuild`, grants the build approval for it (GRA-75), while a decline writes nothing. Any
 * other kind records the answer and nothing else, which a waiting connection call reads as a
 * decline.
 *
 * **An answer the standing row now carries in full is consumed here.** Otherwise it would outlive
 * the row: a yes left answered-but-unconsumed would still be found and honoured by a call made
 * after the approval was withdrawn, which is exactly what withdrawing is meant to prevent. The
 * answers the agent's next call must read for itself stay unconsumed — a yes on a tool set to ask
 * every call (the row says allow and the rule still says ask, so this call's yes is the action's),
 * a build decline (no row records it), and the scope ask's answer either way: the waiting
 * `request_connection` reads it to say `connected` with the execute tool named, or `scope_declined`,
 * and on a yes it checks the scope as it stands then, so a yes outliving a later withdrawal is
 * refused there rather than honoured (`connection-request.ts`, `awaitScope`). A call that is
 * waiting sees a consumed action as `CONFLICT` and reads the rule again (`approval.ts`), which is
 * how it proceeds on a yes and refuses on a no.
 *
 * **The connection is read again, locked, before anything is written.** A revoke deletes every
 * approval for the connection and closes its open asks (ADR 0007), but an ask inserted after that
 * sweep ran is still open, and an answer to it must not write an approval back that would stand
 * once the connection is reconnected (GRA-69, found by review on #83). Such an ask is closed here
 * exactly as the sweep closes one, in the same transaction as the answer, and the caller is then
 * refused `CONFLICT` with `reason: "connection_revoked"`; the elicitation path makes the same check
 * in `approval.ts` before it records. The read takes the row `FOR UPDATE`, the lock the revoke
 * itself takes first (`revokeConnection`), so an answer and a revoke that overlap serialise on it
 * rather than interleave — and it is taken **before** the action is updated, in the revoke's own
 * order (connection, then its actions), so the two cannot deadlock by each holding one row and
 * waiting on the other's (Greptile on #87, twice). Every other path that writes a connection and
 * an action — the credential re-entry, the OAuth callback, the provider link's return — already
 * writes the connection first; `confirmConnectionAsk` inserts a connection no revoke can yet name.
 */
export async function recordApprovalAnswer(
  ctx: ServiceContext,
  principal: Principal,
  id: string,
  answer: Record<string, unknown> & {
    allow: boolean;
    askEveryCall?: boolean;
    approveBuild?: boolean;
  },
  deps: ApprovalAnswerDeps,
): Promise<ApprovalAnswerRecord> {
  const outcome = await ctx.db.transaction(
    async (tx): Promise<ApprovalAnswerRecord | RevokedBeforeAnswer> => {
      const scoped: ServiceContext = { db: tx };
      // Lock order: the connection first, then the action — the order `revokeConnection` takes
      // (it locks the row, then closes its asks), so an answer and a revoke that overlap queue on
      // the connection rather than each holding one row and waiting on the other's, which Postgres
      // would break by aborting one (Greptile on #87). The action is read unlocked here for the
      // connection it names; the update that locks it comes after the connection lock.
      const found = await getPendingActionForPerson(scoped, principal, id, deps.pendingAction);
      const connectionId = typeof found?.connectionId === "string" ? found.connectionId : null;
      if (connectionId) {
        // The row locked (FOR UPDATE), not merely read: a revoke locks the same row before it
        // deletes the connection's approvals, so whichever of the two commits first, the other
        // sees its work — this answer reads the row as revoked and closes the ask, or the revoke's
        // delete runs after the approval this answer wrote. The plain read left a window in which
        // an approval landed after the revoke's sweep and outlived it.
        const connection = await deps.connection.findConnectionForUpdate(
          tx,
          principal.personId,
          connectionId,
        );
        if (!connection || connection.revokedAt !== null) {
          await deps.connection.expirePendingActionsForConnection(
            tx,
            principal.personId,
            connectionId,
            deps.pendingAction.now(),
          );
          return { revoked: { connectionId, name: connection?.displayName ?? null } };
        }
      }
      // Unknown, answered or expired is the service's refusal here, as before the pre-read.
      const action = await answerPendingAction(scoped, principal, id, answer, deps.pendingAction);
      return recordAnswer(scoped, principal, action, deps);
    },
  );
  if ("revoked" in outcome) {
    throw new ServiceError(
      "CONFLICT",
      `${outcome.revoked.name ?? "The connection"} was revoked while this ask was open, so the ask is closed and nothing was recorded. Reconnect it in the console and the agent asks again.`,
      { details: { reason: "connection_revoked", connectionId: outcome.revoked.connectionId } },
    );
  }
  return outcome;
}

/** The writes an answer makes once the connection is known to stand; the header says which. */
async function recordAnswer(
  scoped: ServiceContext,
  principal: Principal,
  action: PendingActionRow,
  deps: ApprovalAnswerDeps,
): Promise<ApprovalAnswerRecord> {
  {
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
    if (action.kind === SCOPE_ASK_KIND && typeof action.payload.connectionId === "string") {
      return grantScope(scoped, principal, action, action.payload.connectionId, deps);
    }
    return { pendingAction: action };
  }
}

/**
 * A `scope` ask's yes (GRA-104): the connection joins the asking agent's scope — and no other
 * agent's (ADR 0007) — through the write the agent page's picker makes, and the build approval
 * is granted for it when the person left GRA-75's choice on; the scope first, so a recorded
 * approval never lacks the scope it is for. A no writes nothing. Either way the answer stays for
 * the waiting `request_connection` to read (the header says why).
 */
async function grantScope(
  scoped: ServiceContext,
  principal: Principal,
  action: PendingActionRow,
  connectionId: string,
  deps: ApprovalAnswerDeps,
): Promise<ApprovalAnswerRecord> {
  const said = readScopeAnswer(action.answer);
  if (!said.allow) return { pendingAction: action };
  const { connectionIds } = await addConnectionToAgentScope(
    scoped,
    principal,
    action.agentId,
    connectionId,
    deps.agent,
  );
  const buildApproval = said.approveBuild
    ? await grantBuildApproval(
        scoped,
        { personId: principal.personId, agentId: action.agentId },
        connectionId,
        deps.approval,
      )
    : undefined;
  return { pendingAction: action, connectionIds, ...(buildApproval ? { buildApproval } : {}) };
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
