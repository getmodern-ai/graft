/**
 * The id Pipedream keys a person's connected accounts by (`external_user_id` on every Connect call).
 * It is the whole tenancy boundary on Pipedream's side: a connect token minted for one external user
 * can only connect an account under that user, and `listAccounts` for one user answers only that
 * user's accounts. So it is derived from the one id that names a person in Graft — the person's,
 * never an agent's, because a connection is the person's (ADR 0007) — under a stable prefix, so a
 * Pipedream project shared with another product cannot collide with Graft's ids and a bare id in
 * Pipedream's console reads as Graft's. Pipedream documents no character rule for the field beyond
 * the example `user-123`, so the prefix stays to letters and hyphens.
 */

export const EXTERNAL_USER_ID_PREFIX = "graft-person-";

export function externalUserIdFor(personId: string): string {
  if (personId.length === 0) throw new Error("an external user id needs a person id");
  return `${EXTERNAL_USER_ID_PREFIX}${personId}`;
}

/** The person an external user id names, or null for one this deployment did not mint. */
export function personIdOf(externalUserId: string): string | null {
  if (!externalUserId.startsWith(EXTERNAL_USER_ID_PREFIX)) return null;
  const personId = externalUserId.slice(EXTERNAL_USER_ID_PREFIX.length);
  return personId.length > 0 ? personId : null;
}
