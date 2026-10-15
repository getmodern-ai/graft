import type { SocialProviderName } from "@graft/auth";
import { CREDENTIAL_PROVIDER_ID } from "@graft/auth/password.rules";

import { SOCIAL_PROVIDER_LABELS } from "./sign-in";

/**
 * Settings › Account (GRA-331; Figma 2100:10414), as decisions: which provider rows to draw, which
 * of them may be disconnected, where a link round trip returns, and the sentences for what Better
 * Auth refuses. The accounts are `listAccounts`' rows, the same read the password row takes
 * (`password-queries.ts`); the providers are the ones `GET /api/sign-in-methods` names (ADR 0020).
 */

type AccountRow = { id: string; providerId: string };

/** One provider's row: the account linked for it, if any, and whether it may be removed. */
export type SocialRow = {
  provider: SocialProviderName;
  /** The Better Auth account id `unlinkAccount` takes, or null when nothing is linked. */
  accountId: string | null;
  /** False when this account is the person's last way of signing in. */
  canDisconnect: boolean;
};

/**
 * A way of signing in the person can still use: the password, or a provider this deployment holds
 * a client for. A linked account for a provider the server no longer names is not one, since its
 * button is gone from the door, so it never counts toward what is left.
 */
function isUsableMethod(account: AccountRow, configured: readonly SocialProviderName[]): boolean {
  return (
    account.providerId === CREDENTIAL_PROVIDER_ID ||
    (configured as readonly string[]).includes(account.providerId)
  );
}

/**
 * Whether removing `provider`'s account would leave the person a way to sign in. Better Auth
 * refuses only the removal of the very last account row (`FAILED_TO_UNLINK_LAST_ACCOUNT`); this
 * is stricter, counting only the methods the door still offers, so the console never offers a
 * removal that would lock the person out.
 */
export function canDisconnect(
  accounts: readonly AccountRow[],
  configured: readonly SocialProviderName[],
  provider: SocialProviderName,
): boolean {
  return accounts.some(
    (account) => account.providerId !== provider && isUsableMethod(account, configured),
  );
}

/** A row per provider the server names, in its order; never one for a provider it does not. */
export function socialRows(
  accounts: readonly AccountRow[],
  configured: readonly SocialProviderName[],
): SocialRow[] {
  return configured.map((provider) => {
    const account = accounts.find((candidate) => candidate.providerId === provider);
    return {
      provider,
      accountId: account?.id ?? null,
      canDisconnect: account ? canDisconnect(accounts, configured, provider) : false,
    };
  });
}

/**
 * Where `linkSocial` returns the browser: Settings, with `provider` naming the provider on both
 * legs so the page can say which one it was; Better Auth appends `error=<code>` to the failure leg.
 * Both are absolute on this origin, as Better Auth requires.
 */
export function linkSocialUrls(
  origin: string,
  provider: SocialProviderName,
): { callbackURL: string; errorCallbackURL: string } {
  const back = new URL("/settings", origin);
  back.searchParams.set("provider", provider);
  return { callbackURL: back.toString(), errorCallbackURL: back.toString() };
}

/**
 * The sentence for a link round trip that came back with `?error=<code>` (Better Auth's
 * `OAUTH_CALLBACK_ERROR_CODES`, and the vendor's own `access_denied`). An address that differs from
 * the account's is allowed (GRA-287 item 8; `accountLinking.allowDifferentEmails` in
 * `@graft/auth`), so `email_does_not_match` should not arrive; it keeps a sentence for a server
 * configured otherwise.
 */
export function linkSocialMessage(code: string, label: string): string {
  switch (code) {
    case "account_already_linked_to_different_user":
      return `That ${label} account already signs in to a different Graft account.`;
    case "unable_to_link_account":
    case "email_not_verified":
      return `${label} has not verified that account's email address, so it cannot sign in to Graft.`;
    case "email_does_not_match":
      return `That ${label} account's email address is not yours on Graft.`;
    case "email_not_found":
      return `${label} shared no email address for that account. Allow it and try again.`;
    case "access_denied":
      return `Connecting ${label} was cancelled.`;
    default:
      return `Could not connect ${label}. Try again.`;
  }
}

/** Settings' search: what a link round trip returned with, and nothing else. */
export type SettingsSearch = { provider?: SocialProviderName; error?: string };

export function readSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const provider = (Object.keys(SOCIAL_PROVIDER_LABELS) as SocialProviderName[]).find(
    (name) => name === search.provider,
  );
  const error = typeof search.error === "string" && search.error.length > 0 ? search.error : null;
  return { ...(provider ? { provider } : {}), ...(error ? { error } : {}) };
}

/**
 * What the page says on arriving back from a link: Better Auth's refusal when the leg carries one,
 * else that the provider is connected. Nothing without a provider, since a bare `error` is not a
 * link's.
 */
export function linkOutcome(
  search: SettingsSearch,
): { kind: "success" | "error"; message: string } | null {
  if (!search.provider) return null;
  const label = SOCIAL_PROVIDER_LABELS[search.provider];
  if (search.error) return { kind: "error", message: linkSocialMessage(search.error, label) };
  return { kind: "success", message: `${label} is connected. You can sign in with it now.` };
}

/**
 * Better Auth's refusal of a disconnect, as a sentence. Removing a sign-in method needs a session
 * opened within the last day (`freshAge`), so an older one is told to sign in again.
 */
export function unlinkFailure(error: { code?: string; message?: string }, label: string): string {
  switch (error.code) {
    case "SESSION_NOT_FRESH":
      return `To disconnect ${label}, sign out and sign in again first.`;
    case "FAILED_TO_UNLINK_LAST_ACCOUNT":
      return `${label} is your only way to sign in. Set a password or connect another account first.`;
    default:
      return error.message ?? `Could not disconnect ${label}. Try again.`;
  }
}

/** The console's bound on a name; the column is unbounded, and this keeps it a name. */
export const MAX_NAME_LENGTH = 100;

/** What is wrong with a name draft, or null when it can be sent. It is sent trimmed. */
export function nameDraftProblem(draft: string): string | null {
  const name = draft.trim();
  if (name.length === 0) return "Enter your name.";
  if (name.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

/** The theme choices, in the Figma frame's order. */
export const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export type ThemeChoice = (typeof THEME_OPTIONS)[number]["value"];

/** `next-themes` answers `undefined` before it has read storage; that reads as the default. */
export function themeChoiceOf(theme: string | undefined): ThemeChoice {
  return THEME_OPTIONS.find((option) => option.value === theme)?.value ?? "system";
}
