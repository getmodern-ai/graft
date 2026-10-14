import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";
import type { DirectoryHome, DirectoryPage } from "./setup-queries";

/**
 * The command palette's two directory reads (GRA-329), on the routes the console's Integrations
 * screen reads (GRA-305; ADR 0001 as amended 2026-10-14). Their own keys under
 * `integration-directory`, beside Discover's, so Setup's cached-logo lookup reads only Setup's.
 */
const paletteDirectoryKey = ["integration-directory", "palette"] as const;

/** How many entries a palette search asks for: a few more than it shows, for the connected it drops. */
const PALETTE_DIRECTORY_LIMIT = 8;

/** The directory's size, for "Search all N"; it moves only when the backing does. */
export const paletteDirectoryHomeQuery = queryOptions({
  queryKey: [...paletteDirectoryKey, "home"] as const,
  queryFn: () => api<DirectoryHome>("/integrations/directory"),
  staleTime: 5 * 60_000,
});

/** The directory's first page for what was typed, in the directory's own order. */
export const paletteDirectorySearchQuery = (query: string) =>
  queryOptions({
    queryKey: [...paletteDirectoryKey, "search", query] as const,
    queryFn: () =>
      api<DirectoryPage>(
        `/integrations/directory/search?${new URLSearchParams({ q: query, limit: String(PALETTE_DIRECTORY_LIMIT) })}`,
      ),
    staleTime: 60_000,
  });
