import {
  type AgentDeps,
  addConnectionToAgentScope,
  answerPendingAction,
  type ConnectionDeps,
  connectThroughProvider,
  getPendingActionForPerson,
  KEYRING_PROVIDER,
  LINK_OUTCOME_PARAM,
  LINK_STATE_PARAM,
  LINK_STATE_TTL_MS,
  type LinkCallbackOutcome,
  linkCallbackRedirect,
  linkCallbackUri,
  orNotFound,
  type PendingActionDeps,
  type Principal,
  providerLinkOf,
  providerNamed,
  type ServiceContext,
  ServiceError,
  signLinkState,
  verifyLinkState,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import {
  CONNECTION_ASK_KIND,
  type ConnectionProposalPayload,
  type HandoffConfig,
} from "@graft/mcp";
import { Hono } from "hono";

/**
 * A provider's **link** — the one-click connect (ADR 0019; GRA-59) — as the server runs it, in two
 * HTTP ends patterned on the OAuth consent's (`oauth.ts`, GRA-48). `startProviderLink` is what
 * `POST /api/pending-actions/:id/link` does with the person's session: the ask names the provider
 * the proposal was routed to, the provider mints the link the console opens, and the two URIs the
 * provider sends the browser back to are this server's return route with a **signed state** in the
 * query — the ask, the person, the provider, an expiry, a nonce, under `GRAFT_HANDOFF_SECRET`
 * (`@graft/core`'s `link-state.ts`). `GET /api/providers/link/callback` is that return, **with no
 * session**: the browser arrives from the provider's page, so the state is the whole authority.
 *
 * What the return trusts is narrower than the redirect. The provider chose which of the two URIs
 * to send the browser to, and that word (`outcome`) is read only to phrase a failure; a success is
 * never taken from it. The connection is made only once the provider has been *asked* what the
 * person connected (`ProviderLink.complete` — for Pipedream, its accounts list for this person and
 * app, minus every account a connection of theirs already names) and answered a reference. Then,
 * in one transaction: the row (`connectThroughProvider`, which reconnects a revoked row of the same
 * vendor in place), the requesting agent's scope, and the ask's answer `{ connectionId }` so the
 * waiting `request_connection` says connected — exactly what the form's submit records (GRA-28).
 * Every outcome is one redirect to the console's `/link/callback` route with the outcome in its
 * query (`link.rules.ts`), a status word, the ask, the connection when there is one and a sentence
 * — never the state, a token, or anything the provider answered. A failed or abandoned link leaves
 * the ask open with that sentence, so the person can press the button again.
 *
 * Nothing here touches a credential: a link provider's connection holds none in Graft, and the
 * proxy relays every call for it to the provider's upstream. That is the property this route
 * exists to keep, and the reason there is no vault in its options.
 */

export type ProviderLinkRouteOptions = {
  db: DbOrTx;
  connection: ConnectionDeps;
  agent: AgentDeps;
  pendingAction: PendingActionDeps;
  handoff: Pick<HandoffConfig, "consoleUrl" | "secret">;
  /** `GRAFT_AUTH_URL` — the return URI is `linkCallbackUri(authUrl)`, on the server's own origin. */
  authUrl: string;
};

export type StartedProviderLink = {
  /** What the console opens in a popup. */
  url: string;
  /** Until when the link is honoured: the provider's expiry, or the state's, whichever is sooner. */
  expiresAt: Date;
  provider: string;
};

/** The ask a link is for: the person's, a connection ask, still open — the submit routes' own rules. */
function openConnectionAsk(
  row: PendingActionRow | null,
  now: Date,
): PendingActionRow & { payload: PendingActionRow["payload"] } {
  const action = orNotFound(row, "Pending action not found");
  if (action.kind !== CONNECTION_ASK_KIND) {
    throw new ServiceError(
      "BAD_REQUEST",
      `This action is a ${action.kind} ask, not a ${CONNECTION_ASK_KIND} one`,
    );
  }
  if (action.answeredAt || action.consumedAt) {
    throw new ServiceError("CONFLICT", "This action has already been answered");
  }
  if (action.expiresAt.getTime() <= now.getTime()) {
    throw new ServiceError(
      "GONE",
      "This action has expired — the agent will ask again if it still needs to",
    );
  }
  return action;
}

/** The proposal on a connection ask, as `request_connection` recorded it. */
function proposalOf(action: PendingActionRow): ConnectionProposalPayload {
  const payload = action.payload as Partial<ConnectionProposalPayload>;
  if (
    typeof payload.vendor !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.primaryHost !== "string" ||
    !Array.isArray(payload.hosts)
  ) {
    throw new ServiceError("BAD_REQUEST", "This connection ask carries no proposal");
  }
  return {
    ...payload,
    provider: typeof payload.provider === "string" ? payload.provider : KEYRING_PROVIDER,
  } as ConnectionProposalPayload;
}

/**
 * Mint the link for a connection ask the person is looking at. The provider is the one the ask was
 * routed to — never one the body names — and it has to connect with a link; the keyring's asks are
 * the form's and are refused here with a sentence.
 */
export async function startProviderLink(
  ctx: ServiceContext,
  principal: Principal,
  pendingActionId: string,
  options: ProviderLinkRouteOptions,
): Promise<StartedProviderLink> {
  const now = options.pendingAction.now();
  const action = openConnectionAsk(
    await getPendingActionForPerson(ctx, principal, pendingActionId, options.pendingAction),
    now,
  );
  const proposal = proposalOf(action);
  const provider = providerNamed(options.connection.providers, proposal.provider);
  if (!provider) {
    throw new ServiceError(
      "BAD_REQUEST",
      `This ask was routed to the ${proposal.provider} provider, which this deployment no longer enables`,
    );
  }
  const link = providerLinkOf(provider);
  if (!link) {
    throw new ServiceError(
      "BAD_REQUEST",
      `The ${provider.name} provider connects a vendor with ${provider.connect.kind === "form" ? "a credential entered in the console" : "no person step"}, not with a link`,
    );
  }

  const expiresAt = new Date(now.getTime() + LINK_STATE_TTL_MS);
  const state = signLinkState(
    {
      pendingActionId: action.id,
      personId: principal.personId,
      provider: provider.name,
      expiresAt: expiresAt.getTime(),
      nonce: options.connection.newId(),
    },
    options.handoff.secret,
  );
  const returnTo = (outcome: "success" | "error") => {
    const url = new URL(linkCallbackUri(options.authUrl));
    url.searchParams.set(LINK_STATE_PARAM, state);
    url.searchParams.set(LINK_OUTCOME_PARAM, outcome);
    return url.toString();
  };
  const started = await link.start({
    personId: principal.personId,
    vendor: proposal.vendor,
    hosts: proposal.hosts,
    returnTo: { success: returnTo("success"), error: returnTo("error") },
  });
  return {
    url: started.url,
    expiresAt: started.expiresAt.getTime() < expiresAt.getTime() ? started.expiresAt : expiresAt,
    provider: provider.name,
  };
}

export function createProviderLinkRoutes(options: ProviderLinkRouteOptions): Hono {
  const routes = new Hono();
  const ctx: ServiceContext = { db: options.db };

  /**
   * Where the provider's page sends the browser back. Every answer — the success and each refusal
   * — is the same redirect to the console's callback route with the outcome in its query; a person
   * is reading it, so a refusal says what to do next. One redirect status for every outcome, as
   * the consent's callback does (`oauth.ts`), because the browser follows it whatever it says.
   */
  routes.get("/callback", async (c) => {
    const query = c.req.query();
    const now = options.pendingAction.now();
    const land = (outcome: LinkCallbackOutcome) =>
      c.redirect(linkCallbackRedirect(options.handoff.consoleUrl, outcome), 302);
    const failed = (
      message: string,
      pendingActionId: string | null = null,
      status: LinkCallbackOutcome["status"] = "failed",
    ) => land({ status, pendingActionId, connectionId: null, message });

    const verdict = verifyLinkState(query[LINK_STATE_PARAM], options.handoff.secret, now);
    if (!verdict.ok) return failed(verdict.message);
    const { pendingActionId, personId } = verdict.payload;
    const principal: Principal = { personId };

    const row = await getPendingActionForPerson(
      ctx,
      principal,
      pendingActionId,
      options.pendingAction,
    );
    if (!row || row.kind !== CONNECTION_ASK_KIND) {
      return failed("The ask this link was for no longer exists.", pendingActionId);
    }
    // The browser may land twice — a refresh, a second tab. An ask already answered by this link
    // is connected, and says so rather than making a second connection.
    if (row.answeredAt && typeof row.answer?.connectionId === "string") {
      return land({
        status: "connected",
        pendingActionId,
        connectionId: row.answer.connectionId,
        message: "This connection is already made — the console updates on its own.",
      });
    }
    if (row.answeredAt || row.consumedAt) {
      return failed(
        "This ask was already answered in the console; nothing more was connected.",
        pendingActionId,
      );
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      return failed(
        "This ask has expired — the agent will ask again if it still needs to, and the new ask has a fresh link.",
        pendingActionId,
      );
    }

    let proposal: ConnectionProposalPayload;
    try {
      proposal = proposalOf(row);
    } catch {
      return failed("This connection ask carries no proposal.", pendingActionId);
    }
    if (proposal.provider !== verdict.payload.provider) {
      return failed(
        "This link was minted for another provider than the ask names.",
        pendingActionId,
      );
    }
    const provider = providerNamed(options.connection.providers, proposal.provider);
    const link = provider ? providerLinkOf(provider) : null;
    if (!provider || !link) {
      return failed(
        `The ${proposal.provider} provider is not enabled on this deployment, so nothing was connected.`,
        pendingActionId,
      );
    }

    // The provider's own word for a failure — the person closed the sign-in, or the vendor refused
    // it. Read to phrase the sentence and for nothing else; the ask stays open for another try.
    if (query[LINK_OUTCOME_PARAM] === "error") {
      return failed(
        `${provider.name} reported that the sign-in at ${proposal.vendor} did not complete — nothing was connected. Press Connect on the ask to try again.`,
        pendingActionId,
      );
    }

    // Never the redirect's say-so: ask the provider what it now holds for this person that no
    // connection of theirs already names. The rows, not the public shape: the reference is the
    // provider's and the public shape does not carry it.
    const takenRefs = (await options.connection.listConnections(ctx.db, personId)).flatMap((row) =>
      row.provider === provider.name && row.providerRef ? [row.providerRef] : [],
    );
    let outcome: Awaited<ReturnType<typeof link.complete>>;
    try {
      outcome = await link.complete({
        personId,
        vendor: proposal.vendor,
        hosts: proposal.hosts,
        takenRefs,
      });
    } catch {
      return failed(
        `${provider.name} could not be asked which account was connected — nothing was connected. Press Connect on the ask to try again.`,
        pendingActionId,
      );
    }
    if (!outcome.ok) return failed(outcome.message, pendingActionId);

    let connectionId: string;
    try {
      connectionId = await ctx.db.transaction(async (tx) => {
        const scoped: ServiceContext = { db: tx };
        const connection = await connectThroughProvider(
          scoped,
          principal,
          {
            provider,
            vendor: proposal.vendor,
            displayName: proposal.displayName,
            primaryHost: proposal.primaryHost,
            hosts: proposal.hosts,
            ref: outcome.ref,
          },
          options.connection,
        );
        // The requesting agent's scope, and no other's (ADR 0007), as the form's submit does.
        await addConnectionToAgentScope(
          scoped,
          principal,
          row.agentId,
          connection.id,
          options.agent,
        );
        // The waiting `request_connection` takes `{ connectionId }` as the answer (GRA-28). An ask
        // answered, expired or closed meanwhile does not undo the connection — it is connected
        // either way — so those refusals are read and let go.
        try {
          await answerPendingAction(
            scoped,
            principal,
            row.id,
            { connectionId: connection.id },
            options.pendingAction,
          );
        } catch (error) {
          if (
            !(error instanceof ServiceError) ||
            !["CONFLICT", "GONE", "NOT_FOUND"].includes(error.code)
          ) {
            throw error;
          }
        }
        return connection.id;
      });
    } catch (error) {
      // Two landings of one link claimed the same account and the database let one in
      // (`connection_provider_ref_idx`): the ask says what the other did. Read a few times over
      // half a second — the winner's transaction is committing as the loser's is refused.
      if (error instanceof ServiceError && error.code === "CONFLICT") {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const settled = await getPendingActionForPerson(
            ctx,
            principal,
            pendingActionId,
            options.pendingAction,
          );
          if (settled?.answeredAt && typeof settled.answer?.connectionId === "string") {
            return land({
              status: "connected",
              pendingActionId,
              connectionId: settled.answer.connectionId,
              message: `${proposal.displayName} is connected through ${provider.name} — the console updates on its own.`,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      const detail =
        error instanceof ServiceError ? error.message : "the connection could not be made";
      return failed(
        `${proposal.displayName} was connected at ${provider.name} but not in Graft: ${detail}. Press Connect on the ask to try again.`,
        pendingActionId,
      );
    }

    return land({
      status: "connected",
      pendingActionId,
      connectionId,
      message: `${proposal.displayName} is connected through ${provider.name}${outcome.label ? ` as ${outcome.label}` : ""} — the console updates on its own.`,
    });
  });

  return routes;
}
