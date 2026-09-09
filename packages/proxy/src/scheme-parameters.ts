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
export type SchemeParameterRule = { required: readonly string[]; optional: readonly string[] };

export const SCHEME_PARAMETERS: Record<AuthScheme, SchemeParameterRule> = {
  api_key_header: { required: ["headerName"], optional: ["prefix"] },
  api_key_query: { required: ["queryParam"], optional: [] },
  bearer: { required: [], optional: [] },
  basic: { required: [], optional: [] },
  oauth2_client_credentials: { required: ["tokenUrl"], optional: ["scopes", "clientAuth"] },
  unleashed_hmac: { required: [], optional: [] },
  snowflake_keypair_jwt: { required: ["account", "user"], optional: [] },
};
