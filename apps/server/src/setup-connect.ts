import {
  type AgentDeps,
  addConnectionToAgentScope,
  type ConnectionDeps,
  type ConnectionProvider,
  connectingAgentOf,
  describeProviders,
  getAgentScope,
  getConnection,
  getPendingActionForPerson,
  getSetupState,
  isConnectionUsable,
  moveSetupConnect,
  orNotFound,
  type PendingActionDeps,
  type Principal,
  providerFor,
  type ServiceContext,
  ServiceError,
  type SetupConnectMove,
  type SetupDeps,
  type SetupState,
  type SetupVendorOption,
  STARTER_VENDORS,
  setupVendorOptions,
  starterProposal,
  starterVendorOf,
} from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import {
  type ConnectionRouting,
  type ConnectionRoutingDeps,
  readConnectionAnswer,
  readScopeAnswer,
  routeConnectionProposal,
  SCOPE_ASK_KIND,
  type ToolListChangedNotifier,
} from "@graft/mcp";

/**
 * Setup's vendor and connect steps on the server (GRA-206; ADR 0024; GRA-202, *Starter vendors*
 * and *The connect step is the agent's own connection ask*). The routes in `api.ts` are thin over
 * these three functions:
 *
 * - `listSetupVendors`: each starter with the provider `providerFor` routes it to, in the
 *   deployment's order, and `@graft/core`'s `setupVendorOptions` filtering and ordering the list.
 *   Coverage is asked here because it is async and may be a catalogue's (GRA-126); the console
 *   never computes it.
 * - `connectSetupVendor`: a starter becomes **the agent's own connection ask**, through the routing
 *   half of `request_connection` (`routeConnectionProposal`, GRA-203) as the agent Setup runs as,
 *   so the ask, the card, the build choice and the inbox are the ones an agent's proposal gets, and
 *   a repeat re-uses the open ask by its proposal key. A connection the routing makes or finds at
 *   once (a no-step provider, a row already in the agent's scope) moves the record straight on. A
 *   connection the person made with the ordinary form (*Another vendor*) is added to the agent's
 *   scope and moves it the same way.
 * - `learnSetupConnection`: on every read of the state, an ask the record waits on is read (never
 *   taken: the agent's own next `request_connection` still takes it) and, once answered with a
 *   connection that is still live, usable and in the agent's scope, the record names it and moves
 *   to `goal`; declined, expired, gone, or answered with a connection revoked or taken out of the
 *   scope since, back to `vendor`. On `goal` the same read checks the connection still stands, and
 *   takes the record back to `vendor` when it does not, so Build never runs on a dead connection.
 *
 * A step is counted once, by the request whose move changed the record (`SetupMoveResult.moved`),
 * never inferred from the step a read ends on: two reads of one answered ask both end on `goal`.
 */

export type SetupConnectDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  connection: ConnectionDeps;
  pendingAction: PendingActionDeps;
  /** `request_connection`'s routing seams; the server's `McpDeps` satisfies it. */
  routing: ConnectionRoutingDeps;
  /**
   * Told when a no-step provider makes a row, as `connected.ts` says the maker must, and when Setup
   * grows a listed agent's scope with a row that already existed: the row's own announcement went
   * to the agents that reached it then, and no waiting `request_connection` settles to tell this one.
   */
  notifier?: Pick<ToolListChangedNotifier, "changed">;
};

/** What a connect or a read did, so the route can count the connect step completing. */
export type SetupConnectResult = { state: SetupState; connected: boolean };

/** `POST /api/setup/connect`: a starter by its id, or the connection *Another vendor*'s form made. */
export type SetupConnectInput = { starterId: string } | { connectionId: string };

export async function listSetupVendors(
  providers: readonly ConnectionProvider[],
): Promise<SetupVendorOption[]> {
  const covered = await Promise.all(
    STARTER_VENDORS.map(async (starter) => {
      const provider = await providerFor(providers, starter.vendor, starter.hosts, starter.scheme);
      const [description] = describeProviders([provider]);
      if (!description) throw new Error("describeProviders answered nothing for one provider");
      return { starter, provider: description };
    }),
  );
  return setupVendorOptions(covered);
}

/** A routing refusal as the API's refusal: its shape is the proposal's fault, the rest a conflict. */
function refusal(routing: Extract<ConnectionRouting, { kind: "refused" }>): ServiceError {
  const code =
    routing.reason === "input_invalid" || routing.reason === "host_not_public"
      ? "BAD_REQUEST"
      : "CONFLICT";
  return new ServiceError(code, routing.message, {
    details: { ...routing.details, reason: routing.reason },
  });
}

export async function connectSetupVendor(
  ctx: ServiceContext,
  principal: Principal,
  input: SetupConnectInput,
  deps: SetupConnectDeps,
  rerouted = false,
): Promise<SetupConnectResult> {
  const before = await getSetupState(ctx, principal, deps.setup, deps.agent);
  const agent = connectingAgentOf(before);
  const move = async (next: SetupConnectMove): Promise<SetupConnectResult> => {
    const { state, moved } = await moveSetupConnect(ctx, principal, next, deps.setup, deps.agent);
    return { state, connected: moved && next.kind === "connected" };
  };

  if ("connectionId" in input) {
    const connection = orNotFound(
      await getConnection(ctx, principal, input.connectionId, deps.connection),
      "Connection not found",
    );
    if (connection.revokedAt) {
      throw new ServiceError("CONFLICT", `${connection.displayName} is revoked`, {
        details: { reason: "connection_revoked", connectionId: connection.id },
      });
    }
    // A no-op for an agent on every connection (ADR 0007 as amended 2026-09-19).
    await addConnectionToAgentScope(ctx, principal, agent.id, connection.id, deps.agent);
    // The row was announced when it was made, to the agents that reached it then; a listed agent's
    // list grows only now, after the grant committed.
    if (agent.scopeMode === "listed") deps.notifier?.changed(agent.id);
    return move({ kind: "connected", agentId: agent.id, connectionId: connection.id });
  }

  const starter = starterVendorOf(input.starterId);
  if (!starter) throw new ServiceError("NOT_FOUND", "No starter vendor has that id");
  const routing = await routeConnectionProposal(
    ctx,
    { personId: principal.personId, agentId: agent.id },
    starterProposal(starter),
    deps.routing,
    deps.notifier,
  );
  switch (routing.kind) {
    case "refused":
      throw refusal(routing);
    case "connected":
      return move({ kind: "connected", agentId: agent.id, connectionId: routing.connection.id });
    case "connection":
    case "scope": {
      await move({ kind: "ask", agentId: agent.id, pendingActionId: routing.pendingActionId });
      // The routing may answer an ask already answered and not yet taken (GRA-203): read it now,
      // so a person who answered it elsewhere is not shown a settled card.
      const learned = await learnFromRecord(ctx, principal, deps);
      // An answer about a connection that no longer stands was just taken, so routing again goes
      // past it to the person's rows as they are: once, since a taken ask is never re-used.
      if (learned.staleAnswer && !rerouted) {
        return connectSetupVendor(ctx, principal, input, deps, true);
      }
      return learned.result;
    }
  }
}

/** What an ask the record waits on says: the connection it made, closed without one, or open. */
function askVerdict(
  row: PendingActionRow | null,
  agentId: string | null,
  now: Date,
): { connectionId: string } | "closed" | "open" {
  if (!row || row.agentId !== agentId) return "closed";
  if (row.answeredAt) {
    if (row.kind === SCOPE_ASK_KIND) {
      const connectionId = row.payload.connectionId;
      return readScopeAnswer(row.answer).allow && typeof connectionId === "string"
        ? { connectionId }
        : "closed";
    }
    return readConnectionAnswer(row.answer) ?? "closed";
  }
  return row.expiresAt.getTime() <= now.getTime() ? "closed" : "open";
}

/**
 * Whether the agent can use the connection now: the person's row, live and usable (a credential or
 * a consent where the row takes one), and in the agent's scope. Revoked rows stay in a resolved
 * scope (`getAgentScope`), so the row's own state is read beside it.
 */
async function standsForAgent(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  connectionId: string,
  deps: Pick<SetupConnectDeps, "agent" | "connection">,
): Promise<boolean> {
  const [connection, scopeIds] = await Promise.all([
    getConnection(ctx, principal, connectionId, deps.connection),
    getAgentScope(ctx, { personId: principal.personId, agentId }, deps.agent),
  ]);
  return (
    connection !== null &&
    scopeIds.includes(connection.id) &&
    isConnectionUsable(connection, deps.connection.providers)
  );
}

type LearnDeps = Pick<
  SetupConnectDeps,
  "setup" | "agent" | "connection" | "pendingAction" | "notifier"
>;

export async function learnSetupConnection(
  ctx: ServiceContext,
  principal: Principal,
  deps: LearnDeps,
): Promise<SetupConnectResult> {
  return (await learnFromRecord(ctx, principal, deps)).result;
}

/** The read behind `learnSetupConnection`, saying too whether it took an answer that went stale. */
async function learnFromRecord(
  ctx: ServiceContext,
  principal: Principal,
  deps: LearnDeps,
): Promise<{ result: SetupConnectResult; staleAnswer: boolean }> {
  const learned = (result: SetupConnectResult, staleAnswer = false) => ({ result, staleAnswer });
  const before = await getSetupState(ctx, principal, deps.setup, deps.agent);
  const record = before.setup;
  const agentId = before.agent?.id;
  const unchanged = learned({ state: before, connected: false });
  if (!record || !agentId) return unchanged;

  if (record.step === "goal" && record.connectionId) {
    if (await standsForAgent(ctx, principal, agentId, record.connectionId, deps)) return unchanged;
    const { state } = await moveSetupConnect(
      ctx,
      principal,
      { kind: "lost", connectionId: record.connectionId },
      deps.setup,
      deps.agent,
    );
    return learned({ state, connected: false });
  }

  const askId = record.step === "connect" ? record.pendingActionId : null;
  if (!askId) return unchanged;
  const row = await getPendingActionForPerson(ctx, principal, askId, deps.pendingAction);
  const now = deps.pendingAction.now();
  let verdict = askVerdict(row, agentId, now);
  if (verdict === "open") return unchanged;
  // An answer is history: the connection it names may have been revoked or taken out of the scope
  // since, and a record on `goal` with it would build against nothing. Such an answer is taken, so
  // the routing stops handing it back by its proposal key; the agent's own request_connection
  // would find the dead row in its settle, and now routes afresh instead.
  let staleAnswer = false;
  if (
    verdict !== "closed" &&
    !(await standsForAgent(ctx, principal, agentId, verdict.connectionId, deps))
  ) {
    await deps.pendingAction.consumePendingAction(
      ctx.db,
      { personId: principal.personId, agentId },
      askId,
      now,
    );
    verdict = "closed";
    staleAnswer = true;
  }
  const { state, moved } = await moveSetupConnect(
    ctx,
    principal,
    verdict === "closed"
      ? { kind: "reopen", askId }
      : { kind: "connected", agentId, connectionId: verdict.connectionId, askId },
    deps.setup,
    deps.agent,
  );
  const connected = moved && verdict !== "closed";
  // A scope ask answered in the console grew the agent's list, and no waiting call settles to
  // announce it (`awaitScope` does, for an agent's own request_connection).
  if (connected && row?.kind === SCOPE_ASK_KIND) deps.notifier?.changed(agentId);
  return learned({ state, connected }, staleAnswer);
}
