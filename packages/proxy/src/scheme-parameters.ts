import type { AuthScheme } from "./types";

/**
 * What each scheme plugin is parameterised by — the non-secret half of the scheme table, beside the
 * secret half in `credential-fields.ts`. Keyed by the scheme enum so adding a scheme without saying
 * what it takes fails to compile. Nothing here is a secret: a header *name* and a *prefix*, a query
 * parameter *name*, a token *endpoint*, *scopes*, where the OAuth2 client authenticates, a Snowflake
 * *account* and *user*. The plugins in `schemes.ts` read exactly these keys off `SchemeConfig`.
 *
 * **Import-free on purpose, like `credential-fields.ts`.** The console's connection form renders a
 * scheme's parameter inputs from this table and its secret inputs from the other, so one definition
 * reaches the form, the connection service and the plugin (ADR 0006: the handoff carries everything
 * that is not secret, and this is the list of what that is). The runtime may import what it needs;
 * this file imports nothing so the browser graph stays free of `node:crypto`.
 */
export type SchemeParameterRule = {
  /** Present on every connection of the scheme — the agent proposes these from the documentation. */
  required: readonly string[];
  optional: readonly string[];
  /**
   * Required too, but the person's to supply on the form rather than the agent's to propose: a
   * client id the person registered at the vendor, which the agent cannot know (ADR 0005). A
   * proposal may omit these; a registration may not.
   */
  personEntered?: readonly string[];
};

export const SCHEME_PARAMETERS: Record<AuthScheme, SchemeParameterRule> = {
  api_key_header: { required: ["headerName"], optional: ["prefix"] },
  api_key_query: { required: ["queryParam"], optional: [] },
  bearer: { required: [], optional: [] },
  basic: { required: [], optional: [] },
  oauth2_client_credentials: { required: ["tokenUrl"], optional: ["scopes", "clientAuth"] },
  /**
   * The two endpoints and the scopes come from the vendor's OAuth documentation; the client id is
   * the person's, registered at the vendor with the redirect URI Graft serves. `clientAuth` says
   * where the client secret goes on the token request — `body` by default here, unlike the
   * client-credentials scheme, because that is what the authorization-code servers in the wild
   * document (Google, GitHub, Microsoft); `basic` for one that insists on RFC 6749 §2.3.1.
   */
  oauth_authorization_code: {
    required: ["authorizeUrl", "tokenUrl"],
    optional: ["scopes", "clientAuth"],
    personEntered: ["clientId"],
  },
  unleashed_hmac: { required: [], optional: [] },
  snowflake_keypair_jwt: { required: ["account", "user"], optional: [] },
  none: { required: [], optional: [] },
};

/** Every parameter a registered connection of the scheme must carry — the agent's and the person's. */
export function requiredParametersOf(rule: SchemeParameterRule): string[] {
  return [...rule.required, ...(rule.personEntered ?? [])];
}
