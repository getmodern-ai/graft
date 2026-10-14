import type { IntegrationConnectionOutput, IntegrationOutput } from "@graft/core";
import type { IntegrationSuggestions } from "@graft/server/api";
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

/**
 * Under `connectionKeys.all`, because a row is a projection of the person's connections: every
 * write that invalidates the connections (a revoke, a credential, a consent, a reconnect) refreshes
 * the integrations with it, with no call site having to know this read exists.
 */
export const integrationKeys = {
  all: [...connectionKeys.all, "integrations"] as const,
  suggested: [...connectionKeys.all, "integrations", "suggested"] as const,
};

export const integrationsQuery = queryOptions({
  queryKey: integrationKeys.all,
  queryFn: () => api<{ integrations: Integration[] }>("/integrations"),
  // A row also counts the agents that can use it, which agent writes (a new agent, a revoke, a
  // scope change) move without touching the connections key; stale at once, so every mount
  // refetches rather than drawing a count from before such a write.
  staleTime: 0,
});

/**
 * "Your agents asked about these" (GRA-305): one entry per connection ask for an integration the
 * person has not connected. Under `integrationKeys.all`, so a connection made from any door drops
 * its vendor from the banner with the rest of the connection reads.
 */
export const suggestedIntegrationsQuery = queryOptions({
  queryKey: integrationKeys.suggested,
  queryFn: () => api<Jsonified<IntegrationSuggestions>>("/integrations/suggested"),
});
