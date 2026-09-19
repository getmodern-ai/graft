/**
 * The sentence an awaiting answer hands the ask to the person with, in the two forms it takes
 * (GRA-120; ADR 0006 as amended 2026-09-20). Every ask flow writes its `message` for a client that
 * renders nothing — "Relay this link so they can …: <url>", GRA-55's shape, what Hermes, OpenClaw
 * and a bare MCP client read — and beside it the same message in the **card form**, for a client
 * the server knows renders the ask card in the conversation (`card-client.ts`): the ask is on a
 * card here and the person answers it there, and the url is the console for a person who cannot
 * see the card. The caller picks one form per session (`toolAskResult`); the console form is
 * byte for byte what it was before the card existed, so nothing changes for a client that shows no
 * card. The lead of each message — what is asked, the OAuth guidance, the build approval on the
 * page — is the flow's own and the same in both forms; only this sentence differs.
 */

export type HandoffForm = "console" | "card";

/**
 * The card form of the sentence: where the ask is, who answers it, and what the url is for. One
 * sentence for every ask kind, answerable or not, because a card the person cannot answer in place
 * still carries the button that opens the console page for them (GRA-118), so the ask is answered
 * from the card either way.
 */
export function cardHandoffSentence(url: string, expiresAt: string): string {
  return (
    "The ask is shown as a card in this conversation, and the person answers it from there, so do not send them a link. " +
    `If they say they cannot see the card, this url opens the same ask in the console: ${url} It expires at ${expiresAt}.`
  );
}

/**
 * The handoff sentence in the form asked for. `relay` is the console form's clause up to the colon
 * — "Relay this link so they can answer in the console" — kept as each flow wrote it, so the
 * console form reads exactly as before.
 */
export function handoffSentence(
  form: HandoffForm,
  relay: string,
  url: string,
  expiresAt: string,
): string {
  return form === "card"
    ? cardHandoffSentence(url, expiresAt)
    : `${relay}: ${url} It expires at ${expiresAt}.`;
}
