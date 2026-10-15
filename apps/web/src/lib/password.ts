import {
  CREDENTIAL_PROVIDER_ID,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@graft/auth/password.rules";

/**
 * Settings' password row (GRA-298), as decisions: which of the two the person is offered, and what
 * stops a draft before it is sent. The lengths are `@graft/auth`'s, the same numbers Better Auth
 * and `POST /api/me/password` hold a password to, so a draft this passes is never refused for its
 * length.
 */

/** Set a first password (a social-only account), or change the one held. */
export type PasswordMode = "set" | "change";

/**
 * The mode, from Better Auth's `listAccounts`: a person holds a password when one of their
 * accounts is the credential account. A credential row with no password reads as held; Better Auth
 * writes none of those itself.
 */
export function passwordModeOf(accounts: readonly { providerId: string }[]): PasswordMode {
  return accounts.some((account) => account.providerId === CREDENTIAL_PROVIDER_ID)
    ? "change"
    : "set";
}

/** The row's words, per mode. The description is the Figma frame's; the action names the step. */
export const PASSWORD_ROW = {
  title: "Password",
  description: "Sign in with your email and a password.",
  action: { set: "Set a password", change: "Change password" },
} as const satisfies {
  title: string;
  description: string;
  action: Record<PasswordMode, string>;
};

export type PasswordDraft = { current: string; next: string; confirm: string };
export type PasswordField = keyof PasswordDraft;

/**
 * The first thing wrong with a draft, on the field it belongs to, or null when it can be sent.
 * `current` is read only when changing; Better Auth judges whether it is right.
 */
export function passwordDraftProblem(
  mode: PasswordMode,
  draft: PasswordDraft,
): { field: PasswordField; message: string } | null {
  if (mode === "change" && draft.current.length === 0) {
    return { field: "current", message: "Enter your current password." };
  }
  if (draft.next.length < MIN_PASSWORD_LENGTH) {
    return {
      field: "next",
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (draft.next.length > MAX_PASSWORD_LENGTH) {
    return {
      field: "next",
      message: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  if (draft.confirm !== draft.next) {
    return { field: "confirm", message: "The two passwords do not match." };
  }
  return null;
}

/**
 * Better Auth's refusal of a change, as a sentence. A wrong current password is the one a person
 * can fix, so it is said plainly; anything else is Better Auth's own message.
 */
export function changePasswordFailure(error: { code?: string; message?: string }): string {
  if (error.code === "INVALID_PASSWORD") return "That is not your current password.";
  return error.message ?? "Could not change your password. Try again.";
}
