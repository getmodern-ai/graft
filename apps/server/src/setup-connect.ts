import {
  type AgentDeps,
  addConnectionToAgentScope,
  type ConnectionDeps,
  type ConnectionProvider,
  connectingAgentOf,
  describeProviders,
  getConnection,
  getPendingActionForPerson,
  getSetupState,
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
 *   connection, the record names it and moves to `goal`; declined, expired or gone, back to `vendor`.
 */

export type SetupConnectDeps = {
  setup: SetupDeps;
  agent: AgentDeps;
  connection: ConnectionDeps;
  pendingAction: PendingActionDeps;
  /** `request_connection`'s routing seams; the server's `McpDeps` satisfies it. */
  routing: ConnectionRoutingDeps;
  /** Told when a no-step provider makes a row, as `connected.ts` says the maker must. */
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
): Promise<SetupConnectResult> {
  const before = await getSetupState(ctx, principal, deps.setup, deps.agent);
  const agent = connectingAgentOf(before);
  const move = async (next: SetupConnectMove) =>
    moveSetupConnect(ctx, principal, next, deps.setup, deps.agent);

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
    const state = await move({ kind: "connected", agentId: agent.id, connectionId: connection.id });
    return { state, connected: true };
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
    case "connected": {
      const state = await move({
        kind: "connected",
        agentId: agent.id,
        connectionId: routing.connection.id,
      });
      return { state, connected: true };
    }
    case "connection":
    case "scope": {
      await move({ kind: "ask", agentId: agent.id, pendingActionId: routing.pendingActionId });
      // The routing may answer an ask already answered and not yet taken (GRA-203): read it now,
      // so a person who answered it elsewhere is not shown a settled card.
      return learnSetupConnection(ctx, principal, deps);
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

export async function learnSetupConnection(
  ctx: ServiceContext,
  principal: Principal,
  deps: Pick<SetupConnectDeps, "setup" | "agent" | "pendingAction">,
): Promise<SetupConnectResult> {
  const record = await deps.setup.findSetup(ctx.db, principal.personId);
  const askId = record?.step === "connect" ? record.pendingActionId : null;
  if (!record || !askId) {
    return { state: await getSetupState(ctx, principal, deps.setup, deps.agent), connected: false };
  }
  const row = await getPendingActionForPerson(ctx, principal, askId, deps.pendingAction);
  const verdict = askVerdict(row, record.agentId, deps.pendingAction.now());
  if (verdict === "open" || !record.agentId) {
    return { state: await getSetupState(ctx, principal, deps.setup, deps.agent), connected: false };
  }
  const state = await moveSetupConnect(
    ctx,
    principal,
    verdict === "closed"
      ? { kind: "reopen", askId }
      : { kind: "connected", agentId: record.agentId, connectionId: verdict.connectionId, askId },
    deps.setup,
    deps.agent,
  );
  return { state, connected: verdict !== "closed" && state.setup?.step === "goal" };
}
