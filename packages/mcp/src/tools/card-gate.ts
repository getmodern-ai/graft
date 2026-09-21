import type { AnswerAskRefusalReason } from "@graft/ask-card/shape";
import { type AgentOutput, getAgent, getPendingAction } from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ASK_ANSWERED_MESSAGE, ASK_EXPIRED_MESSAGE } from "../ask-answer";
import { clientRendersCards } from "../card-client";
import type { SessionContext } from "../context";
import { toolRefusal } from "../result";

/**
 * The gate every app-only tool applies before it reads or writes anything (GRA-84; ADR 0006 as
 * amended 2026-09-18) — `answer_ask`'s first two guards, factored out once `start_link` and
 * `ask_status` joined it (GRA-117). Nothing on the wire proves a `tools/call` came from the card
 * rather than the model (the GRA-84 research, point 1), so the guard is Graft's own:
 *
 *   1. **The agent's client is one whose hiding of app-only tools is established.** The agent
 *      must be one a chat product holds over OAuth (`connected_via_client_id` set, ADR 0018) — a
 *      static-token agent's harness, Hermes or OpenClaw, renders no app, so a call from one can
 *      only be its model's — and that alone is not enough: ADR 0018 registers any client
 *      dynamically, and a naive one that lists app-only tools would let its model answer its own
 *      ask (Greptile on #71). So the registration must vouch for it too: **every redirect URI the
 *      client registered is on a card host** (`GRAFT_CARD_HOSTS`, default `claude.ai` and
 *      `chatgpt.com` — the callbacks the two products register; `McpDeps.cardHosts`), which a
 *      client cannot claim without controlling the callback its OAuth flow finishes on. Not that:
 *      `card_not_available`, the console is the place. A client's own declaration of the MCP Apps
 *      extension in `initialize` was a second signal until 2026-09-21 and is one no longer,
 *      because a client writes its own handshake (ADR 0006 as amended 2026-09-21, GRA-150). The
 *      verdict is `card-client.ts`'s `clientRendersCards`, held per session, which the awaiting
 *      results read too (GRA-120).
 *   2. **The ask is this agent's** (the agent-scoped read answers nothing for another's) and,
 *      where the tool acts on it, **open** (unanswered, untaken — `answered`) **and in time**
 *      (`expired`), in the console's words. `ask_status` reads a closed ask on purpose and passes
 *      `open: false`.
 */

/** The refusal word for an ask this door does not serve; its message names the console. */
export const CARD_NOT_AVAILABLE: AnswerAskRefusalReason = "card_not_available";

export const CONSOLE_IS_THE_PLACE =
  "Answer it in the console instead: the link the agent relayed opens the same ask.";

export function cardRefusal(reason: AnswerAskRefusalReason, message: string): CallToolResult {
  return toolRefusal(reason, message);
}

export type CardCallAdmitted = { agent: AgentOutput; row: PendingActionRow };

/**
 * Admit a card's call for one ask, or answer the refusal the card shows. `open` (default true)
 * refuses a closed or expired ask; `ask_status` sets it false, since a closed ask's state is the
 * very thing it answers.
 */
export async function admitCardCall(
  session: SessionContext,
  pendingActionId: string,
  options: { open?: boolean } = {},
): Promise<CardCallAdmitted | { refused: CallToolResult }> {
  const { ctx, principal, scope, deps } = session;

  // 1. Only an agent a chat product holds over OAuth (ADR 0018): a static token's harness renders
  //    no card, so the call could only be its model's.
  const agent = await getAgent(ctx, principal, scope.agentId, deps.agent);
  if (!agent?.connectedVia) {
    return {
      refused: cardRefusal(
        CARD_NOT_AVAILABLE,
        `The ask card answers only for an agent connected from a chat product; this agent holds a static token and its harness renders no card. ${CONSOLE_IS_THE_PLACE}`,
      ),
    };
  }
  //    And only a client whose hiding of app-only tools is established — the header's one signal,
  //    judged once per session (`card-client.ts`); an agent this far is an OAuth one, so a no here
  //    is the client's registration.
  if (!(await clientRendersCards(session))) {
    return {
      refused: cardRefusal(
        CARD_NOT_AVAILABLE,
        `The ask card answers only for a chat product known to hide this tool from its model: ${agent.connectedVia.clientName} registered its OAuth callback on a host that is not one of this deployment's card hosts (GRAFT_CARD_HOSTS). ${CONSOLE_IS_THE_PLACE}`,
      ),
    };
  }

  // 2. This agent's own ask — and, where asked, open and in time, in the console's words.
  const row = await getPendingAction(ctx, scope, pendingActionId, deps.pendingAction);
  if (!row) {
    return {
      refused: cardRefusal(
        "ask_not_found",
        `No ask ${pendingActionId} was made by this agent. ${CONSOLE_IS_THE_PLACE}`,
      ),
    };
  }
  if (options.open !== false) {
    if (row.answeredAt) return { refused: cardRefusal("answered", ASK_ANSWERED_MESSAGE) };
    // Consumed with no answer is a revoke's closing: expired, as the console says (`ask-status.ts`).
    if (row.consumedAt || row.expiresAt.getTime() <= deps.pendingAction.now().getTime()) {
      return { refused: cardRefusal("expired", ASK_EXPIRED_MESSAGE) };
    }
  }
  return { agent, row };
}

/** The ask's id off a card tool's arguments, or what is wrong with it. */
export function readPendingActionId(args: Record<string, unknown>): string | { error: string } {
  const pendingActionId =
    typeof args.pendingActionId === "string" ? args.pendingActionId.trim() : "";
  if (!pendingActionId) return { error: "pendingActionId must be a non-empty string" };
  return pendingActionId;
}
