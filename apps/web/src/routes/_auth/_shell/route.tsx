import { createFileRoute, Outlet } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/app-shell";

/**
 * The console's chrome. **Pathless**: `_shell` adds nothing to the URL, so `/agents`, `/pending`
 * and `/connections` keep their addresses; the segment exists to say "these screens wear the
 * sidebar", which is a different question from "these screens need a session" (`_auth/route.tsx`).
 */
export const Route = createFileRoute("/_auth/_shell")({
  component: ShellLayout,
});

function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
