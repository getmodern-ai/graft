import { formatRelative } from "./format";
import type { ReconnectAction } from "./integration-page";
import type { Integration, IntegrationConnection } from "./integration-queries";
import { agentsPhrase, connectionSignInOf } from "./integrations-list";

/**
 * The sign-in rows at the top of Requests' Open list (GRA-313; Figma 2075:8068): one per live
 * connection that needs the person before it works again, derived from the integrations read
 * (GRA-291). A connection state, not a pending action: there is nothing to decline, so no "Not
 * now", and they count in the sidebar's badge with the asks (ADR 0006 as amended 2026-10-14,
 * GRA-287 item 7). Home's *Needs you* (GRA-327) draws the same rows.
 */

/** The states a person clears by signing in; `provider_unavailable` is the operator's to fix. */
const SIGN_IN_RANK = {
  consent_required: 0,
  awaiting_consent: 1,
  awaiting_credential: 2,
} as const;

type SignInState = keyof typeof SIGN_IN_RANK;

const needsSignIn = (
  connection: IntegrationConnection,
): connection is IntegrationConnection & { state: SignInState } => connection.state in SIGN_IN_RANK;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export type SignInRequest = {
  /** The connection's id, unique across the list. */
  key: string;
  connection: IntegrationConnection;
  /** The integration's slug and name, for the mark. */
  vendor: string;
  integrationName: string;
  /** The harness of the first agent that can use it, for the mark's corner; null when none can. */
  harness: string | null;
  title: string;
  detail: string;
  /** Since when it has needed the person: the vendor's refusal, else the connection's creation. */
  since: string;
  /** The way Sign in signs it in (`connectionSignInOf`): a consent, or the credential dialog. */
  action: ReconnectAction;
};

function titleOf(state: SignInState, name: string): string {
  switch (state) {
    case "consent_required":
      return `${name} signed you out`;
    case "awaiting_consent":
      return `Finish signing in to ${name}`;
    case "awaiting_credential":
      return `Finish connecting ${name}`;
  }
}

/**
 * Every sign-in row, worst state first (as the integrations list ranks attention), then the
 * longest waiting. A revoked connection is not on the read at all, and one whose provider is
 * turned off is not the person's to fix, so neither shows. The agents named are the integration
 * row's: the read says which agents reach the vendor, not which reach each connection, and the one
 * usual case is one connection per integration.
 */
export function signInRequestsOf(integrations: readonly Integration[]): SignInRequest[] {
  const requests: (SignInRequest & { rank: number })[] = [];
  for (const row of integrations) {
    const stillWorks = row.connections.some((connection) => connection.state === "connected");
    for (const connection of row.connections) {
      if (!needsSignIn(connection)) continue;
      const action = connectionSignInOf(connection);
      // These three states belong to connections entered here (`connectionStateOf`), each of
      // which has a way in; a row Sign in could not start would be a dead end, so none shows.
      if (!action) continue;
      const since =
        connection.state === "consent_required"
          ? (connection.oauth?.consentRequired?.at ?? connection.updatedAt)
          : connection.createdAt;
      requests.push({
        key: connection.id,
        connection,
        vendor: row.vendor,
        integrationName: row.displayName,
        harness: row.agents[0]?.harness ?? null,
        title: titleOf(connection.state, connection.displayName),
        // With another connection of the integration still working, nobody is cut off yet.
        detail: stillWorks
          ? `Your other ${row.displayName} connection still works`
          : `${capitalise(agentsPhrase(row.agents))} can't use ${row.displayName} until you sign in`,
        since,
        action,
        rank: SIGN_IN_RANK[connection.state],
      });
    }
  }
  return requests
    .sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.key.localeCompare(b.key))
    .map(({ rank: _rank, ...request }) => request);
}

/** The sub-line's time, as a request's: how long ago it started needing the person. */
export function signInRequestWhen(
  request: Pick<SignInRequest, "since">,
  now: Date = new Date(),
): { iso: string; label: string } | null {
  const label = formatRelative(request.since, now);
  return label ? { iso: request.since, label } : null;
}

/** The Requests badge's number: the open asks and the sign-in rows, which Open lists together. */
export function openRequestCount(
  pendingActions: number,
  integrations: readonly Integration[] | undefined,
): number {
  return pendingActions + (integrations ? signInRequestsOf(integrations).length : 0);
}
