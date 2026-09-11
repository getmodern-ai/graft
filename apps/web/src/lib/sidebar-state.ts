/**
 * Whether the sidebar starts collapsed.
 *
 * `SidebarProvider` (`components/ui/sidebar.tsx`) writes `sidebar_state` on every toggle but never
 * reads it back — it was written for a framework that hands the cookie to the server and passes
 * `defaultOpen` down. The console has no server render, so nothing closed the loop and a reload
 * would always reopen the sidebar. Reading it here is what makes the toggle survive more than a
 * client-side navigation.
 *
 * Absent means open, because that is `SidebarProvider`'s own default and a person who has never
 * touched the toggle should see the sidebar. Only an explicit `false` collapses it: a truthy test
 * would read a corrupted or half-written value as "collapse", which is the more surprising of the
 * two failures.
 *
 * Cando's `apps/web/src/lib/sidebar-state.ts`, unchanged (GRA-46).
 */
const SIDEBAR_COOKIE_NAME = "sidebar_state";

function sidebarOpenFromCookie(cookie: string): boolean {
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }

    // Trimmed because `document.cookie` separates pairs with "; ", and a name that only differs
    // by a leading space would otherwise never match.
    if (pair.slice(0, separator).trim() !== SIDEBAR_COOKIE_NAME) {
      continue;
    }

    return pair.slice(separator + 1).trim() !== "false";
  }

  return true;
}

export { SIDEBAR_COOKIE_NAME, sidebarOpenFromCookie };
