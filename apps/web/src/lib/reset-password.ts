/**
 * What the reset-password screen decides, kept out of the component that draws it — Cando's
 * `lib/reset-password.ts` (its CAN-166), copied with its test for GRA-82.
 *
 * The screen has one question — "can this visit set a password, right now?" — answered from the
 * URL alone. Deriving it here makes both states reachable in a test without a router or a
 * network, as the other `src/lib` helpers are.
 */

export type ResetPasswordEntry =
  /** A token arrived: show the form. Whether the token still lives is the server's answer. */
  | { kind: "form"; token: string }
  /**
   * No usable token — the link was truncated, hand-mangled, or Better Auth's callback bounced it
   * here with `?error=INVALID_TOKEN`. Dead on arrival; the only honest offer is the request form.
   */
  | { kind: "dead" };

/**
 * `error` outranks `token` on purpose: Better Auth's callback redirect appends `error` when the
 * token it checked was expired or consumed, and a link carrying both is a link the server has
 * already refused. An empty-string token folds into dead — it cannot be exchanged for anything.
 */
export function deriveResetEntry(input: { token?: string; error?: string }): ResetPasswordEntry {
  if (input.error) {
    return { kind: "dead" };
  }
  if (!input.token) {
    return { kind: "dead" };
  }
  return { kind: "form", token: input.token };
}

/**
 * Better Auth's server-side minimum, mirrored so the common miss is caught before the round
 * trip. The server still enforces its own; this is copy, not the gate.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * What is wrong with the typed pair, or null when nothing is. Length before match: a short pair
 * that happens to match should hear about the length, not be told it is fine.
 */
export function passwordPairIssue(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) {
    return "The passwords do not match.";
  }
  return null;
}

export type ResetOutcome =
  /** The password is set — the only outcome that leaves this screen. */
  | { kind: "done" }
  /** The server refused the token — expired, already used, or never real. The link is dead. */
  | { kind: "refused" }
  /** Anything else, with a sentence for the form — too short, network down, server sideways. */
  | { kind: "failed"; message: string };

/**
 * Runs the reset call and folds every way it can end into one of three outcomes.
 *
 * The fold is total on purpose: a *rejection* (connection dropped, server unreachable) becomes
 * `failed` rather than escaping, because an escape would bypass the caller's pending-clearing
 * and leave the form permanently disabled — a dead end with no error and no enabled button
 * (Greptile on Cando's PR #139). `INVALID_TOKEN` is the one refusal that is about the link rather
 * than the password; everything else belongs on the form it came from.
 */
export async function performReset(
  reset: () => Promise<{ error: { code?: string; message?: string } | null }>,
): Promise<ResetOutcome> {
  try {
    const { error } = await reset();
    if (!error) {
      return { kind: "done" };
    }
    if (error.code === "INVALID_TOKEN") {
      return { kind: "refused" };
    }
    return {
      kind: "failed",
      message: error.message ?? "Could not reset your password. Try again.",
    };
  } catch {
    return {
      kind: "failed",
      message: "Could not reset your password. Check your connection and try again.",
    };
  }
}
