import type { QueryClient } from "@tanstack/react-query";

import { resetAnalytics } from "./analytics";
import { authClient } from "./auth-client";
import { sessionKeys } from "./session-queries";

/**
 * Ending a session and forgetting its cache are one operation.
 *
 * Everything in the query cache belongs to the person who is leaving — their agents, their
 * connections, their open asks, and the session entry the `_auth` guard trusts for up to thirty
 * seconds (`session-queries.ts`). A sign-out that left those behind would hand them to whoever
 * uses the tab next: the guard would wave a signed-out visitor through on the departed session,
 * and a different person signing in would briefly read the previous person's rows. `clear()`
 * rather than targeted invalidation because the answer is total — no cached query survives the
 * person it was fetched for. The session entry is removed first, by name, so the guard's next
 * read cannot land on it in the instant before `clear()` runs.
 *
 * The two failure shapes are Better Auth's: a refusal arrives in the envelope's `error`, a dead
 * network rejects the call outright. Both leave the cache alone — the session did not end, so
 * the cache is still true. Cando's `apps/web/src/lib/sign-out.ts` (its CAN-191), without the
 * query-scope reset the console has no equivalent of; the analytics reset (GRA-100) forgets the
 * person in PostHog for the same reason the cache is cleared.
 */
export type SignOutResult =
  | { ok: true }
  | { ok: false; reason: "refused"; message: string | null }
  | { ok: false; reason: "unreachable" };

export async function signOutAndForget(queryClient: QueryClient): Promise<SignOutResult> {
  try {
    const { error } = await authClient.signOut();
    if (error) {
      return { ok: false, reason: "refused", message: error.message ?? null };
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  queryClient.removeQueries({ queryKey: sessionKeys.current });
  queryClient.clear();
  resetAnalytics();
  return { ok: true };
}
