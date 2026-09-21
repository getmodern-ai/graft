import type { AskCard } from "@graft/ask-card/shape";
import { getAgent } from "@graft/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_CARD_HOSTS, redirectsOnCardHosts } from "./ask-card";
import type { SessionContext } from "./context";
import { isAwaitingAnswer, toolAwaiting, toolAwaitingOrError, withCard } from "./result";

/**
 * Whether the session's client renders the ask card and hides its app-only tools — the card gate's
 * client half (`tools/card-gate.ts`, GRA-84; ADR 0006 as amended 2026-09-18), factored out so the
 * awaiting results can read the same verdict (GRA-120). One signal, and it is the registration's:
 * the agent is one a chat product holds over OAuth (`connected_via_client_id`, ADR 0018) **and**
 * every redirect URI its client registered is on a card host (`GRAFT_CARD_HOSTS`). A static-token
 * agent's harness renders no card; an OAuth client nothing vouches for is not assumed to.
 *
 * The client's own `initialize` is not the second signal it was until 2026-09-21: a client writes
 * that handshake itself and nothing lets a server check it, so it admitted exactly the clients
 * nobody vouched for (ADR 0006 as amended 2026-09-21, GRA-150).
 * `SessionContext.uiExtensionDeclared` is still read, as an observation on the call's wide event,
 * and decides nothing.
 *
 * **Memoised per session.** The agent's client and the session's capabilities do not change while
 * the session lives, and an awaiting result is built on every waiting call, so the agent row and
 * the client row are read once per session rather than once per result. A verdict that failed to
 * be reached (a thrown read) is not kept; the next call reads again.
 */
const verdicts = new WeakMap<SessionContext, Promise<boolean>>();

export function clientRendersCards(session: SessionContext): Promise<boolean> {
  const held = verdicts.get(session);
  if (held) return held;
  const judged = judgeClient(session);
  verdicts.set(session, judged);
  judged.catch(() => verdicts.delete(session));
  return judged;
}

async function judgeClient(session: SessionContext): Promise<boolean> {
  const { ctx, principal, scope, deps } = session;
  const agent = await getAgent(ctx, principal, scope.agentId, deps.agent);
  if (!agent?.connectedVia) return false;
  const client = await deps.findMcpClient(ctx.db, agent.connectedVia.clientId);
  return (
    client !== null &&
    redirectsOnCardHosts(client.redirectUris, deps.cardHosts ?? DEFAULT_CARD_HOSTS)
  );
}

/**
 * What an ask flow hands back in place of the tool's result: the body — an awaiting answer, or a
 * refusal — and, for an awaiting answer, the card a host renders and the message in its card form
 * (`handoff-message.ts`). `GateOutcome`, `ConnectionRequestOutcome` and `AuthoredRunAnswer` all
 * carry this shape on their not-a-result branch.
 */
export type AskOutcome = {
  answer: Record<string, unknown>;
  card?: AskCard;
  cardMessage?: string;
};

/**
 * An ask flow's outcome onto the wire, for one session (GRA-120). An awaiting answer for a client
 * that renders the card goes out with `message` in the card form and `cardShown: true` beside
 * `url` — in the text block the model reads and in `structuredContent` alike — so the model says
 * the person answers on the card and keeps the url for one who cannot see it. Everything else —
 * a static-token agent's, a client nothing vouches for, a refusal — goes out exactly as before:
 * awaiting as a result, anything else as an error (`result.ts`'s `toolAwaitingOrError`), the card
 * beside it where there is one. `url`, `reason`, `pendingActionId` and `expiresAt` never change.
 */
export async function toolAskResult(
  session: SessionContext,
  outcome: AskOutcome,
): Promise<CallToolResult> {
  const { answer, card, cardMessage } = outcome;
  if (card && cardMessage && isAwaitingAnswer(answer) && (await clientRendersCards(session))) {
    return withCard(toolAwaiting({ ...answer, message: cardMessage, cardShown: true }), card);
  }
  return withCard(toolAwaitingOrError(answer), card);
}
