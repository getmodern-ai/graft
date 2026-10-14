import type {
  ConnectBody,
  ConnectionBody,
  ConnectionProposalAvailability,
  ConnectionProposalBody,
  ConnectionProposalStarted,
  ConsoleConnectResult,
} from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import type { StoredCredential } from "./connection-queries";
import type { ProposalState } from "./custom-api";

/**
 * The reads and writes behind *Add a custom API* (GRA-323): GRA-299's proposal job, polled while it
 * runs, and GRA-304's console connect. The job is held in the server's memory for fifteen minutes,
 * so nothing here is cached past the dialog.
 */

export type ProposalAvailability = Jsonified<ConnectionProposalAvailability>;
export type ConsoleConnect = Jsonified<ConsoleConnectResult>;

/** How often a running job is read: its four stages pass in well under a minute. */
export const PROPOSAL_POLL_MS = 1000;

export const proposalKeys = {
  all: ["connection-proposals"] as const,
  job: (id: string) => ["connection-proposals", id] as const,
};

/** Whether a model reads docs here at all; read when the dialog opens. */
export const proposalAvailabilityQuery = queryOptions({
  queryKey: proposalKeys.all,
  queryFn: () => api<ProposalAvailability>("/connection-proposals"),
  staleTime: 0,
  // A failed read leaves the name step as it is; the start then says what is wrong.
  meta: { quietError: () => true },
});

/**
 * One job, read every second while it runs and never again once it settles. A 404 (a restart
 * forgot it, or another replica answered) is a refusal and not retried (`query-client.ts`): the
 * dialog says so and offers to start again.
 */
export const proposalQuery = (id: string) =>
  queryOptions({
    queryKey: proposalKeys.job(id),
    queryFn: () => api<ProposalState>(`/connection-proposals/${encodeURIComponent(id)}`),
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "running" ? false : PROPOSAL_POLL_MS,
    staleTime: 0,
    gcTime: 0,
    // The dialog draws a lost job itself, a refusal a Retry cannot change, so no global toast.
    meta: { quietError: () => true },
  });

export function startProposal(body: ConnectionProposalBody) {
  return api<ConnectionProposalStarted>("/connection-proposals", { method: "POST", body });
}

/** GRA-304's connect with no agent asking: connected, the keyring's form to post, or a link. */
export function connectFromConsole(body: ConnectBody) {
  return api<ConsoleConnect>("/connect", { method: "POST", body });
}

/**
 * The keyring's form, posted once `POST /connect` answered `form`: the checked registration, the
 * secret and the same access, which the server records with the row (GRA-304).
 */
export function createConnectionWithAccess(body: ConnectionBody) {
  return api<StoredCredential>("/connections", { method: "POST", body });
}
