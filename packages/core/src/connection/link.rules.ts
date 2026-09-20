/**
 * What the console and the server say to each other about a **link** — a provider's one-click
 * connect (ADR 0019; GRA-59): where the provider's page sends the browser back, and what the
 * server's return route hands the console once it has confirmed what the person connected. Pure
 * functions and constants, **browser-safe** like `oauth.rules.ts`: the console's callback route
 * reads the query this file writes, so this file imports nothing that reaches `node:crypto` or
 * drizzle. The signed state the return carries is `link-state.ts`, which the console never reaches.
 *
 * The shape is GRA-48's for the OAuth consent (`oauth.rules.ts`, `OAuthCallbackOutcome`), with one
 * difference that follows from when the row exists: a link answers a **pending action**, and the
 * connection is made only once the account is confirmed, so the outcome names the ask first and the
 * connection when there is one. The waiting console is waiting on the ask.
 */

import { FROM_CARD, FROM_CARD_PARAM } from "./card.rules";

/** Where the provider's page sends the browser back: the server's return route, no session. */
export const LINK_CALLBACK_PATH = "/api/providers/link/callback";

/** `GRAFT_AUTH_URL` plus the return path — a trailing slash on the origin is not doubled. */
export function linkCallbackUri(authUrl: string): string {
  return `${authUrl.replace(/\/+$/, "")}${LINK_CALLBACK_PATH}`;
}

/** The query the return route reads beside the state: which of the two URIs the provider used. */
export const LINK_OUTCOME_PARAM = "outcome";
export const LINK_STATE_PARAM = "state";

/**
 * How long a link may take from the button to the return before its state is refused — and how
 * long the console waits for it. A link provider holds the link it mints to the same window (the
 * hosted form's broker client reads this constant), so a link the person follows late fails at the
 * provider and at Graft alike rather than connecting an account no return can claim.
 */
export const LINK_STATE_TTL_MS = 15 * 60_000;

/** How the link ended, as the return route tells the console: three words and nothing finer. */
export type LinkCallbackStatus = "connected" | "declined" | "failed";

export const LINK_CALLBACK_STATUSES: readonly LinkCallbackStatus[] = [
  "connected",
  "declined",
  "failed",
];

/**
 * What the return route hands the console: a status word, the ask it answers, the connection once
 * there is one, and one sentence for the person — never the state, a token or anything the
 * provider answered. Three carriers hold this shape: the redirect's query (`linkCallbackRedirect`),
 * the `postMessage` the console's `/link/callback` route sends its opener, and its announcement on
 * `LINK_CHANNEL`.
 */
export type LinkCallbackOutcome = {
  status: LinkCallbackStatus;
  /** Null when the state could not be verified, so no waiting console takes the message as its own. */
  pendingActionId: string | null;
  connectionId: string | null;
  message: string;
};

export type LinkCallbackMessage = LinkCallbackOutcome & { type: "graft:link" };

export const LINK_CALLBACK_MESSAGE_TYPE = "graft:link" satisfies LinkCallbackMessage["type"];

/**
 * The same-origin channel the console's callback route announces itself on beside `postMessage`
 * — `oauth.rules.ts`'s `OAUTH_CONSENT_CHANNEL` says why a channel is needed at all: a provider's
 * page may sever the popup from its opener, and the route is a console page in both deployment
 * forms, so the channel reaches the waiting console whatever the page did.
 */
export const LINK_CHANNEL = "graft:link";

/** The console route the return route redirects to, under `GRAFT_CONSOLE_URL`. */
export const LINK_CONSOLE_CALLBACK_PATH = "/link/callback";

/**
 * The redirect the return route answers with: the console route with the outcome in its query and
 * nothing else in it — save `from=card` when the link was minted by the ask card (GRA-117;
 * `card.rules.ts`), which the return route copies through from its own query so the console page
 * knows to close itself. `oauth.rules.ts`'s `oauthCallbackRedirect` has the string handling and the
 * constraint (`GRAFT_CONSOLE_URL` carrying a path is GRA-50's gap); a null id is left out rather
 * than written as the word `null`.
 */
export function linkCallbackRedirect(
  consoleUrl: string,
  outcome: LinkCallbackOutcome,
  options: { fromCard?: boolean } = {},
): string {
  const base = consoleUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ status: outcome.status });
  if (outcome.pendingActionId !== null) query.set("pendingActionId", outcome.pendingActionId);
  if (outcome.connectionId !== null) query.set("connectionId", outcome.connectionId);
  query.set("message", outcome.message);
  if (options.fromCard) query.set(FROM_CARD_PARAM, FROM_CARD);
  return `${base}${LINK_CONSOLE_CALLBACK_PATH}?${query}`;
}

/**
 * The console route's search, read back as the outcome — the other half of `linkCallbackRedirect`.
 * Anything but the three status words reads as `failed`, an id that is not a string as none, a
 * message that is not one as empty: an address typed by hand lands on a page that says something
 * went wrong and settles no waiting console.
 */
export function readLinkCallbackSearch(search: Record<string, unknown>): LinkCallbackOutcome {
  const status = LINK_CALLBACK_STATUSES.find((word) => word === search.status) ?? "failed";
  return {
    status,
    pendingActionId: typeof search.pendingActionId === "string" ? search.pendingActionId : null,
    connectionId: typeof search.connectionId === "string" ? search.connectionId : null,
    message: typeof search.message === "string" ? search.message : "",
  };
}

export function linkCallbackMessage(outcome: LinkCallbackOutcome): LinkCallbackMessage {
  return { type: LINK_CALLBACK_MESSAGE_TYPE, ...outcome };
}
