import { START_LINK_TOOL, type StartLinkResult } from "@graft/ask-card/shape";
import { ServiceError } from "@graft/core";

import { APP_ONLY_TOOL_META } from "../ask-card";
import { isProviderLinkFallback, mintProviderLink, proposalOfLinkAsk } from "../provider-link";
import { toolRefusal, toolResult } from "../result";
import {
  admitCardCall,
  CARD_NOT_AVAILABLE,
  CONSOLE_IS_THE_PLACE,
  readPendingActionId,
} from "./card-gate";
import type { MetaTool } from "./meta";

/**
 * `start_link` — the tool the ask card calls to start a link provider's connect from the chat
 * (GRA-117; ADR 0006 as amended 2026-09-19). A vendor a link provider covers is connected by a
 * sign-in on the provider's page, which until now only the console could open: it minted the
 * provider's link with the person's session (`POST /api/pending-actions/:id/link`) and
 * opened a popup. The card has no session — only the agent's — so this app-only tool mints the
 * same link through the same function (`../provider-link.ts`'s `mintProviderLink`) under the card
 * gate (`./card-gate.ts`: an OAuth agent of a chat product known to hide app-only tools, its own
 * open ask), and the card opens what it answers with `ui/open-link`. The link's return is the
 * server's route unchanged — it makes the row and answers the ask — with `from=card` copied onto
 * its console redirect so that page closes itself; the card learns the outcome by polling
 * `ask_status`.
 *
 * Only a `connection` ask whose provider connects with a link is served: the keyring's asks are
 * the form's, and `card_not_available` says so. The build choice rides the signed state, as it
 * does from the console's button.
 */

export const START_LINK = START_LINK_TOOL;

export const startLink: MetaTool = {
  definition: {
    name: START_LINK,
    description:
      "Called by Graft's ask card on a chat product that renders it: mints a connection provider's sign-in link for one of this agent's open connection asks and answers { url, expiresAt, provider }, which the card opens in a popup. " +
      "Takes pendingActionId, the ask the awaiting result named, and approveBuild, whether the asking agent may build tools against the connection once it is made. " +
      "Serves only an ask routed to a provider that connects with a link; the link's return makes the connection and answers the ask. App-only (_meta.ui.visibility app), so a host hides it from the model. " +
      "Refuses card_not_available for a static-token agent or an ask another provider serves, ask_not_found for another agent's ask, answered or expired for a closed one.",
    inputSchema: {
      type: "object",
      properties: {
        pendingActionId: {
          type: "string",
          description: "The ask's id, as the awaiting result named it.",
        },
        approveBuild: {
          type: "boolean",
          description:
            "Record the asking agent's build approval with the connection the return makes (default false).",
        },
      },
      required: ["pendingActionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: APP_ONLY_TOOL_META,
  },
  handle: async (args, session) => {
    const pendingActionId = readPendingActionId(args);
    if (typeof pendingActionId !== "string") {
      return toolRefusal("input_invalid", pendingActionId.error);
    }
    if (args.approveBuild !== undefined && typeof args.approveBuild !== "boolean") {
      return toolRefusal("input_invalid", "approveBuild must be a boolean when given");
    }
    const admitted = await admitCardCall(session, pendingActionId);
    if ("refused" in admitted) return admitted.refused;

    const { deps, principal } = session;
    if (!deps.authUrl) {
      return toolRefusal(
        CARD_NOT_AVAILABLE,
        `This server has no public URL configured, so a provider's link cannot be started from the card. ${CONSOLE_IS_THE_PLACE}`,
      );
    }
    // A link provider's ask, and nothing else: the form's asks keep the console (ADR 0004).
    let started: Awaited<ReturnType<typeof mintProviderLink>>;
    try {
      const proposal = proposalOfLinkAsk(admitted.row);
      if (proposal.providerConnect !== "link") {
        return toolRefusal(
          CARD_NOT_AVAILABLE,
          `This connection is not a provider's link: ${
            proposal.providerConnect === "none"
              ? "it connects with no person step"
              : "its credential is entered in the console, never through a card or a chat"
          }. ${CONSOLE_IS_THE_PLACE}`,
        );
      }
      started = await mintProviderLink(
        principal,
        admitted.row,
        {
          db: deps.db,
          connection: deps.connection,
          pendingAction: deps.pendingAction,
          handoff: deps.handoff,
          authUrl: deps.authUrl,
        },
        { approveBuild: args.approveBuild === true, fromCard: true },
      );
    } catch (error) {
      if (error instanceof ServiceError) {
        return toolRefusal(CARD_NOT_AVAILABLE, `${error.message}. ${CONSOLE_IS_THE_PLACE}`);
      }
      throw error;
    }
    if (isProviderLinkFallback(started)) {
      // The provider stepped aside and the ask is the keyring's form now (GRA-147): the card's
      // console button lands on that form, so the refusal is the one the card answers with it.
      return toolRefusal(
        CARD_NOT_AVAILABLE,
        `${started.provider} could not start its sign-in (${started.message}), so this connection is made on Graft's own page instead. ${CONSOLE_IS_THE_PLACE}`,
      );
    }
    const result: StartLinkResult = {
      url: started.url,
      expiresAt: started.expiresAt.toISOString(),
      provider: started.provider,
    };
    return toolResult(result);
  },
};
