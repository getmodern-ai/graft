import type { IntegrationConnectionOutput, IntegrationOutput } from "@graft/core";
import type { ConnectBody, ConsoleConnectResult, IntegrationSuggestions } from "@graft/server/api";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api, type Jsonified } from "./api";
import { connectionKeys } from "./connection-queries";
import type { DirectoryHome, DirectoryPage } from "./setup-queries";

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

export type ConsoleConnect = Jsonified<ConsoleConnectResult>;

/**
 * The integration directory outside Setup (GRA-305; ADR 0001 as amended 2026-10-14): the same
 * answers as Setup's routes, read from `/api/integrations/directory`. Its own key, not Setup's
 * `setup-directory`, so Setup's cached-logo lookup (`cachedDirectoryLogo`) reads only its own.
 */
export const integrationDirectoryKeys = {
  all: ["integration-directory"] as const,
};

/** Discover's first view: the count and the categories (none under the starters). */
export const integrationDirectoryHomeQuery = queryOptions({
  queryKey: [...integrationDirectoryKeys.all, "home"] as const,
  queryFn: () => api<DirectoryHome>("/integrations/directory"),
  staleTime: 5 * 60_000,
});

/** How many tiles one page of Discover's grid asks for: two rows of four. */
export const DISCOVER_PAGE = 8;

/**
 * One grid of Discover, a page at a time: words, a category, both, or neither, which the directory
 * answers in its own order (*Popular*). *Show more* asks for the next page with the last cursor.
 */
export function integrationDirectorySearchQuery(query: string, category: string | null) {
  return infiniteQueryOptions({
    queryKey: [...integrationDirectoryKeys.all, "search", query, category] as const,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q: query, limit: String(DISCOVER_PAGE) });
      if (category) params.set("category", category);
      if (pageParam) params.set("cursor", pageParam);
      return api<DirectoryPage>(`/integrations/directory/search?${params}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });
}

/**
 * Connect an integration with no agent asking (`POST /api/connect`, GRA-304; ADR 0006 and ADR 0008
 * as amended 2026-10-14): connected at once, the keyring's form to fill, or a provider's sign-in.
 */
export function connectIntegration(body: ConnectBody) {
  return api<ConsoleConnect>("/connect", { method: "POST", body });
}
