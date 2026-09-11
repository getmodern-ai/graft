import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "./api";
import { createQueryErrorRetry } from "./query-error-retry";

/**
 * One client for the app, held in the router context so `beforeLoad` and loaders read through the
 * same cache as the components (`main.tsx`).
 *
 * `staleTime` is ten seconds — long enough that a route loader's read is not immediately repeated
 * by the component it loaded for, short enough not to be a freshness policy. Every mutation in the
 * console invalidates what it changed, so this only decides whether *remounting* re-asks.
 *
 * A failed mutation surfaces as a toast here rather than in every dialog, with the server's own
 * sentence when it sent one: `api.ts` maps `{ error, message }` onto `ApiError`, and the message is
 * the service's rule (`@graft/core` refuses with a sentence a person can act on). A failed *query*
 * toasts the same sentence with a Retry that refetches it (`query-error-retry.ts`, GRA-47), and the
 * route's error boundary still frames a read that failed before the screen could draw.
 *
 * A factory rather than a bare constant so a test can build a client of its own with the same
 * wiring; `main.tsx` uses the one instance below.
 */
export function createQueryClient() {
  const queryCache = new QueryCache();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (failureCount, error) => {
          // A refusal will not change on retry; a transport failure might.
          if (error instanceof ApiError) return false;
          return failureCount < 2;
        },
      },
    },
    queryCache,
    mutationCache: new MutationCache({
      onError: (error) => {
        toast.error(error instanceof ApiError ? error.message : "Could not reach the server");
      },
    }),
  });

  // Assigned after construction, not passed into `new QueryCache(...)`: the Retry action needs the
  // client itself, and the client does not exist until this cache has gone into its constructor.
  const { onError, onSuccess } = createQueryErrorRetry(queryClient);
  queryCache.config.onError = onError;
  queryCache.config.onSuccess = onSuccess;

  return queryClient;
}

export const queryClient = createQueryClient();
