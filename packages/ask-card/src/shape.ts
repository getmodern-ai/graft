/**
 * The wire between Graft's MCP server and the ask card it renders in a chat product (GRA-84;
 * ADR 0006 as amended 2026-09-18). **Browser-safe and import-free on purpose**: the card's bundle
 * reads these shapes, and so does `@graft/mcp`, which writes the card data onto an awaiting result
 * and answers the `answer_ask` tool — one definition on both sides of the iframe, so neither can
 * drift from the other without a type error. Nothing here is a secret, and nothing here is a
 * credential's shape: the card shows what the console's handoff page would show and no more.
 */

/** The wire name of the tool the card calls with the person's click; `packages/mcp/src/tools/answer-ask.ts` answers it. */
export const ANSWER_ASK_TOOL = "answer_ask";

/** The pending-action kinds a card can be about (`pending_action.kind`); the two it can answer are `build` and `connection`. */
export type AskCardKind = "build" | "connection" | "credential" | "tool";

/**
 * What the card draws: the non-secret facts of one ask, as the console's handoff page shows them,
 * on the awaiting result's `structuredContent.card` beside GRA-55's `url`, `message` and `reason`.
 * `answerable` is the server's word on whether the card may answer in place — true for the build
 * approval and for a connection proposal whose scheme takes no credential; false for every ask
 * with a secret in it, a link provider's, a credential re-entry and a tool's first use, where the
 * card shows the one button that opens the handoff URL in the console.
 */
export type AskCard = {
  pendingActionId: string;
  kind: AskCardKind;
  /** The agent that asked, by the name the person gave it. */
  agentName: string;
  vendor: string;
  /** The connection's display name, or the proposal's. */
  displayName: string;
  primaryHost: string | null;
  hosts: string[];
  /** The scheme as the proxy names it; null for a tool ask, which is about a tool rather than a scheme. */
  scheme: string | null;
  /** Whether the scheme holds a credential in Graft (`@graft/core`'s `takesCredential`). */
  takesCredential: boolean;
  docsUrl: string | null;
  /** ISO 8601: when the ask stops being answerable. */
  expiresAt: string;
  /** The handoff URL, exactly as the result's `url`: what the console button opens. */
  url: string;
  answerable: boolean;
  /** For a connection ask a provider other than the keyring covers (ADR 0019): the provider's name. */
  provider?: string;
  /** How the provider connects, when the ask names one: a link provider's ask is a button, never a form. */
  providerConnect?: "form" | "link";
  /** For a tool ask: the wire name, `<vendor>__<name>`. */
  toolName?: string;
};

/**
 * What the card sends `answer_ask`. The build approval's yes or no; the keyless connection's
 * confirm, carrying the build choice GRA-75 put on the console's page (on by default there and
 * here); or the connection's decline. Nothing else is accepted, and no field is a secret.
 */
export type AnswerAskAnswer =
  | { allow: boolean }
  | { connect: true; approveBuild: boolean }
  | { decline: true };

export type AnswerAskInput = { pendingActionId: string; answer: AnswerAskAnswer };

/** What `answer_ask` answers on success: the sentence the card shows in place of its buttons. */
export type AnswerAskResult = { answered: true; sentence: string };

/** The reason words `answer_ask` refuses with; the card shows the message beside each. */
export type AnswerAskRefusalReason =
  | "card_not_available"
  | "ask_not_found"
  | "answered"
  | "expired"
  | "input_invalid";

const KINDS: readonly AskCardKind[] = ["build", "connection", "credential", "tool"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * The card data off a tool result's `structuredContent`, or null when the result is not an ask —
 * a `connected`, a job started, a refusal — in which case the card renders nothing. Shape only:
 * the server wrote it, and the card's job is to draw it, not to judge it.
 */
export function readAskCard(structuredContent: unknown): AskCard | null {
  if (!isRecord(structuredContent)) return null;
  const card = structuredContent.card;
  if (!isRecord(card)) return null;
  if (
    typeof card.pendingActionId !== "string" ||
    typeof card.kind !== "string" ||
    !KINDS.includes(card.kind as AskCardKind) ||
    typeof card.agentName !== "string" ||
    typeof card.vendor !== "string" ||
    typeof card.displayName !== "string" ||
    !isStringArray(card.hosts) ||
    typeof card.takesCredential !== "boolean" ||
    typeof card.expiresAt !== "string" ||
    typeof card.url !== "string" ||
    typeof card.answerable !== "boolean"
  ) {
    return null;
  }
  return {
    pendingActionId: card.pendingActionId,
    kind: card.kind as AskCardKind,
    agentName: card.agentName,
    vendor: card.vendor,
    displayName: card.displayName,
    primaryHost: typeof card.primaryHost === "string" ? card.primaryHost : null,
    hosts: card.hosts,
    scheme: typeof card.scheme === "string" ? card.scheme : null,
    takesCredential: card.takesCredential,
    docsUrl: typeof card.docsUrl === "string" ? card.docsUrl : null,
    expiresAt: card.expiresAt,
    url: card.url,
    answerable: card.answerable,
    ...(typeof card.provider === "string" ? { provider: card.provider } : {}),
    ...(card.providerConnect === "form" || card.providerConnect === "link"
      ? { providerConnect: card.providerConnect }
      : {}),
    ...(typeof card.toolName === "string" ? { toolName: card.toolName } : {}),
  };
}

/** `answer_ask`'s answer, or its refusal, off the call's `structuredContent`; anything else is a failure with no sentence. */
export type AnswerOutcome =
  | { ok: true; sentence: string }
  | { ok: false; reason: AnswerAskRefusalReason | "failed"; message: string };

export function readAnswerOutcome(structuredContent: unknown): AnswerOutcome {
  if (isRecord(structuredContent)) {
    if (structuredContent.answered === true && typeof structuredContent.sentence === "string") {
      return { ok: true, sentence: structuredContent.sentence };
    }
    if (typeof structuredContent.message === "string") {
      const reason = structuredContent.reason;
      return {
        ok: false,
        reason:
          reason === "card_not_available" ||
          reason === "ask_not_found" ||
          reason === "answered" ||
          reason === "expired" ||
          reason === "input_invalid"
            ? reason
            : "failed",
        message: structuredContent.message,
      };
    }
  }
  return {
    ok: false,
    reason: "failed",
    message: "Graft did not answer. The link in the chat opens the same ask in the console.",
  };
}
