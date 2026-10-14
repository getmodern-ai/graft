import type { SocialProviderName } from "@graft/auth";

import { linkSocialUrls, unlinkFailure } from "./account-settings";
import { ApiError } from "./api";
import { authClient } from "./auth-client";
import { SOCIAL_PROVIDER_LABELS } from "./sign-in";

/**
 * Settings › Account's writes (GRA-331), each Better Auth's own route: `/update-user` for the
 * name, `/link-social` and `/unlink-account` for a provider. The accounts read they change is
 * `password-queries.ts`'s `accountsQuery`, shared with the password row. A refusal arrives as an
 * `ApiError`, so the mutation cache's toast reads its sentence (`query-client.ts`).
 */

/** Better Auth refreshes its session store after `/update-user`, so the account menu follows. */
export async function updateName(name: string) {
  const { error } = await authClient.updateUser({ name: name.trim() });
  if (error) {
    throw new ApiError(
      error.status,
      error.code ?? "INTERNAL",
      error.message ?? "Could not save your name. Try again.",
    );
  }
}

/**
 * Starts the provider's consent and leaves the page: Better Auth answers the provider's URL and its
 * client navigates there, returning to Settings (`linkSocialUrls`), where the route reads the
 * outcome off the query.
 */
export async function linkProvider(provider: SocialProviderName) {
  const { error } = await authClient.linkSocial({
    provider,
    ...linkSocialUrls(window.location.origin, provider),
  });
  if (error) {
    throw new ApiError(
      error.status,
      error.code ?? "INTERNAL",
      error.message ?? `Could not connect ${SOCIAL_PROVIDER_LABELS[provider]}. Try again.`,
    );
  }
}

export async function unlinkProvider(input: { provider: SocialProviderName; accountId: string }) {
  const { error } = await authClient.unlinkAccount({ accountId: input.accountId });
  if (error) {
    throw new ApiError(
      error.status,
      error.code ?? "INTERNAL",
      unlinkFailure(error, SOCIAL_PROVIDER_LABELS[input.provider]),
    );
  }
}
