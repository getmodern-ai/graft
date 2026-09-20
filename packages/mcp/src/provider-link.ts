import {
  type ConnectionDeps,
  FROM_CARD,
  FROM_CARD_PARAM,
  KEYRING_PROVIDER,
  LINK_OUTCOME_PARAM,
  LINK_STATE_PARAM,
  LINK_STATE_TTL_MS,
  linkCallbackUri,
  type PendingActionDeps,
  type Principal,
  providerLinkOf,
  providerNamed,
  ServiceError,
  signLinkState,
} from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";

import { CONNECTION_ASK_KIND, type ConnectionProposalPayload } from "./connection-request";
import type { HandoffConfig } from "./handoff";

/**
 * Minting a link provider's link for a connection ask — the one-click connect (ADR 0019; GRA-59)
 * — factored out of the server's route so the ask card's `start_link` tool mints exactly what the
 * console's button mints (GRA-117), as `ask-answer.ts` did for the answers (GRA-104). Two doors,
 * one link: the provider is the one the ask was routed to, never one the caller names; the two
 * URIs the provider sends the browser back to are the server's return route with a **signed
 * state** in the query — the ask, the person, the provider, an expiry, a nonce, under
 * `GRAFT_HANDOFF_SECRET` (`@graft/core`'s `link-state.ts`) — and the person's build choice rides
 * the state, signed, because the connection it is about does not exist until the return.
 *
 * What differs by door is one query parameter on the return, `from=card`: the return route copies
 * it onto its redirect to the console's `/link/callback`, whose page then closes itself, since
 * the card the person is looking at settles on its own by polling `ask_status`
 * (`@graft/core`'s `card.rules.ts`). It is not in the signed state on purpose — nothing turns on
 * it but whether a page closes — and the return route reads it from its own query alone.
 *
 * The caller has already read the ask and judged it open and its own: the server's route with the
 * person's session, the tool with the agent's scope and the card gate (`tools/card-gate.ts`).
 * This function checks what remains — that the row is a connection ask carrying a proposal a link
 * provider covers — and refuses the keyring's asks with a sentence, as the route always did.
 */

export type ProviderLinkMintDeps = {
  connection: ConnectionDeps;
  pendingAction: PendingActionDeps;
  handoff: Pick<HandoffConfig, "secret">;
  /** `GRAFT_AUTH_URL` — the return URI is `linkCallbackUri(authUrl)`, on the server's own origin. */
  authUrl: string;
};

/** What the person chose on the card before pressing the button (GRA-75), and which door it was. */
export type ProviderLinkChoices = {
  /** Record the asking agent's build approval with the connection the return makes. */
  approveBuild?: boolean;
  /** The ask card minted it (GRA-117): the return's console page closes itself. */
  fromCard?: boolean;
};

export type StartedProviderLink = {
  /** What the console, or the card, opens in the person's browser. */
  url: string;
  /** Until when the link is honoured: the provider's expiry, or the state's, whichever is sooner. */
  expiresAt: Date;
  provider: string;
};

/** The proposal on a connection ask, as `request_connection` recorded it. */
export function proposalOfLinkAsk(action: PendingActionRow): ConnectionProposalPayload {
  if (action.kind !== CONNECTION_ASK_KIND) {
    throw new ServiceError(
      "BAD_REQUEST",
      `This action is a ${action.kind} ask, not a ${CONNECTION_ASK_KIND} one`,
    );
  }
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
 * Mint the link for an open connection ask the caller holds. `BAD_REQUEST` names the reason when
 * the ask is not a link provider's: the keyring's asks are the form's, a provider the deployment
 * no longer enables cannot start anything.
 */
export async function mintProviderLink(
  principal: Principal,
  action: PendingActionRow,
  deps: ProviderLinkMintDeps,
  choices: ProviderLinkChoices = {},
): Promise<StartedProviderLink> {
  const proposal = proposalOfLinkAsk(action);
  const provider = providerNamed(deps.connection.providers, proposal.provider);
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

  const now = deps.pendingAction.now();
  const expiresAt = new Date(now.getTime() + LINK_STATE_TTL_MS);
  const state = signLinkState(
    {
      pendingActionId: action.id,
      personId: principal.personId,
      provider: provider.name,
      expiresAt: expiresAt.getTime(),
      nonce: deps.connection.newId(),
      ...(choices.approveBuild ? { approveBuild: true } : {}),
    },
    deps.handoff.secret,
  );
  const returnTo = (outcome: "success" | "error") => {
    const url = new URL(linkCallbackUri(deps.authUrl));
    url.searchParams.set(LINK_STATE_PARAM, state);
    url.searchParams.set(LINK_OUTCOME_PARAM, outcome);
    if (choices.fromCard) url.searchParams.set(FROM_CARD_PARAM, FROM_CARD);
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
