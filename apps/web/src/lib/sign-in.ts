import type { SocialProviderName } from "@graft/auth";
import type { SignInMethods } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { api } from "./api";
import { DEFAULT_SIGNED_IN_PATH } from "./safe-redirect";

/**
 * The door's two provider concerns (GRA-81), beside `email-auth-outcome.ts`: which buttons to draw,
 * and how a provider round trip reads on the way out and the way back.
 *
 * The server names the providers it holds clients for (`GET /api/sign-in-methods`, public), and the
 * door draws one button per name — a self-host that configured neither shows the email form alone
 * rather than a button the vendor would refuse. The query never throws: a failed read draws the
 * email form, which is the part of the door that always works, and the buttons return on the next
 * read.
 */
export const signInMethodsKeys = {
  current: ["sign-in-methods"] as const,
};

export const signInMethodsQuery = queryOptions({
  queryKey: signInMethodsKeys.current,
  queryFn: async (): Promise<SignInMethods> => {
    try {
      return await api<SignInMethods>("/sign-in-methods");
    } catch {
      return { social: [] };
    }
  },
  staleTime: 5 * 60_000,
});

/** What each button says — the provider's own name, in Cando's "Continue with …" form. */
export const SOCIAL_PROVIDER_LABELS: Record<SocialProviderName, string> = {
  google: "Google",
  github: "GitHub",
};

/**
 * Where a provider round trip lands. Better Auth sends the browser to `callbackURL` once the
 * session is open and to `errorCallbackURL` with `?error=<code>` when it is not; both are absolute,
 * on this origin. The success leg goes where the door was asked to return — the `redirect` the
 * guard sent, already judged a same-origin path by `safeRedirectPath` — and the failure leg comes
 * back to this door carrying the same `redirect`, so a handoff survives a cancelled consent.
 */
export function socialSignInUrls(
  origin: string,
  returnTo: string | undefined,
): { callbackURL: string; errorCallbackURL: string } {
  const door = new URL("/login", origin);
  if (returnTo) door.searchParams.set("redirect", returnTo);
  return {
    callbackURL: new URL(returnTo ?? DEFAULT_SIGNED_IN_PATH, origin).toString(),
    errorCallbackURL: door.toString(),
  };
}

/** The codes Better Auth's verify-email GET reports on a token it refused (its spellings, both cases). */
const VERIFICATION_LINK_CODES = [
  "TOKEN_EXPIRED",
  "INVALID_TOKEN",
  "token_expired",
  "invalid_token",
];

/**
 * Where the verification email's link returns the visitor: this door with the search that brought
 * them (`redirect`, so a handoff URL survives the click) and the address (`email`, so a sign-in the
 * link could not complete starts filled). Better Auth's GET verifies, opens the session and
 * redirects here; the door's guard then sends a signed-in visitor where `redirect` says.
 */
export function verificationReturnURL(
  origin: string,
  input: { returnTo: string | undefined; email: string },
): string {
  const door = new URL("/login", origin);
  if (input.returnTo) door.searchParams.set("redirect", input.returnTo);
  door.searchParams.set("email", input.email);
  return door.toString();
}

/**
 * The sentence for a provider round trip that came back with `?error=<code>` — Better Auth's
 * callback codes (`OAUTH_CALLBACK_ERROR_CODES` in its `api/routes/callback`) and the one the
 * vendor itself sends when the person declines. Judged here rather than shown raw: the codes are
 * snake_case identifiers, and the one that matters names a rule of this product (ADR 0020).
 */
export function socialSignInMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (VERIFICATION_LINK_CODES.includes(code)) {
    // A dead verification link (GRA-94): Better Auth's `GET /verify-email` sends the browser back
    // to the door's callbackURL with the code. Signing in re-sends a fresh one (`sendOnSignIn`).
    return "That verification link has expired or was already used. Sign in with your password and we'll send a fresh one.";
  }
  switch (code) {
    // ADR 0020: the address has an account whose own address is not verified, or the provider did
    // not vouch for it — the account is reached the way it was opened.
    case "unable_to_link_account":
      return "That email already has a Graft account. Sign in with your email and password, or with the provider you first used.";
    case "account_already_linked_to_different_user":
    case "email_does_not_match":
      return "That provider account belongs to a different Graft account.";
    case "email_not_found":
      return "The provider shared no email address for that account. Allow it, or continue with email.";
    case "access_denied":
      return "The sign-in was cancelled at the provider.";
    default:
      return "Could not sign in with the provider. Try again, or continue with email.";
  }
}
