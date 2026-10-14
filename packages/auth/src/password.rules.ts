/**
 * The password's rules, import-free so the console can read them beside the server (GRA-298): the
 * lengths `createAuth` hands Better Auth, and the provider id of the account that holds a password.
 * The two numbers are Better Auth's own defaults, written down so the console's fields and the
 * server's refusal cannot drift from what Better Auth enforces.
 */

/** Better Auth refuses a shorter password with `PASSWORD_TOO_SHORT`. */
export const MIN_PASSWORD_LENGTH = 8;

/** Better Auth refuses a longer password with `PASSWORD_TOO_LONG`. */
export const MAX_PASSWORD_LENGTH = 128;

/** The account Better Auth keeps a password on, beside one per social provider. */
export const CREDENTIAL_PROVIDER_ID = "credential";
