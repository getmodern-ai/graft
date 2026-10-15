import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The connections list moved to `/integrations` (GRA-321). The old path stays a route so a link
 * from before, a bookmark, or a sentence that still says "the connections screen" lands there.
 */
export const Route = createFileRoute("/_auth/_shell/connections/")({
  beforeLoad: () => {
    throw redirect({ to: "/integrations", replace: true });
  },
});
