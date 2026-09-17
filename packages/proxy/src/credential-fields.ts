import type { AuthScheme } from "./types";

/**
 * Which credential fields each scheme reads from storage — one table, two readers, and with
 * `scheme-parameters.ts` (the non-secret half) the two modules of this package the console's bundle
 * is meant to reach.
 *
 * The handoff form labels its secret inputs from this and the connection service refuses any other
 * set, so what a person types and what the plugin reads cannot drift (GRA-1, "Connections, schemes
 * and OAuth"). `schemes.test.ts` holds each plugin to this table: a plugin that reads a required
 * field the table does not name, or ignores one it does, fails there.
 *
 * **Import-free on purpose.** The console will reach this file, so everything it reaches is in the
 * browser graph — and `schemes.ts` imports `node:crypto`, which a browser bundle cannot evaluate.
 * Cando learned that the hard way when this table was derived from the plugins (ADR 0011); the
 * runtime may import what it needs, and this file imports nothing.
 */
export const SCHEME_CREDENTIAL_FIELDS: Record<AuthScheme, readonly string[]> = {
  api_key_header: ["apiKey"],
  api_key_query: ["apiKey"],
  bearer: ["token"],
  basic: ["username", "password"],
  oauth2_client_credentials: ["clientId", "clientSecret"],
  /** The client id is not a secret and goes in `schemeConfig` (`scheme-parameters.ts`). */
  oauth_authorization_code: ["clientSecret"],
  unleashed_hmac: ["apiId", "apiKey"],
  snowflake_keypair_jwt: ["privateKey"],
  /** A public API: nothing is entered, and the proxy sends the request as the module made it. */
  none: [],
};

/**
 * Secret fields a scheme reads when present and does without when absent — a passphrase on an
 * encrypted private key. Kept apart from the required table so the plugin test's rule ("every named
 * field missing is a refusal that names it") stays exact; the handoff form renders these as optional.
 */
export const SCHEME_OPTIONAL_CREDENTIAL_FIELDS: Partial<Record<AuthScheme, readonly string[]>> = {
  snowflake_keypair_jwt: ["privateKeyPassphrase"],
};

/**
 * Fields the **vendor issues and Graft writes** into the stored credential, beside what the person
 * typed: the tokens an authorization-code consent yields and when the access token dies (ADR 0005).
 * The person never types one — the form does not render them and the entry rule refuses them — and
 * they are absent until the consent completes, which is the "awaiting consent" state the console
 * shows and the proxy refuses as `consent_required`. The callback route and the refresh write them;
 * the plugin reads them. `expiresAt` is an ISO instant, not a secret, kept here so the token and its
 * lifetime are one write.
 */
export const SCHEME_ISSUED_CREDENTIAL_FIELDS: Partial<Record<AuthScheme, readonly string[]>> = {
  oauth_authorization_code: ["accessToken", "refreshToken", "expiresAt"],
};
