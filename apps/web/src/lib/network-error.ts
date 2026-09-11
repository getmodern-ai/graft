/**
 * Whether a failure is the request never reaching the server, as opposed to the server refusing
 * it. A `fetch` that cannot connect rejects with a `TypeError`, and nothing else in the console's
 * read path throws one — `api.ts` maps every HTTP refusal onto `ApiError` — so that is the whole
 * check. Cando's `apps/web/src/lib/network-error.ts` reaches the same conclusion the long way.
 *
 * Two readers: `RouteError`, for a read that failed before the screen could draw, and
 * `RetryNotice`, for one that failed inside a table or a panel already on screen. The advice is
 * the same in both places, which is why the sentence lives here rather than in either.
 */
export function isOfflineError(error: unknown): boolean {
  return error instanceof TypeError;
}

export const OFFLINE_ERROR_MESSAGE =
  "Could not reach the server — check your connection and try again.";
