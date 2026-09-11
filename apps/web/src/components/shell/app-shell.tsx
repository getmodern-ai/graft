import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type * as React from "react";
import { InboxIcon, LogoutIcon, PowerIcon, SettingsIcon, SmartToyIcon } from "@/components/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { pendingActionsQuery } from "@/lib/pending-action-queries";
import { sessionKeys } from "@/lib/session-queries";
import { cn } from "@/lib/utils";

/**
 * The console's chrome: a narrow sidebar with the four screens and the person's sign-out, and the
 * content column beside it. Hung off `routes/_auth/_shell/route.tsx`, which is what decides who
 * wears it; a screen that wants the guard and no chrome files itself beside `_shell`.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh grid-cols-1 md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 border-b bg-sidebar px-3 py-4 text-sidebar-foreground md:border-r md:border-b-0">
        <Link to="/agents" className="flex items-center gap-2 px-2 font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-foreground font-bold text-background text-xs">
            G
          </span>
          Graft
        </Link>
        <nav className="flex flex-row gap-1 md:flex-col" aria-label="Console">
          <NavLink to="/agents" icon={<SmartToyIcon />}>
            Agents
          </NavLink>
          <NavLink to="/pending" icon={<InboxIcon />} trailing={<PendingCount />}>
            Pending actions
          </NavLink>
          <NavLink to="/connections" icon={<PowerIcon />}>
            Connections
          </NavLink>
          <NavLink to="/settings" icon={<SettingsIcon />}>
            Settings
          </NavLink>
        </nav>
        <div className="mt-auto hidden md:block">
          <PersonFooter />
        </div>
      </aside>
      <main className="min-w-0 px-6 py-8 md:px-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">{children}</div>
      </main>
    </div>
  );
}

function NavLink({
  to,
  icon,
  trailing,
  children,
}: {
  to: "/agents" | "/pending" | "/connections" | "/settings";
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 font-medium text-sidebar-foreground/80 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "[&_svg]:size-4 [&_svg]:shrink-0",
      )}
      activeProps={{
        className: "bg-sidebar-accent text-sidebar-accent-foreground",
      }}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {trailing}
    </Link>
  );
}

/**
 * How many asks are waiting, beside the link — the one number a person opening the console wants
 * first (ADR 0006). Polled, because an ask arrives while the person is on another screen.
 */
function PendingCount() {
  const { data } = useQuery({ ...pendingActionsQuery, refetchInterval: 15_000 });
  const open = data?.pendingActions.length ?? 0;
  if (open === 0) return null;
  return <Badge>{open}</Badge>;
}

function PersonFooter() {
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const signOut = async () => {
    await authClient.signOut();
    // The guard decides from `sessionQuery`; a stale "signed in" there would keep the chrome navigable.
    queryClient.removeQueries({ queryKey: sessionKeys.current });
    queryClient.clear();
    await navigate({ to: "/login", search: {} });
  };

  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <div className="min-w-0">
        <div className="truncate font-medium text-sm">{session?.user.name}</div>
        <div className="truncate text-muted-foreground text-xs">{session?.user.email}</div>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={signOut} aria-label="Sign out">
        <LogoutIcon />
      </Button>
    </div>
  );
}
