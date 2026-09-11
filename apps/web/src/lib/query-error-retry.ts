import type { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "./api";

/**
 * The shape `QueryCache` accepts, recovered from its own constructor: `QueryCacheConfig` is
 * exported by `@tanstack/query-core` alone, and the console depends only on `@tanstack/react-query`.
 */
type QueryCacheHandlers = NonNullable<ConstructorParameters<typeof QueryCache>[0]>;

/**
 * The global query-error toast and its Retry, wired into the one `QueryCache` in `query-client.ts`
 * (GRA-47). Cando's `apps/web/src/lib/query-error-retry.ts` (its CAN-247), with the message in the
 * console's own words.
 *
 * `onError` opens a toast keyed by the query's hash: `id` on a sonner toast replaces the toast
 * already showing under that id rather than stacking a second one, so a query that fails, is
 * retried and fails again lands back on one notice with a fresh action instead of piling up
 * duplicates. `onSuccess` reacts only when that hash is in `failing`, so an ordinary query
 * succeeding in the background never conjures a dismissal for a toast that was never shown.
 *
 * The click handler is where "no request burst" lives: it no-ops while the query is already
 * fetching, so mashing Retry cannot queue requests, and it goes through the client's public
 * `refetchQueries` rather than the query's own `fetch`, which keeps the disabled/static checks
 * `refetchQueries` does. A retry that fails again runs `onError` on its own — every failed fetch
 * does — so a second failure is never a dead end. **That needs the click to keep the toast up**:
 * sonner dismisses a toast whose action was pressed unless the handler says otherwise, and a
 * dismissal in flight swallowed the replacement — measured: a Retry that failed left no toast at
 * all. `preventDefault` keeps the notice; a retry that succeeds is dismissed by `onSuccess`.
 *
 * The message is the mutation toast's, deliberately, not Cando's `Error: …` prefix: the server's
 * own sentence when it sent one (`api.ts` maps `{ error, message }` onto `ApiError`), and one fixed
 * sentence for a request that never arrived. The two toasts sit in the same corner and should
 * read as one voice.
 *
 * **A read that fails before a screen draws toasts too**, and the route's error boundary shows as
 * well — Cando's arrangement, kept. The toast is the transient announcement and the boundary the
 * durable frame; suppressing one for the other would need the cache to know which query a route
 * depends on, and the toast's `id` already keeps one failure to one notice.
 *
 * **A Retry that recovers such a read also clears the boundary** — `onRecover`, which `main.tsx`
 * wires to `router.invalidate()`. Without it the toast's Retry refetched the query, the toast
 * went, and the person was left on the error screen until they pressed its own Try again
 * (raised by Greptile on #30). Invalidating re-runs the loaders of the matched routes, which now
 * read the refreshed cache without a request, and a route whose loader had failed is drawn anew:
 * TanStack Router keys a boundary's reset on the match, and a reload produces a new one. Called
 * only when the retried query *succeeded* — a second failure runs `onError` and the boundary is
 * still the right thing to show — and harmless when no boundary was standing, since every loader
 * finds its reads fresh.
 */
export function createQueryErrorRetry(
  client: QueryClient,
  options: { onRecover?: () => void } = {},
): Pick<QueryCacheHandlers, "onError" | "onSuccess"> {
  const failing = new Set<string>();

  const onError: QueryCacheHandlers["onError"] = (error, query) => {
    failing.add(query.queryHash);
    toast.error(error instanceof ApiError ? error.message : "Could not reach the server", {
      id: query.queryHash,
      action: {
        label: "Retry",
        onClick: (event) => {
          event.preventDefault();
          if (query.state.fetchStatus === "fetching") {
            return;
          }
          void client.refetchQueries({ queryKey: query.queryKey, exact: true }).then(() => {
            if (query.state.status === "success") options.onRecover?.();
          });
        },
      },
    });
  };

  const onSuccess: QueryCacheHandlers["onSuccess"] = (_data, query) => {
    if (failing.delete(query.queryHash)) {
      toast.dismiss(query.queryHash);
    }
  };

  return { onError, onSuccess };
}
