import { queryOptions } from "@tanstack/react-query";

import { authClient } from "./auth-client";

/**
 * The session as a cache entry, for the routing layer. Components read `authClient.useSession()`,
 * Better Auth's own reactive store; this query exists for the one reader that cannot use a hook —
 * `beforeLoad`, which runs on every navigation and every intent-preload, and would otherwise pay a
 * round trip each time.
 *
 * Never throws: signed out arrives as `null`, and so does a transport failure — the guard sends
 * both to sign in, which is what it did when it called `getSession()` directly. Thirty seconds bounds
 * only the redirect decision, never anyone's data: every read behind the guard re-checks the cookie
 * server-side and refuses on its own. Sign-in and sign-out clear the entry rather than waiting it out.
 */
export const sessionKeys = {
  current: ["session"] as const,
};

export const sessionQuery = queryOptions({
  queryKey: sessionKeys.current,
  queryFn: async () => {
    try {
      return (await authClient.getSession()).data;
    } catch {
      return null;
    }
  },
  staleTime: 30_000,
});
