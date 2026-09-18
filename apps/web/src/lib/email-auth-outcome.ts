/**
 * Which message to show when creating an account on `/signup` fails — Cando's `email-auth-outcome.ts`
 * as it stands after its two doors (ADR 0020 as amended for GRA-94; Cando's CAN-459).
 *
 * Sign-up is its own door again, so this no longer arbitrates between a sign-in failure and a
 * registration failure. What is left is the one translation the sign-up door owes its visitor:
 * `USER_ALREADY_EXISTS` means they are standing at the wrong door, and Better Auth's own "User
 * already exists" names the problem without the exit. The message points at signing in; the card's
 * footer link is the way there.
 *
 * With verification on, Better Auth conceals a taken address — it answers a 200 that opened no
 * session, and `attemptEmailSignUp` reads that as "check your email" — so this code should no longer
 * arrive. It is kept for the one path that can still produce it: two registrations racing on one
 * fresh address, where the loser meets the endpoint's own 422.
 */
type AuthError = { code?: string; message?: string };

/**
 * Both spellings, because Better Auth renamed the code: 1.7's sign-up route throws
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (`BASE_ERROR_CODES` still carries the older
 * `USER_ALREADY_EXISTS` for other paths). Matching only the older one is how a door shows the raw
 * "Use another email" — measured against the local server under GRA-81.
 */
const ALREADY_REGISTERED_CODES = ["USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"];

const ALREADY_REGISTERED_MESSAGE = "This email is already registered — sign in instead.";

function signUpFailureMessage(error: AuthError): string {
  if (error.code !== undefined && ALREADY_REGISTERED_CODES.includes(error.code)) {
    return ALREADY_REGISTERED_MESSAGE;
  }
  // A real refusal with a real reason — a password below the minimum length is the common one —
  // so the server's sentence is the useful one. The fallback exists for a refusal that arrives
  // with no message at all; it must not claim anything about the address being taken.
  return error.message ?? "We couldn't create your account. Try again.";
}

export { ALREADY_REGISTERED_MESSAGE, signUpFailureMessage };
