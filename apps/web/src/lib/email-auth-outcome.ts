/**
 * Which message to show when the one email door fails — Cando's rule, copied with its test (its
 * `apps/web/src/lib/email-auth-outcome.ts`, CAN-64; GRA-81).
 *
 * There is no sign-up screen: an address the product has never seen has to be *registered* at
 * the same prompt that signs everyone else in. So the route tries to sign in, and registers
 * only if that fails.
 *
 * It cannot ask which case it is first. Better Auth deliberately returns the same failure for
 * "no such account" and "wrong password" — telling them apart is account enumeration, and the
 * ambiguity is the point. That leaves the *registration* attempt as the only way to find out,
 * and its outcome is what decides the message:
 *
 * - registration rejected because the address is taken → the account exists, so the sign-in
 *   failure was a wrong password, and that is what to say;
 * - registration rejected for any other reason → the address is new and the reason is real
 *   (a password below the minimum length is the common one). Showing the sign-in error here
 *   would tell someone their brand-new password "did not match" an account they do not have.
 */
type AuthError = { code?: string; message?: string } | null | undefined;

const WRONG_PASSWORD = "That email and password did not match.";
/**
 * Both spellings Better Auth has used for the taken address: Cando's version answers
 * `USER_ALREADY_EXISTS`, the 1.7 line this repository pins answers
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (measured against the local server, GRA-81). A code
 * matched too narrowly would fall through to the registration message — "Use another email", to
 * the person whose email it is.
 */
const ALREADY_REGISTERED = ["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"];

function emailAuthMessage(signInError: AuthError, signUpError: AuthError): string | null {
  // Registration succeeded, so whatever sign-in said is history.
  if (!signUpError) {
    return null;
  }

  if (signUpError.code !== undefined && ALREADY_REGISTERED.includes(signUpError.code)) {
    return signInError?.message ?? WRONG_PASSWORD;
  }

  return signUpError.message ?? WRONG_PASSWORD;
}

export { emailAuthMessage, WRONG_PASSWORD };
