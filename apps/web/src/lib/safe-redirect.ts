/**
 * Where to return after sign-in. A signed-out visit to a console route — a handoff URL in particular
 * (ADR 0006: the person opens the link hours later, often in a fresh browser) — is sent to `/login`
 * carrying the address it wanted, and comes back to it once signed in.
 *
 * The value is accepted only as a **same-origin path**: it starts with one `/`, so it cannot be a
 * scheme (`https://…`) or a protocol-relative address (`//evil.example`), and it carries no
 * backslash, which some browsers read as a slash. Anything else is dropped and the person lands on
 * the default — an open redirect on the sign-in door is exactly the phishing shape ADR 0006 warns
 * a handoff URL already has, and this door must not add a second one.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/^\/[\s]/.test(value)) return null;
  // A door never returns to a door: a signed-in visit to `/login?redirect=%2Flogin` would otherwise
  // bounce between the door's own guard and itself.
  if (
    DOORS.some(
      (door) => value === door || value.startsWith(`${door}?`) || value.startsWith(`${door}/`),
    )
  ) {
    return null;
  }
  return value;
}

/** The public doors, which are never a destination after sign-in. */
const DOORS = ["/login", "/signup", "/forgot-password", "/reset-password"] as const;

/** Where a signed-in person lands when nothing asked for somewhere else. */
export const DEFAULT_SIGNED_IN_PATH = "/agents";
