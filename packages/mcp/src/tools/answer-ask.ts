import {
  ANSWER_ASK_TOOL,
  type AnswerAskAnswer,
  type AnswerAskInput,
  type AnswerAskRefusalReason,
  type AnswerAskResult,
} from "@graft/ask-card/shape";
import { answerPendingAction, getAgent, getPendingAction, KEYRING_PROVIDER } from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  ASK_ANSWERED_MESSAGE,
  ASK_EXPIRED_MESSAGE,
  confirmConnectionAsk,
  recordApprovalAnswer,
} from "../ask-answer";
import { APP_ONLY_TOOL_META, connectionAskAnswerable } from "../ask-card";
import { CONNECTION_ASK_KIND, type ConnectionProposalPayload } from "../connection-request";
import type { SessionContext } from "../context";
import { isPlainObject, toolRefusal, toolResult } from "../result";
import type { MetaTool } from "./meta";

/**
 * `answer_ask` — the tool the ask card calls with the person's click (GRA-84; ADR 0006 as
 * amended 2026-09-18). Declared `_meta.ui.visibility: ["app"]`, so a host that implements the
 * MCP Apps extension leaves it out of the model's list and forwards only the card's `tools/call`
 * to it. Nothing on the wire proves that: a view's call reaches Graft as an ordinary `tools/call`
 * under the agent's own session, the same as the model's would (the ticket's research, point 1),
 * so every guard here is Graft's own, and the description opens by telling a model that does see
 * the tool not to call it.
 *
 * The guards, in order, each a refusal the card shows as a sentence:
 *
 *   1. **The agent is one a chat product holds over OAuth** (`connected_via_client_id` set,
 *      ADR 0018). A static-token agent's harness — Hermes, OpenClaw — renders no app, so a call
 *      from one can only be its model's: refused `card_not_available`, the console is the place.
 *   2. **The ask is this agent's** (the agent-scoped read answers nothing for another's), **open**
 *      (unanswered, untaken — `answered`) **and in time** (`expired`), in the console's words.
 *   3. **The ask is one the card may answer**: a `build` ask, or a `connection` ask the keyring's
 *      form serves for a scheme that takes no credential (`ask-card.ts`'s `connectionAskAnswerable`,
 *      read from the row, never from the card). A tool's first use, a credential re-entry, a link
 *      provider's ask and any scheme with a secret are `card_not_available`: the handoff URL on the
 *      same result is the floor, and the console keeps the session (ADR 0004, ADR 0006).
 *
 * What it records is what the console's routes record, through `ask-answer.ts`, with `via:
 * "card"` on the answer JSON. The waiting call — `acquire` polling its build ask,
 * `request_connection` polling its proposal — finds the answer exactly as it finds a console
 * answer and proceeds. The card is answered `{ answered, sentence }` and sends nothing into the
 * chat: what the agent says next is the agent's.
 */

export const ANSWER_ASK = ANSWER_ASK_TOOL;

/** The refusal word for an ask this door does not answer; its message names the console. */
export const CARD_NOT_AVAILABLE: AnswerAskRefusalReason = "card_not_available";

const CONSOLE_IS_THE_PLACE =
  "Answer it in the console instead: the link the agent relayed opens the same ask.";

function refuse(reason: AnswerAskRefusalReason, message: string): CallToolResult {
  return toolRefusal(reason, message);
}

/** The arguments by shape: an id and one of the three answers, nothing else. */
export function readAnswerAskInput(
  args: Record<string, unknown>,
): AnswerAskInput | { error: string } {
  const pendingActionId =
    typeof args.pendingActionId === "string" ? args.pendingActionId.trim() : "";
  if (!pendingActionId) return { error: "pendingActionId must be a non-empty string" };
  const answer = args.answer;
  if (!isPlainObject(answer)) {
    return {
      error: "answer must be { allow }, { connect: true, approveBuild } or { decline: true }",
    };
  }
  const keys = Object.keys(answer).sort().join(",");
  if (keys === "allow" && typeof answer.allow === "boolean") {
    return { pendingActionId, answer: { allow: answer.allow } };
  }
  if (
    keys === "approveBuild,connect" &&
    answer.connect === true &&
    typeof answer.approveBuild === "boolean"
  ) {
    return { pendingActionId, answer: { connect: true, approveBuild: answer.approveBuild } };
  }
  if (keys === "decline" && answer.decline === true) {
    return { pendingActionId, answer: { decline: true } };
  }
  return {
    error: "answer must be { allow }, { connect: true, approveBuild } or { decline: true }",
  };
}

/** The proposal on a connection ask, as `request_connection` recorded it; null for a row this code did not write. */
function proposalOf(row: PendingActionRow): ConnectionProposalPayload | null {
  const payload = row.payload as Partial<ConnectionProposalPayload>;
  if (
    typeof payload.vendor !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.scheme !== "string" ||
    typeof payload.primaryHost !== "string" ||
    !Array.isArray(payload.hosts)
  ) {
    return null;
  }
  return {
    provider: typeof payload.provider === "string" ? payload.provider : KEYRING_PROVIDER,
    ...(payload.providerConnect ? { providerConnect: payload.providerConnect } : {}),
    providerTarget: payload.providerTarget ?? null,
    vendor: payload.vendor,
    displayName: payload.displayName,
    scheme: payload.scheme,
    schemeConfig: isPlainObject(payload.schemeConfig)
      ? (payload.schemeConfig as Record<string, string>)
      : {},
    primaryHost: payload.primaryHost,
    hosts: payload.hosts,
    docsUrl: typeof payload.docsUrl === "string" ? payload.docsUrl : null,
    note: typeof payload.note === "string" ? payload.note : "",
  };
}

async function answerBuildAsk(
  session: SessionContext,
  row: PendingActionRow,
  answer: AnswerAskAnswer,
  agentName: string,
): Promise<CallToolResult> {
  if (!("allow" in answer)) {
    return refuse(
      "input_invalid",
      "A build approval is answered { allow: true } or { allow: false }",
    );
  }
  const { ctx, principal, deps } = session;
  await recordApprovalAnswer(
    ctx,
    principal,
    row.id,
    { allow: answer.allow, via: "card" },
    { approval: deps.approval, pendingAction: deps.pendingAction },
  );
  const what = `${String(row.payload.connectionName ?? "the connection")} (${String(row.payload.vendor ?? "")})`;
  const result: AnswerAskResult = {
    answered: true,
    sentence: answer.allow
      ? `Allowed. ${agentName} may build tools against ${what}: reads only, every write previewed, until the first real use, which asks you once. Withdraw it any time from the agent's page in the console.`
      : `Declined. Nothing was recorded; ${agentName}'s next acquire against ${what} asks again.`,
  };
  return toolResult(result);
}

async function answerConnectionAsk(
  session: SessionContext,
  row: PendingActionRow,
  answer: AnswerAskAnswer,
  agentName: string,
): Promise<CallToolResult> {
  const { ctx, principal, scope, deps, notifier } = session;
  const payload = proposalOf(row);
  if (!payload || !connectionAskAnswerable(payload)) {
    return refuse(
      CARD_NOT_AVAILABLE,
      `This connection needs the console: ${
        payload?.providerConnect === "link"
          ? `the person signs in at the vendor through ${payload.provider}'s page there`
          : "its credential is entered there, never through a card or a chat"
      }. ${CONSOLE_IS_THE_PLACE}`,
    );
  }
  if ("allow" in answer) {
    return refuse(
      "input_invalid",
      "A connection is answered { connect: true, approveBuild } or { decline: true }",
    );
  }
  const what = `${payload.displayName} (${payload.vendor})`;
  if ("decline" in answer) {
    // The generic decline, as the console's card records it: an answer naming no connection,
    // which the waiting `request_connection` reads as `connection_declined`.
    await answerPendingAction(
      ctx,
      principal,
      row.id,
      { allow: false, via: "card" },
      deps.pendingAction,
    );
    const result: AnswerAskResult = {
      answered: true,
      sentence: `Declined. Nothing was connected; ${agentName} will be told.`,
    };
    return toolResult(result);
  }
  const confirmed = await confirmConnectionAsk(
    ctx,
    principal,
    row.id,
    {
      provider: payload.provider,
      vendor: payload.vendor,
      displayName: payload.displayName,
      scheme: payload.scheme,
      schemeConfig: payload.schemeConfig,
      primaryHost: payload.primaryHost,
      hosts: payload.hosts,
      // A keyless scheme: nothing to enter, and the service writes no ciphertext (GRA-66).
      credential: {},
      approveBuild: answer.approveBuild,
    },
    {
      connection: deps.connection,
      agent: deps.agent,
      approval: deps.approval,
      pendingAction: deps.pendingAction,
    },
    { answerExtra: { via: "card" } },
  );
  // The connection's execute tool is now in this agent's list (ADR 0003).
  notifier.changed(scope.agentId);
  const result: AnswerAskResult = {
    answered: true,
    sentence: `Connected. ${what} is in ${agentName}'s scope${
      confirmed.buildApproval ? ", and it may build tools against it" : ""
    }; nothing was entered, since the vendor takes no credential.`,
  };
  return toolResult(result);
}

export const answerAsk: MetaTool = {
  definition: {
    name: ANSWER_ASK,
    description:
      "Called by Graft's ask card, never by you: it records the person's click on the card a chat product renders for acquire's build approval or request_connection's confirmation. " +
      "Do not call it yourself, and never on the person's behalf. If you see it in your list, ignore it; the person answers in the card or in the console, and you call the asking tool again afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        pendingActionId: {
          type: "string",
          description: "The ask's id, as the awaiting result named it.",
        },
        answer: {
          type: "object",
          description:
            "{ allow: boolean } for a build approval; { connect: true, approveBuild: boolean } or { decline: true } for a connection that takes no credential.",
          properties: {
            allow: { type: "boolean" },
            connect: { type: "boolean", const: true },
            approveBuild: { type: "boolean" },
            decline: { type: "boolean", const: true },
          },
          additionalProperties: false,
        },
      },
      required: ["pendingActionId", "answer"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: APP_ONLY_TOOL_META,
  },
  handle: async (args, session) => {
    const input = readAnswerAskInput(args);
    if ("error" in input) return refuse("input_invalid", input.error);
    const { ctx, principal, scope, deps } = session;

    // 1. Only an agent a chat product holds over OAuth (ADR 0018): a static token's harness renders
    //    no card, so the call could only be its model's.
    const agent = await getAgent(ctx, principal, scope.agentId, deps.agent);
    if (!agent?.connectedVia) {
      return refuse(
        CARD_NOT_AVAILABLE,
        `The ask card answers only for an agent connected from a chat product; this agent holds a static token and its harness renders no card. ${CONSOLE_IS_THE_PLACE}`,
      );
    }

    // 2. This agent's own ask, open and in time — the console's words for the two closed states.
    const row = await getPendingAction(ctx, scope, input.pendingActionId, deps.pendingAction);
    if (!row) {
      return refuse(
        "ask_not_found",
        `No ask ${input.pendingActionId} was made by this agent. ${CONSOLE_IS_THE_PLACE}`,
      );
    }
    if (row.answeredAt || row.consumedAt) return refuse("answered", ASK_ANSWERED_MESSAGE);
    if (row.expiresAt.getTime() <= deps.pendingAction.now().getTime()) {
      return refuse("expired", ASK_EXPIRED_MESSAGE);
    }

    // 3. The two asks the amendment admits; everything else keeps the console and its session.
    if (row.kind === "build") return answerBuildAsk(session, row, input.answer, agent.name);
    if (row.kind === CONNECTION_ASK_KIND) {
      return answerConnectionAsk(session, row, input.answer, agent.name);
    }
    return refuse(
      CARD_NOT_AVAILABLE,
      `A ${row.kind} ask is answered in the console, where the person's session is. ${CONSOLE_IS_THE_PLACE}`,
    );
  },
};
