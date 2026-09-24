import {
  type AcquireJobDeps,
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
  type SetupMoveResult,
  type SetupState,
  type SetupVendorOption,
  STARTER_VENDORS,
  type StarterVendor,
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
 *   connection the person made with the ordinary form (*Another integration*) is added to the agent's
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
  /** The job a record that went back still holds, read to judge whether a choice leaves it running. */
  acquireJob?: Pick<AcquireJobDeps, "findAcquireJob">;
};

/** What a connect or a read did, so the route can count the connect step completing. */
export type SetupConnectResult = { state: SetupState; connected: boolean };

/**
 * `POST /api/setup/connect`: a starter by its id, or the connection *Another integration*'s form made.
 * `discardJob` is the person agreeing to leave behind the job a record that went back still holds
 * while it runs (GRA-215), which a choice of another vendor does.
 */
export type SetupConnectInput = ({ starterId: string } | { connectionId: string }) & {
  discardJob?: boolean;
};

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
  if (!input.discardJob) await refuseLeavingJobRunning(ctx, principal, before, input, deps);

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
    return connectedBy(
      await moveSetupConnect(
        ctx,
        principal,
        { kind: "connected", agentId: agent.id, connectionId: connection.id },
        deps.setup,
        deps.agent,
      ),
    );
  }

  const starter = starterVendorOf(input.starterId);
  if (!starter) throw new ServiceError("NOT_FOUND", "No starter integration has that id");
  // The same starter can still route to another row than the one the job was acquired against
  // (Greptile on #171): that replaces the connection as surely as another vendor does.
  const held = input.discardJob ? undefined : { state: before };
  return routeStarter(ctx, principal, agent.id, starter, deps, undefined, held);
}

/**
 * A record that went back to the vendor step keeps the job it holds (GRA-215, `moveSetupBack`),
 * and the connect moves drop that job with the connection it was acquired against. While the job
 * still runs, a choice that would replace the connection is refused `job_running` until it says
 * `discardJob`, so the console asks first; the same vendor again keeps the job, and a job that
 * finished is left without asking. Judged here on the vendor, since the routing decides the row,
 * and judged again on the row the routing resolves (`routeStarter`'s `held`).
 */
async function refuseLeavingJobRunning(
  ctx: ServiceContext,
  principal: Principal,
  state: SetupState,
  input: SetupConnectInput,
  deps: SetupConnectDeps,
): Promise<void> {
  const held = state.setup?.connectionId;
  if (!held || !state.setup?.acquireJobId) return;
  if ("connectionId" in input) {
    if (input.connectionId === held) return;
  } else {
    const current = await getConnection(ctx, principal, held, deps.connection);
    if (current && current.vendor === starterVendorOf(input.starterId)?.vendor) return;
  }
  await refuseReplacingRunningJob(ctx, principal, state, deps);
}

/**
 * Refuse `job_running` when the record holds a job that is still queued or running: the one check
 * behind both the choice judged on its vendor before routing and the row the routing resolved.
 */
async function refuseReplacingRunningJob(
  ctx: ServiceContext,
  principal: Principal,
  state: SetupState,
  deps: SetupConnectDeps,
): Promise<void> {
  const record = state.setup;
  if (!record?.acquireJobId || !state.agent || !deps.acquireJob) return;
  const job = await deps.acquireJob.findAcquireJob(
    ctx.db,
    { personId: principal.personId, agentId: state.agent.id },
    record.acquireJobId,
  );
  if (job && (job.status === "queued" || job.status === "running")) {
    throw new ServiceError(
      "CONFLICT",
      "The job Setup started is still acquiring a tool for the connection you chose before; another one leaves it behind",
      { details: { reason: "job_running", acquireJobId: job.id } },
    );
  }
}

/** A `connected` move's result as the route counts it: the step completes only where it moved. */
function connectedBy({ state, moved }: SetupMoveResult): SetupConnectResult {
  return { state, connected: moved };
}

/**
 * Route the starter's proposal as the agent and move the record on the answer. `vendorAt` says the
 * ask the first routing handed back was answered about a connection that no longer stands, was
 * taken, and the record went back to the vendor step, last written at that instant: this second
 * routing's move lands only on the record as it was seen then (`fromVendorAt`), so the person's
 * choice in flight is kept over a read that reopened the record, and any choice another tab made
 * since is kept over this one, even one that closed and left the record on `vendor` again.
 *
 * `held` is the state the request read before routing, given unless the person said `discardJob`:
 * a routing that resolves a connection other than the one the record holds, while the record's
 * job still runs, is refused `job_running` before the move, as a choice of another vendor is,
 * rather than dropping the job with the connection it was acquired against.
 */
async function routeStarter(
  ctx: ServiceContext,
  principal: Principal,
  agentId: string,
  starter: StarterVendor,
  deps: SetupConnectDeps,
  vendorAt?: Date,
  held?: { state: SetupState },
): Promise<SetupConnectResult> {
  const move = (next: SetupConnectMove) =>
    moveSetupConnect(ctx, principal, next, deps.setup, deps.agent);
  const routing = await routeConnectionProposal(
    ctx,
    { personId: principal.personId, agentId },
    starterProposal(starter),
    deps.routing,
    deps.notifier,
  );
  switch (routing.kind) {
    case "refused":
      throw refusal(routing);
    case "connected":
      if (held && held.state.setup?.connectionId !== routing.connection.id) {
        await refuseReplacingRunningJob(ctx, principal, held.state, deps);
      }
      return connectedBy(
        await move({
          kind: "connected",
          agentId,
          connectionId: routing.connection.id,
          fromVendorAt: vendorAt,
        }),
      );
    case "connection":
    case "scope": {
      const pendingActionId = routing.pendingActionId;
      const heldConnection = held?.state.setup?.acquireJobId ? held.state.setup.connectionId : null;
      if (held && heldConnection) {
        // A re-used ask may already be answered with another row, and the read below would move
        // the record onto it (GRA-203); an open ask for a new row would, once answered.
        const row = await getPendingActionForPerson(
          ctx,
          principal,
          pendingActionId,
          deps.pendingAction,
        );
        if (askSettlesOn(row, agentId, deps.pendingAction.now()) !== heldConnection) {
          await refuseReplacingRunningJob(ctx, principal, held.state, deps);
        }
      }
      const asked = await move({ kind: "ask", agentId, pendingActionId, fromVendorAt: vendorAt });
      if (!asked.moved) return { state: asked.state, connected: false };
      // The routing may answer an ask already answered and not yet taken (GRA-203): read it now,
      // so a person who answered it elsewhere is not shown a settled card.
      const learned = await learnFromRecord(ctx, principal, deps, pendingActionId);
      // An answer about a connection that no longer stands is taken, by this read or another, so
      // routing again goes past it to the person's rows as they are: once, since a taken ask is
      // never re-used, and only where the record went back to the vendor step rather than on to
      // another tab's choice.
      const seen = learned.result.state.setup;
      if (learned.stale && !vendorAt && seen?.step === "vendor") {
        return routeStarter(ctx, principal, agentId, starter, deps, seen.updatedAt, held);
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
 * The connection an ask the routing handed back settles the record on: the one its answer names,
 * the row an open ask is about (a scope ask or a widening, which carry it in `connection_id`), or
 * none (an open ask for a new row, or a closed one, which reopens the record without a connection).
 */
function askSettlesOn(row: PendingActionRow | null, agentId: string, now: Date): string | null {
  const verdict = askVerdict(row, agentId, now);
  if (verdict === "closed") return null;
  if (verdict === "open") return row?.connectionId ?? null;
  return verdict.connectionId;
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

/**
 * The read behind `learnSetupConnection`, saying too whether the ask it judged was answered about
 * a connection that no longer stands (`stale`). The connect route passes `opened`, the ask it just
 * put the record on, and that ask is judged even where another read took the record off it
 * meanwhile, so the route learns it was stale and may route past it; a record another tab moved on
 * is never moved by that judgement.
 */
async function learnFromRecord(
  ctx: ServiceContext,
  principal: Principal,
  deps: LearnDeps,
  opened?: string,
): Promise<{ result: SetupConnectResult; stale: boolean }> {
  const before = await getSetupState(ctx, principal, deps.setup, deps.agent);
  const record = before.setup;
  const agentId = before.agent?.id;
  const unchanged = { result: { state: before, connected: false }, stale: false };
  if (!record || !agentId) return unchanged;

  if (!opened && record.step === "goal" && record.connectionId) {
    const connectionId = record.connectionId;
    if (await standsForAgent(ctx, principal, agentId, connectionId, deps)) return unchanged;
    // Judged again under the lock: a read that saw the connection gone may land after the person
    // restored it (another read took the record back to vendor, and the same connection was
    // chosen again), and the record on goal with it is then right.
    const { state } = await moveSetupConnect(
      ctx,
      principal,
      { kind: "lost", connectionId },
      deps.setup,
      deps.agent,
      async (scoped) => !(await standsForAgent(scoped, principal, agentId, connectionId, deps)),
    );
    return { result: { state, connected: false }, stale: false };
  }

  const waiting = record.step === "connect" ? record.pendingActionId : null;
  const askId = opened ?? waiting;
  if (!askId) return unchanged;
  const row = await getPendingActionForPerson(ctx, principal, askId, deps.pendingAction);
  const now = deps.pendingAction.now();
  const verdict = askVerdict(row, agentId, now);
  if (verdict === "open") return unchanged;
  // An answer is history: the connection it names may have been revoked or taken out of the scope
  // since, and a record on `goal` with it would build against nothing. Such an answer is taken, so
  // the routing stops handing it back by its proposal key; the agent's own request_connection
  // would find the dead row in its settle, and now routes afresh instead. The take answers null
  // when the answer is already taken (by the agent's own call, or by a read before this one),
  // which is the same outcome: the answer is spent and the record goes back to the vendor step.
  const stale =
    verdict !== "closed" &&
    !(await standsForAgent(ctx, principal, agentId, verdict.connectionId, deps));
  const take = (db: ServiceContext["db"]) =>
    deps.pendingAction.consumePendingAction(
      db,
      { personId: principal.personId, agentId },
      askId,
      now,
    );
  if (askId !== waiting) {
    // The connect route's own ask, which the record no longer waits on: taken if stale, so the
    // route's second routing goes past it, and the record left as it stands.
    if (stale) await take(ctx.db);
    return { ...unchanged, stale };
  }
  const { state, moved } =
    verdict === "closed" || stale
      ? await moveSetupConnect(
          ctx,
          principal,
          { kind: "reopen", askId },
          deps.setup,
          deps.agent,
          // Under the lock, and only while the record still waits on this ask: two reads that both
          // judged it stale take it once between them, and neither is refused for the other's take.
          // Judged again there first: a re-consent, a new credential or a scope grant landing since
          // makes the answer good, and it is left for the next read to learn rather than spent.
          stale
            ? async (scoped) => {
                if (await standsForAgent(scoped, principal, agentId, verdict.connectionId, deps)) {
                  return false;
                }
                await take(scoped.db);
                return true;
              }
            : undefined,
        )
      : await moveSetupConnect(
          ctx,
          principal,
          { kind: "connected", agentId, connectionId: verdict.connectionId, askId },
          deps.setup,
          deps.agent,
        );
  const connected = moved && verdict !== "closed" && !stale;
  // A scope ask answered in the console grew the agent's list, and no waiting call settles to
  // announce it (`awaitScope` does, for an agent's own request_connection).
  if (connected && row?.kind === SCOPE_ASK_KIND) deps.notifier?.changed(agentId);
  return { result: { state, connected }, stale };
}
