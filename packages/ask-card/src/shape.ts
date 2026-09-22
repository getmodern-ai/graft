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

/**
 * The wire name of the tool the card calls to mint a link provider's Connect Link for its own
 * ask (GRA-117); `packages/mcp/src/tools/start-link.ts` answers it. App-only, like `answer_ask`.
 */
export const START_LINK_TOOL = "start_link";

/**
 * The wire name of the read the card polls after it has sent the person to the console or to a
 * provider's page (GRA-117, GRA-118); `packages/mcp/src/tools/ask-status.ts` answers it. App-only.
 */
export const ASK_STATUS_TOOL = "ask_status";

/**
 * How often the card polls `ask_status` once the person has been sent elsewhere (GRA-118): three
 * seconds is quick enough that a settled ask reads settled before the person looks back at the
 * chat, and slow enough that a ten-minute sign-in is two hundred reads, not thousands.
 */
export const ASK_STATUS_POLL_MS = 3000;

/**
 * The query the card adds to every URL it opens in the person's browser — the handoff URL, and
 * the link's return through the server (GRA-117, GRA-118): `from=card`. The console page that
 * lands on it closes itself once its work is done, because the card is where the person is and
 * settles on its own. The console's reader is `@graft/core`'s `connection/card.rules.ts`, which
 * spells the same two words; this file is import-free, so they are written twice and pinned
 * against each other in `packages/mcp/src/ask-card.test.ts`.
 */
export const FROM_CARD_PARAM = "from";
export const FROM_CARD = "card";

/** `url` with `from=card` added to its query; a URL that does not parse is returned as it was. */
export function withFromCard(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(FROM_CARD_PARAM, FROM_CARD);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The pending-action kinds a card can be about (`pending_action.kind`); it can answer `build`, `tool`, `connection` and `scope`. */
export type AskCardKind = "build" | "connection" | "credential" | "tool" | "scope";

/**
 * The facts of the tool a `tool` ask is about (GRA-116), as the console's card shows them: the
 * description in the agent's model's own words — the card says so — the two hints a harness gates
 * on (ADR 0008), and whether the person has set this tool to ask on every call, in which case a
 * yes is for this call alone.
 */
export type AskCardTool = {
  /** The agent's model's words, marked as such where they are shown. */
  description: string;
  readOnly: boolean;
  destructive: boolean;
  askEveryCall: boolean;
};

/**
 * What the card draws: the non-secret facts of one ask, as the console's handoff page shows them,
 * on the awaiting result's `structuredContent.card` beside GRA-55's `url`, `message` and `reason`.
 * `answerable` is the server's word on whether the card may answer in place — true for the build
 * approval, for a tool's first-use approval (GRA-116), for a connection proposal whose scheme
 * takes no credential, and for the scope ask (a connection the person already holds, asked for by
 * an agent that was not given it; GRA-104); false for every ask with a secret in it and for a
 * credential re-entry, where the card opens the handoff URL in the console as a popup and polls
 * `ask_status` until the page has done its work (GRA-118). A link provider's ask is not
 * answerable either, but is *started* from the card: `start_link` mints the provider's link and
 * the card opens it (GRA-117).
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
  /** For a connection or scope ask a provider other than the keyring covers (ADR 0019): the provider's name. */
  provider?: string;
  /** How the provider connects, when the ask names one: a link provider's ask is a button, never a form. */
  providerConnect?: "form" | "link";
  /**
   * For a connection ask that widens a connection the person already holds (GRA-167): the row,
   * and the hosts confirming adds to it. `hosts` is the union the row will reach.
   */
  widens?: { connectionId: string; addedHosts: string[] };
  /** For a tool ask: the wire name, `<vendor>__<name>`. */
  toolName?: string;
  /** For a tool ask: the tool's facts (GRA-116). */
  tool?: AskCardTool;
};

/**
 * What the card sends `answer_ask`. The build approval's yes or no; the tool ask's yes or no
 * (GRA-116), which never carries the ask-every-call setting — that is the console's; the scope
 * ask's yes or no, carrying the build choice GRA-75 put on the console's page (GRA-104); the
 * keyless connection's confirm, carrying the same choice (on by default there and here); or a
 * connection's decline — a link provider's included. Nothing else is accepted, and no field is a
 * secret.
 */
export type AnswerAskAnswer =
  | { allow: boolean; approveBuild?: boolean }
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

/** What the card sends `start_link` (GRA-117): its ask, and the build choice the return records. */
export type StartLinkInput = { pendingActionId: string; approveBuild: boolean };

/** What `start_link` answers: the provider's link to open, and until when it is honoured. */
export type StartLinkResult = { url: string; expiresAt: string; provider: string };

export type AskStatusInput = { pendingActionId: string };

/**
 * Where an ask stands, as `ask_status` reads it off the row (GRA-117): `open` while nobody has
 * answered and the ask is in time; `answered` for a yes — an approval granted, a connection made;
 * `declined` for the person's no; `expired` once its time passed unanswered, or a revoke closed it.
 */
export type AskStatusState = "open" | "answered" | "declined" | "expired";

/** What `ask_status` answers: the state and the sentence the card shows for it. */
export type AskStatusResult = { state: AskStatusState; sentence: string };

const KINDS: readonly AskCardKind[] = ["build", "connection", "credential", "tool", "scope"];
const STATES: readonly AskStatusState[] = ["open", "answered", "declined", "expired"];

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
    ...(isAskCardTool(card.tool) ? { tool: card.tool } : {}),
    ...(isWidening(card.widens) ? { widens: card.widens } : {}),
  };
}

function isWidening(value: unknown): value is { connectionId: string; addedHosts: string[] } {
  return (
    isRecord(value) && typeof value.connectionId === "string" && isStringArray(value.addedHosts)
  );
}

function isAskCardTool(value: unknown): value is AskCardTool {
  return (
    isRecord(value) &&
    typeof value.description === "string" &&
    typeof value.readOnly === "boolean" &&
    typeof value.destructive === "boolean" &&
    typeof value.askEveryCall === "boolean"
  );
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
    const refused = readRefusal(structuredContent);
    if (refused) return { ok: false, ...refused };
  }
  return NO_ANSWER;
}

/** The refusal a call's `structuredContent` carries — Graft's `{ reason, message }` — or null when it is not one. */
function readRefusal(
  structuredContent: unknown,
): { reason: AnswerAskRefusalReason | "failed"; message: string } | null {
  if (!isRecord(structuredContent) || typeof structuredContent.message !== "string") return null;
  const reason = structuredContent.reason;
  return {
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

/** What a call that answered nothing usable reads as: a failure, and the link in the chat as the floor. */
const NO_ANSWER = {
  ok: false,
  reason: "failed",
  message: "Graft did not answer. The link in the chat opens the same ask in the console.",
} as const;

/** `start_link`'s link, or its refusal, off the call's `structuredContent` (GRA-117). */
export type StartLinkOutcome =
  | { ok: true; url: string; expiresAt: string; provider: string }
  | { ok: false; reason: AnswerAskRefusalReason | "failed"; message: string };

export function readStartLinkOutcome(structuredContent: unknown): StartLinkOutcome {
  if (isRecord(structuredContent) && typeof structuredContent.url === "string") {
    return {
      ok: true,
      url: structuredContent.url,
      expiresAt: typeof structuredContent.expiresAt === "string" ? structuredContent.expiresAt : "",
      provider: typeof structuredContent.provider === "string" ? structuredContent.provider : "",
    };
  }
  const refused = readRefusal(structuredContent);
  return refused ? { ok: false, ...refused } : NO_ANSWER;
}

/** `ask_status`'s state, or its refusal, off the call's `structuredContent` (GRA-117). */
export type AskStatusOutcome =
  | { ok: true; state: AskStatusState; sentence: string }
  | { ok: false; reason: AnswerAskRefusalReason | "failed"; message: string };

export function readAskStatusOutcome(structuredContent: unknown): AskStatusOutcome {
  if (
    isRecord(structuredContent) &&
    STATES.includes(structuredContent.state as AskStatusState) &&
    typeof structuredContent.sentence === "string"
  ) {
    return {
      ok: true,
      state: structuredContent.state as AskStatusState,
      sentence: structuredContent.sentence,
    };
  }
  const refused = readRefusal(structuredContent);
  return refused ? { ok: false, ...refused } : NO_ANSWER;
}
