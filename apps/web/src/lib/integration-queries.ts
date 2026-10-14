import type { IntegrationConnectionOutput, IntegrationOutput } from "@graft/core";
import type {
  ConnectionAcquireBody,
  ConnectionAcquireJob,
  ConnectionGoalSuggestions,
  IntegrationSuggestions,
  IntegrationToolsOutput,
} from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import { connectionKeys } from "./connection-queries";

/**
 * The integrations list (GRA-291): one row per vendor the person holds a live connection of, with
 * its connections, the agents that can use it and its tool count. The integration page (GRA-315)
 * reads its vendor's row from here; a vendor whose every connection is revoked has no row, and the
 * page falls back to `connectionsQuery` for those.
 */

export type Integration = Jsonified<IntegrationOutput>;
export type IntegrationConnection = Jsonified<IntegrationConnectionOutput>;
export type SuggestedIntegration = Jsonified<IntegrationSuggestions>["suggestions"][number];
/** One row of an integration's Tools tab (GRA-293): a tool of the person's or a stock one not yet copied in. */
export type IntegrationToolRow = Jsonified<IntegrationToolsOutput>["tools"][number];

/**
 * Under `connectionKeys.all`, because a row is a projection of the person's connections: every
 * write that invalidates the connections (a revoke, a credential, a consent, a reconnect) refreshes
 * the integrations with it, with no call site having to know this read exists.
 */
export const integrationKeys = {
  all: [...connectionKeys.all, "integrations"] as const,
  suggested: [...connectionKeys.all, "integrations", "suggested"] as const,
  tools: (vendor: string) => [...connectionKeys.all, "integrations", vendor, "tools"] as const,
};

export const integrationsQuery = queryOptions({
  queryKey: integrationKeys.all,
  queryFn: () => api<{ integrations: Integration[] }>("/integrations"),
  // A row also counts the agents that can use it, which agent writes (a new agent, a revoke, a
  // scope change) move without touching the connections key; stale at once, so every mount
  // refetches rather than drawing a count from before such a write.
  staleTime: 0,
});

/** One job a connection's Get a new tool started, with the agent and the goal (GRA-303). */
export type NewToolJob = Jsonified<ConnectionAcquireJob>;
export type NewToolSuggestions = Jsonified<ConnectionGoalSuggestions>;

export const newToolKeys = {
  jobs: (connectionId: string) => [...connectionKeys.all, connectionId, "acquire-jobs"] as const,
  suggestions: (connectionId: string) =>
    [...connectionKeys.all, connectionId, "goal-suggestions"] as const,
};

/**
 * The connection's recent jobs across the person's agents, newest first (GRA-303), so a reload or
 * a dialog closed mid-build finds the job again. Stale at once: the dialog reads it on each open.
 */
export const newToolJobsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: newToolKeys.jobs(connectionId),
    queryFn: () =>
      api<{ jobs: NewToolJob[] }>(`/connections/${encodeURIComponent(connectionId)}/acquire-jobs`),
    staleTime: 0,
  });

/**
 * The Try chips and whether Create can start a job at all (`build`, `acquire_unconfigured` when no
 * model can author). The server memoises the model's answer per person and connection.
 */
export const newToolSuggestionsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: newToolKeys.suggestions(connectionId),
    queryFn: () =>
      api<NewToolSuggestions>(`/connections/${encodeURIComponent(connectionId)}/goal-suggestions`),
  });

/** Create: the picked agent's build approval for the connection and its job, in one write. */
export function startNewTool(connectionId: string, body: ConnectionAcquireBody) {
  return api<NewToolJob>(`/connections/${encodeURIComponent(connectionId)}/acquire`, {
    method: "POST",
    body,
  });
}

/**
 * "Your agents asked about these" (GRA-305): one entry per connection ask for an integration the
 * person has not connected. Under `integrationKeys.all`, so a connection made from any door drops
 * its vendor from the banner with the rest of the connection reads.
 */
export const suggestedIntegrationsQuery = queryOptions({
  queryKey: integrationKeys.suggested,
  queryFn: () => api<Jsonified<IntegrationSuggestions>>("/integrations/suggested"),
});

/**
 * One integration's tools (GRA-293): the person's tools of the vendor with a current version, then
 * the stock tools of it they hold none of, each with its last run. Under the integrations key, so a
 * connection write refreshes it with the row it belongs to.
 */
export const integrationToolsQuery = (vendor: string) =>
  queryOptions({
    queryKey: integrationKeys.tools(vendor),
    queryFn: () =>
      api<Jsonified<IntegrationToolsOutput>>(`/integrations/${encodeURIComponent(vendor)}/tools`),
  });
