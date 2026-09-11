import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { LogoutIcon, UnfoldMoreIcon } from "@/components/icons";
import { useTheme } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuSkeleton, useSidebar } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { signOutAndForget } from "@/lib/sign-out";

/**
 * The account menu at the foot of the sidebar: who is signed in, the theme, and the way out.
 *
 * The menu is Cando's `RailUser` (`apps/web/src/components/shell/agent-rail.tsx`) — the same
 * header block, Theme radio group and destructive Sign out — on a different trigger. Cando's
 * trigger is a 32px avatar in the agent rail's footer; Graft has no rail (ADR 0017), so the
 * trigger is the `lg` sidebar row shadcn's own sidebar draws for an account: initial, name and
 * email, and an unfold glyph at the end. There is no `Avatar` primitive here — Cando's only
 * consumer of one is this menu — so the initial sits in a plain disc in `AvatarFallback`'s two
 * tokens.
 *
 * No Settings item, unlike Cando's: Settings is already a row in the menu above this one, and a
 * second way to the same screen from the same column would be furniture.
 */
export function AccountMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { isMobile } = useSidebar();
  const { data: session, isPending } = authClient.useSession();

  // Pending is its own state: until the session resolves there is no name to print, and a menu
  // with an empty header would claim there is nobody signed in.
  if (isPending || !session) {
    return <SidebarMenuSkeleton showIcon className="h-12" />;
  }

  const { name, email } = session.user;
  const initial = (name || email).charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            aria-label={`Account: ${name}`}
            className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
          />
        }
      >
        <Initial>{initial}</Initial>
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate font-medium text-sm">{name}</span>
          <span className="truncate font-normal text-muted-foreground text-xs">{email}</span>
        </span>
        <UnfoldMoreIcon className="ml-auto" />
      </DropdownMenuTrigger>

      {/* Beside the trigger on desktop; above it in the drawer, where "right" would be off screen. */}
      <DropdownMenuContent
        side={isMobile ? "top" : "right"}
        align="end"
        sideOffset={8}
        className="w-60"
      >
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Initial>{initial}</Initial>
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{name}</p>
            <p className="truncate text-muted-foreground text-xs">{email}</p>
          </div>
        </div>

        {/* The one place the console offers light mode: the shell draws no standalone theme
            control, as Cando's does not. The label lives *inside* the radio group, not above it:
            `DropdownMenuLabel` is Base UI's `Menu.GroupLabel`, which throws outright when it
            cannot find a `Menu.Group` or `Menu.RadioGroup` ancestor — the whole menu takes the
            error boundary with it. */}
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={theme ?? "system"}
          onValueChange={(value) => setTheme(value)}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs">Theme</DropdownMenuLabel>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            // `signOutAndForget` rather than a bare `authClient.signOut`, because the `_auth`
            // guard trusts its cached session read — a sign-out that left it behind is one the
            // guard cannot see (`lib/sign-out.ts`). Navigation is success-only: a refused or
            // unreachable sign-out leaves the person signed in, and says so.
            const result = await signOutAndForget(queryClient);
            if (result.ok) {
              await navigate({ to: "/login", search: {} });
              return;
            }
            toast.error(
              result.reason === "refused"
                ? (result.message ?? "Could not sign out")
                : "Could not reach the server",
            );
          }}
        >
          <LogoutIcon />
          {/* Sentence case, like every other action label. */}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The signed-in person's initial in a disc — `AvatarFallback`'s tokens, without the primitive. */
function Initial({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-primary text-xs"
    >
      {children}
    </span>
  );
}
