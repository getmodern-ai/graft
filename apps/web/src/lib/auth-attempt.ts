import { signUpFailureMessage } from "@/lib/email-auth-outcome";

/**
 * Making the auth doors total over a thrown network failure — Cando's `auth-attempt.ts` (its
 * CAN-245, CAN-476), copied for GRA-94.
 *
 * `authClient.signIn.email`, `.signUp.email` and `.signIn.social` normally *answer* with an
 * `{ error }` rather than throwing — that is what lets `email-auth-outcome.ts` stay a pure decision
 * over a returned value. A request that never reaches the server does not get to answer, so it
 * rejects the promise instead, and an `await` with nothing around it turns that into an unhandled
 * rejection: the route's `pending` state never clears, and the form is stuck disabled with no way
 * to retry short of a reload. This module is where every one of those `await`s is wrapped, so the
 * routes only handle a closed set of shapes — "signed in", "here is what to show", "check your
 * email" — never a rejection.
 */

/**
 * Shown for a thrown network failure — deliberately not a credentials message. Nothing about the
 * address or password was rejected; the request itself did not complete.
 */
export const NETWORK_FAILURE_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";

type AuthError = { code?: string; message?: string } | null | undefined;

/**
 * The sign-in door's outcomes. The third is verification's: the account exists and the password
 * was right, but the address is not verified yet — the server has just re-sent the link
 * (`emailVerification.sendOnSignIn`), so the door's job is to say "check your email", not to show
 * a refusal. `error: null` is what tells it apart from one.
 */
export type EmailAuthAttempt =
  | { signedIn: true }
  | { signedIn: false; error: string }
  | { signedIn: false; error: null; emailNotVerified: true };

/**
 * The sign-up door's outcomes. A registration opens no session until the address is verified, so
 * the ordinary success is the third shape: a 200 with no token, meaning a verification email is on
 * its way. That is also what a taken address answers — Better Auth shapes both identically so the
 * wire confirms nothing — and the door shows the same "check your email" for both; the inbox tells
 * them apart. `signedIn: true` remains for a configuration that verifies nothing.
 */
export type EmailSignUpAttempt =
  | { signedIn: true }
  | { signedIn: false; error: string }
  | { signedIn: false; error: null; verificationSent: true };

/**
 * One click of `/login`'s email door. `callbackURL` is where the link an *unverified* sign-in
 * re-sends returns the visitor (`sendOnSignIn`); a verified sign-in ignores it. The failure message
 * is passed through as the server sent it,
 * and Better Auth keeps it deliberately ambiguous: "no such account" and "wrong password" get the
 * identical `INVALID_EMAIL_OR_PASSWORD` 401. Distinguishing the two here would be account
 * enumeration, the stance the forgot-password screen and the sign-up door take too.
 */
export async function attemptEmailSignIn(
  input: { email: string; password: string; callbackURL?: string },
  signIn: (input: {
    email: string;
    password: string;
    callbackURL?: string;
  }) => Promise<{ error?: AuthError }>,
): Promise<EmailAuthAttempt> {
  try {
    const { error } = await signIn(input);
    if (!error) {
      return { signedIn: true };
    }
    // Right password, unverified address: the server has re-sent the link, and this is the one 403
    // that is not a refusal. Only reachable with correct credentials — Better Auth checks the
    // password first — so it confirms nothing a wrong password would not.
    if (error.code === "EMAIL_NOT_VERIFIED") {
      return { signedIn: false, error: null, emailNotVerified: true };
    }
    return { signedIn: false, error: error.message ?? "We couldn't sign you in. Try again." };
  } catch {
    return { signedIn: false, error: NETWORK_FAILURE_MESSAGE };
  }
}

/**
 * One click of `/signup`'s "Create account". `callbackURL` is where the emailed link returns the
 * visitor once it has done its work. The name is the address's local part: the console shows it in
 * the account menu and has no step that asks for a better one yet, and Better Auth requires one.
 */
export async function attemptEmailSignUp(
  input: { email: string; password: string; callbackURL: string },
  signUp: (input: {
    email: string;
    password: string;
    name: string;
    callbackURL: string;
  }) => Promise<{ data?: { token: string | null } | null; error?: AuthError }>,
): Promise<EmailSignUpAttempt> {
  try {
    const { data, error } = await signUp({
      ...input,
      name: input.email.split("@")[0] || input.email,
    });
    if (error) {
      return { signedIn: false, error: signUpFailureMessage(error) };
    }
    if (data?.token) {
      return { signedIn: true };
    }
    return { signedIn: false, error: null, verificationSent: true };
  } catch {
    // The request may have landed server-side even though the response never came back. The
    // recovery is still an ordinary retry: a registration that landed answers the retry as a taken
    // address — "check your email" — and the inbox already holds the verification link.
    return { signedIn: false, error: NETWORK_FAILURE_MESSAGE };
  }
}

/**
 * One click of a provider button, made total the same way: `run` performs the redirect handoff and
 * can itself reject on a network failure before the browser ever leaves this page.
 */
export async function attemptSocialSignIn(
  provider: string,
  run: () => Promise<{ error?: AuthError }>,
): Promise<{ error: string | null }> {
  try {
    const { error } = await run();
    if (!error) {
      return { error: null };
    }
    return { error: error.message ?? `Could not continue with ${provider}.` };
  } catch {
    return { error: NETWORK_FAILURE_MESSAGE };
  }
}
