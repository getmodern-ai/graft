import type { QueryClient } from "@tanstack/react-query";

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
 * **The cache is cleared after `leave`, not before.** `clear()` empties the cache but unmounts
 * nothing: every `useQuery` still on screen — the sidebar's pending-actions badge, the agents
 * table — sees its entry vanish and asks again, now with no session, and the 401 that answers
 * lands in the global query-error toast as "Sign in to continue" with a Retry
 * (`query-error-retry.ts`) on the very screen that was signing out. `leave` is the caller's
 * navigation to the door; awaited, it takes those readers off the screen, and the clear that
 * follows has nobody left to re-ask. The session entry still goes first, before `leave`, so a
 * guard that runs during the navigation reads the server rather than the departed session.
 *
 * The two failure shapes are Better Auth's: a refusal arrives in the envelope's `error`, a dead
 * network rejects the call outright. Both leave the cache alone and never call `leave` — the
 * session did not end, so the cache is still true and the person is still where they were.
 * Cando's `apps/web/src/lib/sign-out.ts` (its CAN-191), without the query-scope and analytics
 * resets the console has no equivalent of.
 */
export type SignOutResult =
  | { ok: true }
  | { ok: false; reason: "refused"; message: string | null }
  | { ok: false; reason: "unreachable" };

export async function signOutAndForget(
  queryClient: QueryClient,
  leave: () => Promise<void>,
): Promise<SignOutResult> {
  try {
    const { error } = await authClient.signOut();
    if (error) {
      return { ok: false, reason: "refused", message: error.message ?? null };
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  queryClient.removeQueries({ queryKey: sessionKeys.current });
  await leave();
  queryClient.clear();
  return { ok: true };
}
