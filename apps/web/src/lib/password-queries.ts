import type { SetPasswordBody } from "@graft/server/api";
import { queryOptions } from "@tanstack/react-query";

import { ApiError, api } from "./api";
import { authClient } from "./auth-client";
import { changePasswordFailure } from "./password";

/**
 * How the person signs in, and their password (GRA-298). The accounts are Better Auth's own
 * `listAccounts`, which is what tells a social-only person from one holding a password
 * (`password.ts`'s `passwordModeOf`). A first password goes through `POST /api/me/password`, since
 * Better Auth keeps `setPassword` server-only; a change is Better Auth's `/change-password` with
 * the current one. A refusal from either arrives as an `ApiError`, so the mutation cache's toast
 * reads its sentence (`query-client.ts`).
 */

export const accountKeys = {
  list: ["me", "accounts"] as const,
};

export const accountsQuery = queryOptions({
  queryKey: accountKeys.list,
  queryFn: async () => {
    const { data, error } = await authClient.listAccounts();
    if (error) {
      throw new ApiError(
        error.status,
        error.code ?? "INTERNAL",
        error.message ?? "Could not load how you sign in.",
      );
    }
    return data;
  },
});

export function setFirstPassword(newPassword: string) {
  const body: SetPasswordBody = { newPassword };
  return api<{ set: true }>("/me/password", { method: "POST", body });
}

/**
 * Other sessions are signed out with the change: a password changed because it leaked should not
 * leave whoever used it signed in. Better Auth answers this session a fresh cookie.
 */
export async function changePassword(input: { currentPassword: string; newPassword: string }) {
  const { error } = await authClient.changePassword({ ...input, revokeOtherSessions: true });
  if (error) {
    throw new ApiError(error.status, error.code ?? "INTERNAL", changePasswordFailure(error));
  }
}
