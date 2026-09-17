import { createFileRoute, redirect } from "@tanstack/react-router";

import { safeRedirectPath } from "@/lib/safe-redirect";

/**
 * There is no sign-up screen: `/login` is the one door, and registers an address it has never
 * seen (GRA-81, as Cando's CAN-64). This route stays so that every link written while there were
 * two doors — READMEs, a bookmark, a handoff's `?redirect=` — arrives at the one, carrying its
 * `redirect` along.
 */
export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeRedirectPath(search.redirect);
    return redirect ? { redirect } : {};
  },
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/login", search: search.redirect ? { redirect: search.redirect } : {} });
  },
});
