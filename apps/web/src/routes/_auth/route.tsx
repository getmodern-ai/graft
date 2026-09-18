import { createFileRoute, redirect } from "@tanstack/react-router";

import { RouteError } from "@/components/route-error";
import { identifyAnalytics } from "@/lib/analytics";
import { sessionQuery } from "@/lib/session-queries";

/**
 * The guard, and only the guard. The shell sits one level down (`_shell/route.tsx`), so whether a
 * screen needs a session and whether it wears the chrome are two decisions made in two places —
 * Cando's arrangement, arrived at after copying the guard to escape the shell (its CAN-69, CAN-107).
 *
 * A signed-out visit is sent to sign in carrying the address it wanted, so a handoff URL opened in
 * a fresh browser (ADR 0006) comes back to its action once the person is in. This redirect alone is
 * not enforcement: every route behind it reads through the JSON API, which resolves the session
 * server-side and refuses on its own.
 */
export const Route = createFileRoute("/_auth")({
  errorComponent: RouteError,
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery,
      revalidateIfStale: true,
    });
    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    // The person as PostHog should know them, by id (GRA-100): a no-op unless analytics is on, and
    // a no-op in posthog-js when the id is the one it already holds.
    identifyAnalytics(session.user.id);
  },
});
