import type { SetupCard } from "@graft/ask-card/shape";
import { getAgent, getSetupRecord, setupUrl, shouldOfferSetup } from "@graft/core";

import { clientRendersCards } from "./card-client";
import type { SessionContext } from "./context";
import { setupOfferMessage } from "./handoff-message";

/**
 * `find_tool`'s offer of Setup (GRA-210; GRA-202, *The in-chat door*; ADR 0024). A chat product's
 * agent on a fresh account has nothing to find and no vendor to name, so for an agent whose person
 * has no connection at all and whose Setup is neither completed nor skipped (`@graft/core`'s
 * `shouldOfferSetup`), `find_tool` answers `setup` beside `tools` and `connections`: the console
 * URL of the Setup page naming this agent (`setupUrl`, `/setup?agent=<id>`), so Setup adopts it
 * even among several, and one sentence in the handoff's shape (`handoff-message.ts`).
 *
 * **Not an ask.** No pending action stands behind the offer: nothing is signed, nothing expires,
 * nothing is answered by a later call. So the result stays a plain result, `isError` unset, and
 * `answer_ask` has nothing it could admit. For a client the server knows renders the card
 * (`clientRendersCards`, the same verdict the awaiting results read, GRA-120), the message takes
 * its card form, `cardShown: true` rides beside the `url`, and the card of kind `setup` goes on
 * `structuredContent.card` (`result.ts`'s `withCard`), with the button that opens the URL with
 * `from=card`. The console's Setup page, opened so, closes itself once Setup is finished.
 *
 * `connections` is the person's count, revoked rows included, which `find_tool` has already read,
 * so the record is read only when the count is zero.
 */

export type SetupOffer = {
  setup: { url: string; message: string; cardShown?: true };
  card?: SetupCard;
};

export async function setupOfferFor(
  session: SessionContext,
  connections: number,
): Promise<SetupOffer | null> {
  if (connections > 0) return null;
  const { ctx, principal, scope, deps } = session;
  const record = await getSetupRecord(ctx, principal, deps.setup);
  if (!shouldOfferSetup(record, { connections })) return null;
  const url = setupUrl(deps.handoff.consoleUrl, scope.agentId);
  if (!(await clientRendersCards(session))) {
    return { setup: { url, message: setupOfferMessage("console", url) } };
  }
  const agent = await getAgent(ctx, principal, scope.agentId, deps.agent);
  return {
    setup: { url, message: setupOfferMessage("card", url), cardShown: true },
    card: { kind: "setup", agentName: agent?.name ?? "This agent", url },
  };
}
