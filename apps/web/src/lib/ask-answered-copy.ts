/**
 * What a connection ask's card says once it is answered, by who opened the ask (GRA-212). An ask
 * an agent's `request_connection` opened has a call waiting on it, so the card says that call now
 * answers connected. An ask Setup's connect step opened (`origin: "setup"`, GRA-206) has no call
 * waiting: the person is in Setup, and the next thing to happen is Setup's own next step. The
 * sentences live here, beside each other, so the two forms cannot drift and a test can read them.
 *
 * `AskOrigin` is `components/pending/ask-card.tsx`'s, re-exported from there.
 */

export type AskOrigin = "agent" | "setup";

/** Setup's next step after a connection is made, said the one way. */
const SETUP_MOVES_ON = "Setup moves on to the task.";

const buildClause = (approveBuild: boolean | undefined) =>
  approveBuild ? ", allowed to build tools against it" : "";

/**
 * A connection ask's success toast: the keyring's form, its OAuth consent, or a link provider's
 * sign-in (`provider` names it, and the account's token stays there).
 */
export function connectedToastDescription(input: {
  origin: AskOrigin;
  agentName: string;
  approveBuild?: boolean;
  provider?: string;
}): string {
  const scope = `In ${input.agentName}'s scope${buildClause(input.approveBuild)}`;
  const token = input.provider ? `the account's token stays with ${input.provider}` : null;
  if (input.origin === "setup") {
    return `${scope}${token ? `, and ${token}` : ""}. ${SETUP_MOVES_ON}`;
  }
  return token
    ? `${scope}; its waiting call answers connected. The account's token stays with ${input.provider}.`
    : `${scope}; its waiting call answers connected. Other agents get it when you add it to theirs.`;
}

/** A connection ask's settled line, before the link to the connections screen. */
export function connectedSettledSentence(input: {
  origin: AskOrigin;
  widens?: boolean;
  provider?: string;
}): string {
  const { origin, widens, provider } = input;
  if (widens) {
    return origin === "setup"
      ? "Confirmed. The connection now reaches the added hosts; nothing new was made."
      : "Confirmed. The connection now reaches the added hosts and the agent's waiting call answers connected; nothing new was made.";
  }
  if (provider) {
    return origin === "setup"
      ? `Connected through ${provider}. The connection is in the agent's scope and the account's token stays with ${provider}.`
      : `Connected through ${provider}. The connection is in the agent's scope and its waiting call answers connected; the account's token stays with ${provider}.`;
  }
  return origin === "setup"
    ? "Connected. The connection is in the agent's scope."
    : "Connected. The connection is in the agent's scope and its waiting call answers connected; other agents get it when you add it to theirs.";
}

/** A scope ask's toast once allowed: the person's existing connection, added to this agent. */
export function scopeAllowedToastDescription(input: {
  origin: AskOrigin;
  approveBuild?: boolean;
}): string {
  const nothingNew = "Nothing was entered and no new connection was made.";
  if (input.origin === "setup") {
    return `${input.approveBuild ? "Allowed to build tools against it. " : ""}${nothingNew} ${SETUP_MOVES_ON}`;
  }
  return `${input.approveBuild ? "Allowed to build tools against it; its" : "Its"} waiting call answers connected. ${nothingNew}`;
}

/** A scope ask's settled line once allowed, before the link to the agents screen. */
export function scopeAllowedSettledSentence(input: {
  origin: AskOrigin;
  approveBuild?: boolean;
}): string {
  const build = input.approveBuild ? ", and it may build tools against it" : "";
  return input.origin === "setup"
    ? `Allowed. The connection is in the agent's scope${build}.`
    : `Allowed. The connection is in the agent's scope${build}; its waiting call answers connected.`;
}

/** The toast after any connection ask is declined. */
export function declinedToastDescription(origin: AskOrigin): string {
  return origin === "setup"
    ? "Nothing was connected. Setup goes back to the integrations."
    : "The agent's waiting call is refused.";
}
