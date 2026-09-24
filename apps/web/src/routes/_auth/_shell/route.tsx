import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";
import { setupInterceptTarget } from "@/lib/setup-intercept";
import { setupQuery } from "@/lib/setup-queries";

/**
 * The console's chrome. **Pathless**: `_shell` adds nothing to the URL, so `/agents`, `/pending`
 * and `/connections` keep their addresses; the segment exists to say "these screens wear the
 * sidebar", which is a different question from "these screens need a session" (`_auth/route.tsx`).
 *
 * **The Setup intercept** (ADR 0024; GRA-204) runs here, on entry to any screen of the shell: when
 * the server's show rule says so, the person is sent to `/setup` instead, except on the screens
 * `lib/setup-intercept.ts` exempts (the consent page and the pending actions list). A Setup state
 * that cannot be read lets the navigation through, since a console that cannot say whether to
 * show Setup should still show itself; the read has toasted its failure with a Retry.
 */
export const Route = createFileRoute("/_auth/_shell")({
  beforeLoad: async ({ context, location }) => {
    const state = await context.queryClient
      .ensureQueryData({ ...setupQuery, revalidateIfStale: true })
      .catch(() => null);
    const target = setupInterceptTarget(location.pathname, state);
    if (target) throw redirect({ to: target });
  },
  component: ShellLayout,
});

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
