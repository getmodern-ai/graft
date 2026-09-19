import { ASK_STATUS_TOOL, type AskStatusResult, type AskStatusState } from "@graft/ask-card/shape";
import type { PendingActionRow } from "@graft/db/repo/pending-action";

import { ASK_EXPIRED_MESSAGE } from "../ask-answer";
import { APP_ONLY_TOOL_META } from "../ask-card";
import { CONNECTION_ASK_KIND, CREDENTIAL_ASK_KIND, SCOPE_ASK_KIND } from "../connection-request";
import { toolRefusal, toolResult } from "../result";
import { admitCardCall, readPendingActionId } from "./card-gate";
import type { MetaTool } from "./meta";

/**
 * `ask_status` — the read the ask card polls once it has sent the person somewhere else (GRA-117,
 * GRA-118; ADR 0006 as amended 2026-09-19): to the console's handoff page for a secret, to a
 * provider's page for a link. The page settles the ask, and would tell the window that opened it
 * over `postMessage` — but the card is a frame on the host's origin, not that window, so the one
 * thing it can do is ask Graft, through the same bridge every other call takes, whether its ask
 * has been answered yet. Every few seconds (`ASK_STATUS_POLL_MS`), until the answer is not `open`.
 *
 * What it answers is read off the row alone: `open` while unanswered and in time; `answered` for a
 * yes — a connection ask or a credential ask whose answer names a connection, any other kind whose
 * answer says `allow`; `declined` for the rest of the answers; `expired` once the time passed
 * unanswered, which is also what a revoke leaves behind. The sentence beside it is the console's
 * settled sentence for that kind, in the card's voice — the card shows it in place of its buttons
 * and adds nothing. Gated like `answer_ask` (`./card-gate.ts`) less the open check, since a
 * closed ask's state is the very thing asked; read-only, and it records nothing.
 */

export const ASK_STATUS = ASK_STATUS_TOOL;

/** The sentence the card shows while it waits. */
export const ASK_OPEN_SENTENCE = "Waiting for you to finish in the window that opened.";

/** Where the ask stands, off the row: the header's four states. */
export function askState(row: PendingActionRow, now: Date): AskStatusState {
  if (row.answeredAt || row.consumedAt) {
    return saidYes(row) ? "answered" : "declined";
  }
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "open";
}

function saidYes(row: PendingActionRow): boolean {
  const answer = row.answer ?? {};
  if (row.kind === CONNECTION_ASK_KIND || row.kind === CREDENTIAL_ASK_KIND) {
    return typeof answer.connectionId === "string";
  }
  return answer.allow === true;
}

/** The console's settled sentence for the kind and state, spoken to the person at the card. */
export function askStateSentence(
  row: PendingActionRow,
  state: AskStatusState,
  agentName: string,
): string {
  if (state === "open") return ASK_OPEN_SENTENCE;
  if (state === "expired") return `${ASK_EXPIRED_MESSAGE}.`;
  const payload = row.payload;
  const name = (key: string, fallback: string) =>
    typeof payload[key] === "string" ? String(payload[key]) : fallback;
  const vendor = name("vendor", "");
  const what = (display: string) => (vendor ? `${display} (${vendor})` : display);
  switch (row.kind) {
    case CONNECTION_ASK_KIND: {
      const display = what(name("displayName", "The connection"));
      if (state === "declined")
        return `Declined. Nothing was connected; ${agentName} will be told.`;
      if (payload.providerConnect === "link") {
        const provider = name("provider", "the provider");
        return `Connected through ${provider}. ${display} is in ${agentName}'s scope; the account's token stays with ${provider}, and nothing was stored in Graft.`;
      }
      return `Connected. ${display} is in ${agentName}'s scope; the credential is stored and never shown again.`;
    }
    case CREDENTIAL_ASK_KIND:
      return state === "declined"
        ? "Declined. The credential stands as it was; the agent is told so."
        : `Connected; the credential is stored and never shown again. ${agentName}'s waiting call answers connected.`;
    case SCOPE_ASK_KIND: {
      const display = what(name("displayName", "The connection"));
      return state === "declined"
        ? `Declined. Nothing changed; ${agentName} will be told.`
        : `Allowed. ${display} is in ${agentName}'s scope; it is the connection you already had, so nothing was entered.`;
    }
    case "build": {
      const display = what(name("connectionName", "the connection"));
      return state === "declined"
        ? `Declined. Nothing was recorded; ${agentName}'s next acquire against ${display} asks again.`
        : `Allowed. ${agentName} may build tools against ${display}: reads only, every write previewed, until the first real use, which asks you once.`;
    }
    case "tool": {
      const tool = name("toolName", "the tool");
      if (state === "declined") {
        return `Denied. The no holds for ${agentName} until withdrawn on its page in the console.`;
      }
      return row.answer?.askEveryCall === true
        ? `Allowed for this call. ${tool} asks again next time; turn that off on the agent's page in the console.`
        : `Allowed. ${agentName} may run ${tool}; the answer holds for its next calls until withdrawn on its page in the console.`;
    }
    default:
      return state === "declined" ? "Declined." : "Answered.";
  }
}

export const askStatus: MetaTool = {
  definition: {
    name: ASK_STATUS,
    description:
      "Called by Graft's ask card while it waits for a window it opened: reads where one of this agent's asks stands and answers { state, sentence }, state being open, answered, declined or expired and sentence what the card shows for it. " +
      "Takes pendingActionId, the ask the awaiting result named. Records nothing. App-only (_meta.ui.visibility app), so a host hides it from the model. " +
      "Refuses card_not_available for a static-token agent and ask_not_found for another agent's ask.",
    inputSchema: {
      type: "object",
      properties: {
        pendingActionId: {
          type: "string",
          description: "The ask's id, as the awaiting result named it.",
        },
      },
      required: ["pendingActionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    _meta: APP_ONLY_TOOL_META,
  },
  handle: async (args, session) => {
    const pendingActionId = readPendingActionId(args);
    if (typeof pendingActionId !== "string") {
      return toolRefusal("input_invalid", pendingActionId.error);
    }
    const admitted = await admitCardCall(session, pendingActionId, { open: false });
    if ("refused" in admitted) return admitted.refused;
    const state = askState(admitted.row, session.deps.pendingAction.now());
    const result: AskStatusResult = {
      state,
      sentence: askStateSentence(admitted.row, state, admitted.agent.name),
    };
    return toolResult(result);
  },
};
