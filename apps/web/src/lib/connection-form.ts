import {
  HOST_NOT_PUBLIC,
  validateCredentialFields,
  validateDisplayName,
  validateHostSet,
  validateSchemeConfig,
  validateVendor,
} from "@graft/core/connection/connection.rules";
import {
  GOOGLE_TESTING_MODE_NOTICE,
  hasGoogleHost,
  isOAuthAuthorizationCode,
} from "@graft/core/connection/oauth.rules";
import {
  SCHEME_CREDENTIAL_FIELDS,
  SCHEME_OPTIONAL_CREDENTIAL_FIELDS,
} from "@graft/proxy/credential-fields";
import { SCHEME_PARAMETERS } from "@graft/proxy/scheme-parameters";
import { AUTH_SCHEMES, type AuthScheme } from "@graft/proxy/types";

/**
 * The connection form's rules and vocabulary (GRA-28; ADR 0006) — pure, so the form validates as
 * the person types with exactly the functions the connection service applies at create and the
 * meta-tool applied to the agent's proposal (`@graft/core/connection/connection.rules`), and renders
 * a scheme's parameter and secret inputs from the proxy's two tables (`@graft/proxy/scheme-parameters`,
 * `@graft/proxy/credential-fields`). Nothing about a scheme is written a second time here: the
 * labels below are prose for field *names* the tables define, and a name without a label falls back
 * to the name.
 *
 * The three imports are the browser-safe modules those packages keep import-free for this reason;
 * `vite build` (run first by `check-types`) is what fails if one of them ever reaches `node:crypto`.
 */

export const SCHEMES: readonly AuthScheme[] = AUTH_SCHEMES;

export const SCHEME_LABELS: Record<AuthScheme, string> = {
  api_key_header: "API key in a header",
  api_key_query: "API key in a query parameter",
  bearer: "Bearer token",
  basic: "Username and password",
  oauth2_client_credentials: "OAuth2 client credentials",
  oauth_authorization_code: "OAuth consent (a client you register)",
  unleashed_hmac: "Unleashed HMAC (API id and key)",
  snowflake_keypair_jwt: "Snowflake key-pair JWT",
  none: "No credential (public API)",
};

type FieldPresentation = { label: string; hint?: string; multiline?: boolean };

/** Prose for the field names the two tables define — secret fields and scheme parameters alike. */
const FIELD_PRESENTATION: Record<string, FieldPresentation> = {
  apiKey: { label: "API key" },
  apiId: { label: "API id" },
  token: { label: "Token" },
  username: { label: "Username" },
  password: { label: "Password" },
  clientId: { label: "Client id", hint: "From the OAuth client you registered at the vendor." },
  clientSecret: { label: "Client secret" },
  privateKey: { label: "Private key", hint: "PEM, as the vendor issued it.", multiline: true },
  privateKeyPassphrase: { label: "Private key passphrase" },
  headerName: { label: "Header name", hint: "e.g. x-api-key" },
  prefix: { label: "Prefix", hint: "Put before the key in the header, e.g. Bearer or Token." },
  queryParam: { label: "Query parameter" },
  authorizeUrl: {
    label: "Authorize URL",
    hint: "Where the consent runs, from the vendor's OAuth documentation — https, on a public host.",
  },
  tokenUrl: { label: "Token URL", hint: "https, on a public host." },
  scopes: { label: "Scopes", hint: "Space-separated, as the vendor lists them." },
  clientAuth: { label: "Client authentication", hint: "basic or body." },
  account: { label: "Account" },
  user: { label: "User" },
};

export function presentField(name: string): FieldPresentation {
  return FIELD_PRESENTATION[name] ?? { label: name };
}

export type FormField = { name: string; required: boolean; presentation: FieldPresentation };

/** The secret inputs a scheme needs, required first — the table's word, never the form's. */
export function credentialFieldsFor(scheme: AuthScheme): FormField[] {
  return [
    ...SCHEME_CREDENTIAL_FIELDS[scheme].map((name) => ({
      name,
      required: true,
      presentation: presentField(name),
    })),
    ...(SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? []).map((name) => ({
      name,
      required: false,
      presentation: presentField(name),
    })),
  ];
}

/**
 * The non-secret parameter inputs a scheme takes, required first. The parameters the person
 * supplies rather than the agent — an OAuth client id (ADR 0005) — are required inputs too: a
 * proposal arrives with them blank, and the form will not submit without them.
 */
export function parametersFor(scheme: AuthScheme): FormField[] {
  const rule = SCHEME_PARAMETERS[scheme];
  return [
    ...rule.required.map((name) => ({ name, required: true, presentation: presentField(name) })),
    ...(rule.personEntered ?? []).map((name) => ({
      name,
      required: true,
      presentation: presentField(name),
    })),
    ...rule.optional.map((name) => ({ name, required: false, presentation: presentField(name) })),
  ];
}

export function isScheme(value: string): value is AuthScheme {
  return (SCHEMES as readonly string[]).includes(value);
}

/** Whether the draft's scheme runs a consent after the secret is entered (ADR 0005). */
export function isOAuthDraft(draft: Pick<ConnectionDraft, "scheme">): boolean {
  return isOAuthAuthorizationCode(draft.scheme);
}

/**
 * The Google Testing-mode sentence (ADR 0005), when the draft is an OAuth consent and any host it
 * reaches — or its authorize endpoint — is Google's; null for every other draft, so the notice
 * appears for Google and nowhere else. Read from the hosts as typed, so it appears as the person
 * fills the form rather than only once every host passes.
 */
export function googleNoticeFor(draft: ConnectionDraft): string | null {
  if (!isOAuthAuthorizationCode(draft.scheme)) return null;
  const hosts = [...parseHostList(draft.hosts)];
  try {
    hosts.push(new URL(draft.primaryHost.trim()).hostname);
  } catch {
    // Not a URL yet; the additional hosts and the authorize URL may still say.
  }
  return hasGoogleHost(hosts, draft.schemeConfig.authorizeUrl) ? GOOGLE_TESTING_MODE_NOTICE : null;
}

/** What the form holds while the person edits: strings, the hosts as typed, one entry per line or comma. */
export type ConnectionDraft = {
  vendor: string;
  displayName: string;
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: string;
  credential: Record<string, string>;
};

/** Errors by input: `vendor`, `displayName`, `primaryHost`, `hosts`, `schemeConfig.<name>`, `credential.<name>`. */
export type DraftErrors = Partial<Record<string, string>>;

/** What the server takes once the draft passes: the registration as `POST /api/connections` reads it. */
export type ConnectionRegistration = {
  vendor: string;
  displayName: string;
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: string[];
};

export type DraftVerdict =
  | { ok: true; value: ConnectionRegistration & { credential: Record<string, string> } }
  | { ok: false; errors: DraftErrors };

/** Additional hosts as typed — one per line or comma-separated — trimmed, empty lines dropped. */
export function parseHostList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/** A parameter or credential map with blank optional entries dropped — an empty string is not a value. */
export function compact(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim().length > 0));
}

export function emptyFields(fields: readonly FormField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.name, ""]));
}

/** The first field name a rule's sentence mentions, so the sentence lands under its input. */
function fieldNamed(message: string, fields: readonly FormField[]): string | null {
  return fields.find((field) => message.includes(field.name))?.name ?? null;
}

/** The hostname a host set refusal names belongs to the primary input, or to the additional list. */
function hostInput(draft: ConnectionDraft, host: string | undefined): "primaryHost" | "hosts" {
  if (!host) return "primaryHost";
  try {
    const primary = new URL(draft.primaryHost.trim());
    if (primary.hostname === host) return "primaryHost";
  } catch {
    return "primaryHost";
  }
  return parseHostList(draft.hosts).some((candidate) => candidate.toLowerCase().includes(host))
    ? "hosts"
    : "primaryHost";
}

/**
 * The whole draft against the service's rules, every input judged so the person fixes them in one
 * pass. `withCredential: false` skips the secret fields — the person-initiated Add connection and
 * an agent's proposal both carry them; only the preview of the hosts does not.
 */
export function validateConnectionDraft(
  draft: ConnectionDraft,
  options: { withCredential: boolean } = { withCredential: true },
): DraftVerdict {
  const errors: DraftErrors = {};
  const vendor = draft.vendor.trim();
  const vendorProblem = validateVendor(vendor);
  if (vendorProblem) errors.vendor = vendorProblem;
  const displayName = draft.displayName.trim();
  const nameProblem = validateDisplayName(displayName);
  if (nameProblem) errors.displayName = nameProblem;

  const schemeConfig = compact(draft.schemeConfig);
  const configProblem = validateSchemeConfig(draft.scheme, schemeConfig);
  if (configProblem) {
    const name = fieldNamed(configProblem, parametersFor(draft.scheme));
    errors[name ? `schemeConfig.${name}` : "schemeConfig"] = configProblem;
  }

  const hostSet = validateHostSet(draft.primaryHost, parseHostList(draft.hosts));
  if (!hostSet.ok) {
    const input = hostInput(draft, hostSet.host);
    errors[input] =
      hostSet.reason === HOST_NOT_PUBLIC
        ? `${hostSet.problem}. A credential is only ever sent to a public host.`
        : hostSet.problem;
  }

  const credential = compact(draft.credential);
  if (options.withCredential) {
    const problem = validateCredentialFields(draft.scheme, credential);
    if (problem) {
      const name = fieldNamed(problem, credentialFieldsFor(draft.scheme));
      errors[name ? `credential.${name}` : "credential"] = problem;
    }
  }

  if (Object.keys(errors).length > 0 || !hostSet.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      vendor,
      displayName,
      scheme: draft.scheme,
      schemeConfig,
      primaryHost: hostSet.primaryHost,
      hosts: hostSet.hosts,
      credential,
    },
  };
}

/** The secret fields alone — the re-entry dialog and the credential ask. */
export function validateCredentialDraft(
  scheme: AuthScheme,
  credential: Record<string, string>,
): { ok: true; value: Record<string, string> } | { ok: false; errors: DraftErrors } {
  const value = compact(credential);
  const problem = validateCredentialFields(scheme, value);
  if (!problem) return { ok: true, value };
  const name = fieldNamed(problem, credentialFieldsFor(scheme));
  return { ok: false, errors: { [name ? `credential.${name}` : "credential"]: problem } };
}

/**
 * The hosts the credential will be sent to, as the form stands — what the notice beside the secret
 * inputs lists (ADR 0006: the page names the vendor host). Null while the hosts do not pass.
 */
export function hostsOf(draft: ConnectionDraft): string[] | null {
  const verdict = validateHostSet(draft.primaryHost, parseHostList(draft.hosts));
  return verdict.ok ? verdict.hosts : null;
}

/** A draft from an agent's proposal, the primary's own hostname taken out of the additional list. */
export function draftFromProposal(proposal: {
  vendor: string;
  displayName: string;
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: readonly string[];
}): ConnectionDraft {
  let primaryHostname: string | null = null;
  try {
    primaryHostname = new URL(proposal.primaryHost).host.toLowerCase();
  } catch {
    primaryHostname = null;
  }
  return {
    vendor: proposal.vendor,
    displayName: proposal.displayName,
    scheme: proposal.scheme,
    schemeConfig: { ...emptyFields(parametersFor(proposal.scheme)), ...proposal.schemeConfig },
    primaryHost: proposal.primaryHost,
    hosts: proposal.hosts.filter((host) => host.toLowerCase() !== primaryHostname).join("\n"),
    credential: emptyFields(credentialFieldsFor(proposal.scheme)),
  };
}

/** A blank draft for the person's own Add connection. */
export function emptyDraft(scheme: AuthScheme = "api_key_header"): ConnectionDraft {
  return {
    vendor: "",
    displayName: "",
    scheme,
    schemeConfig: emptyFields(parametersFor(scheme)),
    primaryHost: "https://",
    hosts: "",
    credential: emptyFields(credentialFieldsFor(scheme)),
  };
}

/** The draft after the person picks another scheme: its parameters and secret fields, blank. */
export function withScheme(draft: ConnectionDraft, scheme: AuthScheme): ConnectionDraft {
  return {
    ...draft,
    scheme,
    schemeConfig: emptyFields(parametersFor(scheme)),
    credential: emptyFields(credentialFieldsFor(scheme)),
  };
}
