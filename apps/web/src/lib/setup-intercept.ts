import { SETUP_PATH } from "@graft/core/setup/setup.rules";

/**
 * The console's intercept (GRA-202, *When the console shows Setup*): the shell's layout sends a
 * person to `/setup` when the server's show rule says so (`shouldShowSetup`, answered on
 * `GET /api/setup` as `show`), except where the person came to do something else first (user
 * story 28). Every route outside the shell is exempt by construction, since only the shell's
 * `beforeLoad` asks: the handoff page `/pending/:id`, the two popup callbacks and Setup itself.
 * Inside the shell, two are exempt by this list: the consent page, which a chat product's
 * connect lands on and which must redirect back to the client at once (ADR 0018), and the pending
 * actions list, where an ask an agent is waiting on is answered.
 *
 * The outside routes are listed too, so that moving one of them under the shell keeps it exempt.
 */
export const SETUP_INTERCEPT_EXEMPT: readonly string[] = [
  "/consent",
  "/pending",
  "/oauth/callback",
  "/link/callback",
  SETUP_PATH,
];

/** Whether `pathname` is one the intercept leaves alone: an exempt path or anything under it. */
export function isSetupExempt(pathname: string): boolean {
  return SETUP_INTERCEPT_EXEMPT.some(
    (exempt) => pathname === exempt || pathname.startsWith(`${exempt}/`),
  );
}

/** Where the shell sends the person, or null to let the navigation through. */
export function setupInterceptTarget(
  pathname: string,
  state: { show: boolean } | null,
): typeof SETUP_PATH | null {
  if (!state?.show || isSetupExempt(pathname)) return null;
  return SETUP_PATH;
}
