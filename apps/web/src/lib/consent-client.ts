import type { AgentScopeMode } from "@graft/core";

/**
 * How the consent page treats the client that is asking (ADR 0018 as amended 2026-09-22).
 *
 * Registration is open and unauthenticated, since every chat product registers itself before any
 * person is involved (ADR 0018), so `client_name`, `client_uri` and `logo_uri` are the
 * registrant's own words, and a client named for a product nobody here vouches for is registered
 * as easily as one that is. The signal that separates them is the one the card gate already reads: every callback
 * the client registered is on a `GRAFT_CARD_HOSTS` host, which a client cannot claim because it
 * would have to control what answers there (ADR 0006 as amended 2026-09-21). The server computes
 * it once per described request as `rendersCards` (GRA-150), and this page reads that value rather
 * than a second rule of its own.
 *
 * For a client the deployment vouches for, nothing about the page moves. For one it does not, the
 * page says so in a notice, names the host the answer will be sent to, qualifies the name as the
 * app's own claim, and starts the scope at `listed` with nothing ticked. The person may still
 * choose `All connections`, and the server accepts that choice (ADR 0007 as amended 2026-09-19).
 */
export type ConsentClientVerdict = {
  /** Whether the deployment vouches for this client: `rendersCards`, read and not recomputed. */
  vouched: boolean;
  /** Whether the notice shows above the form: for an unvouched client, and no other. */
  showsNotice: boolean;
  /** The host this request's answer goes to, as the notice prints it; empty when the request named none. */
  callbackHost: string;
  /** Where the scope field starts: every connection for a vouched client, nothing for the rest. */
  defaultScopeMode: AgentScopeMode;
};

/**
 * The description the server answered, read as the page's own decisions. `redirectTarget` is the
 * host of the redirect URI *this request* named, which the authorization endpoint has already
 * matched against the client's registrations (`redirectTargetOf` in `@graft/core`).
 */
export function judgeConsentClient(request: {
  rendersCards: boolean;
  redirectTarget: string;
}): ConsentClientVerdict {
  const vouched = request.rendersCards;
  return {
    vouched,
    showsNotice: !vouched,
    callbackHost: request.redirectTarget,
    defaultScopeMode: vouched ? "all" : "listed",
  };
}

/**
 * The card's title. An unvouched client's name is the app's own claim and is said as one, in one
 * phrase: the console never repeats a registrant's word as though Graft had checked it.
 */
export function consentCardTitle(clientName: string, vouched: boolean): string {
  return vouched
    ? `Connect ${clientName} to Graft`
    : `Connect ${clientName}, as it calls itself, to Graft`;
}

/**
 * The notice's words, in the console's voice and sentence case: what Graft knows about the app
 * (nothing), where the answer goes, and the one question only the person can answer. The host
 * itself is rendered by the card, prominently, between the two sentences.
 */
export const UNVOUCHED_CLIENT_NOTICE = {
  title: "Graft has not seen this app before",
  registered: "It registered itself with the name it shows here, and your answer will be sent to",
  started: "Connect it only if you started this from that app.",
} as const;
