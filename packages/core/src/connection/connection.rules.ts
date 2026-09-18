import type { ConnectionScheme } from "@graft/db/schema/connection";
import {
  SCHEME_CREDENTIAL_FIELDS,
  SCHEME_ISSUED_CREDENTIAL_FIELDS,
  SCHEME_OPTIONAL_CREDENTIAL_FIELDS,
} from "@graft/proxy/credential-fields";
import { isPublicHost } from "@graft/proxy/public-host";
import {
  requiredParametersOf,
  SCHEME_PARAMETERS,
  type SchemeParameterRule,
} from "@graft/proxy/scheme-parameters";
import { type AuthScheme, isAuthScheme } from "@graft/proxy/types";

import { isKebabCase } from "../kebab-case";

/**
 * The rules that make a connection registrable (GRA-1, "Connections, schemes and OAuth"): the
 * vendor slug's shape, the host set's address rule, and what each scheme needs in its non-secret
 * configuration and in its credential. Total functions over strings — no `ctx`, no `deps` — so the
 * service stays about orchestration and these get a test that needs no fakes.
 *
 * Each validator answers with a sentence a person can act on, or with the normalised value. The
 * address rule and the two halves of the scheme table come from `@graft/proxy`: the proxy applies
 * `isPublicHost` again at resolution (ADR 0010), and its scheme plugins are the side that knows
 * which fields a credential must hold — this package imports from the proxy, never the reverse.
 *
 * **This module is browser-safe, and the console depends on that.** Its imports are the proxy's
 * three import-free tables and a type, so `@graft/core/connection/connection.rules` is what the
 * connection form validates with — the same functions the service and the meta-tool call, which is
 * what makes "refused at the form and again at the proxy" (GRA-28) one rule rather than three. An
 * import of `@graft/proxy`'s index or of a repo here would pull `node:crypto` and drizzle into the
 * console's bundle; `apps/web`'s `vite build` is what fails when that happens.
 */

/** Bounds a slug that lands in a path and a header, and keeps the console's tables readable. */
export const VENDOR_MAX_LENGTH = 64;
export const DISPLAY_NAME_MAX_LENGTH = 120;

/** Kebab-case, like a tool's name: with the person and the name it is a tool's identity. */
export function validateVendor(vendor: string): string | null {
  if (vendor.length === 0 || vendor.length > VENDOR_MAX_LENGTH) {
    return `A vendor slug is 1 to ${VENDOR_MAX_LENGTH} characters`;
  }
  if (!isKebabCase(vendor)) {
    return "A vendor slug is lowercase letters, digits and single hyphens, like unleashed or google-workspace";
  }
  return null;
}

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `A connection's display name is 1 to ${DISPLAY_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Why a host set was refused, for a caller whose next sentence turns on it: `host_not_public` is the
 * address rule (ADR 0010) and travels as a `reason` word the API, the meta-tool and the form all
 * show; `invalid` is everything else about the shape. The offending host rides along when there is
 * one, so the form can mark the input it belongs to.
 */
export type HostSetRefusal = {
  ok: false;
  problem: string;
  reason: "host_not_public" | "invalid";
  host?: string;
};

export type HostSetVerdict = { ok: true; primaryHost: string; hosts: string[] } | HostSetRefusal;

export const HOST_NOT_PUBLIC = "host_not_public";

/** A hostname, optionally with a port — what the explicit proxy form carries as its host segment. */
const HOSTNAME_WITH_PORT =
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(:\d{1,5})?$/;

/**
 * The primary host is https, on a public host, with no credentials, query or fragment — and
 * normalised so the stored value is `origin` plus an optional path with no trailing slash, which is
 * what the proxy appends the vendor path to. The additional hosts are hostnames, public, lowercase,
 * de-duplicated, with the primary's hostname added so the set the person saw on the handoff page is
 * the set the proxy pins to (ADR 0010). The host check is on the literal only: a public name can
 * still resolve to a private address, and the proxy asks `isPublicHost` again about the resolved
 * one.
 */
export function validateHostSet(primaryHost: string, hosts: readonly string[]): HostSetVerdict {
  const invalid = (problem: string): HostSetRefusal => ({ ok: false, problem, reason: "invalid" });
  let url: URL;
  try {
    url = new URL(primaryHost.trim());
  } catch {
    return invalid("The primary host is not a valid URL");
  }
  if (url.protocol !== "https:") {
    return invalid("The primary host must use https — a credential is never sent in the clear");
  }
  if (url.username || url.password) {
    return invalid(
      "The primary host must not carry credentials — they belong in the credential fields",
    );
  }
  if (url.search || url.hash) {
    return invalid(
      "The primary host is a host and an optional path, without a query string or fragment",
    );
  }
  if (!isPublicHost(url.hostname)) return notPublic(url.hostname);

  const set = new Set<string>([url.host.toLowerCase()]);
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (!HOSTNAME_WITH_PORT.test(host)) {
      return {
        ...invalid(
          `"${raw}" is not a hostname — a host in the set is a name like files.vendor.example, optionally with a port`,
        ),
        host: raw,
      };
    }
    const hostname = host.replace(/:\d+$/, "");
    if (!isPublicHost(hostname)) return notPublic(hostname);
    set.add(host);
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, primaryHost: `${url.origin}${path}`, hosts: [...set] };
}

function notPublic(hostname: string): HostSetRefusal {
  return {
    ok: false,
    reason: HOST_NOT_PUBLIC,
    host: hostname,
    problem: `${hostname} is not a public host — private, loopback, link-local, metadata and internal addresses are refused`,
  };
}

/**
 * Hosts that serve a vendor's sign-in and nothing a tool call reaches, by the scheme whose flow goes
 * through them (GRA-89): Google's consent page and the token endpoint every Google API shares. A
 * proposal's own `authorizeUrl` and `tokenUrl` hosts join these per proposal in
 * `setAsideSignInHosts`; the table is for an agent that lists them under `hosts` as well.
 */
export const SIGN_IN_HOSTS: Readonly<Partial<Record<AuthScheme, readonly string[]>>> = {
  oauth_authorization_code: ["accounts.google.com", "oauth2.googleapis.com"],
};

/** The scheme parameters that name a sign-in endpoint, when the scheme carries them. */
const SIGN_IN_ENDPOINT_PARAMETERS = ["authorizeUrl", "tokenUrl"] as const;

export type SignInHostsVerdict =
  /** `hosts` with the sign-in hosts removed, and `setAside` naming what was removed, in the order proposed. */
  | { ok: true; hosts: string[]; setAside: string[] }
  /** The primary host itself is a sign-in endpoint: a sentence saying why, and the host. */
  | { ok: false; problem: string; host: string };

/**
 * Sign-in endpoints are not hosts (ADR 0019, consequence of 2026-09-18; GRA-89). A connection's
 * host set is where tool calls go; the console runs an OAuth sign-in itself, a relay never touches
 * the endpoints, and the proxy pins every call to the row's hosts. So a sign-in host listed under
 * `hosts` is set aside before the proposal reaches a provider, and never recorded on the row: the
 * scheme's well-known ones (`SIGN_IN_HOSTS`) and the hosts of the proposal's own `authorizeUrl` and
 * `tokenUrl`. Left in, they made the Pipedream provider decline Gmail, since its `covers` demands
 * every host be one of the vendor's own, and the person got the client-registration form instead
 * of the one-click link.
 *
 * The primary host is never set aside, and its hostname is never a sign-in host here: some vendors
 * serve the token endpoint on the API's own host (Notion, Slack, HubSpot, Dropbox), and the primary
 * is by definition where tool calls resolve. Two primaries are refused instead: one on a well-known
 * sign-in host, and one that *is* the authorize or token endpoint URL, since tool paths would
 * resolve against the endpoint. Takes `validateHostSet`'s output: the normalised primary and the
 * lower-case host set, the primary's host among them.
 */
export function setAsideSignInHosts(
  scheme: AuthScheme,
  schemeConfig: Record<string, unknown>,
  primaryHost: string,
  hosts: readonly string[],
): SignInHostsVerdict {
  const primary = parseUrl(primaryHost);
  if (!primary)
    return { ok: false, host: primaryHost, problem: "The primary host is not a valid URL" };
  const wellKnown = SIGN_IN_HOSTS[scheme] ?? [];
  if (wellKnown.includes(primary.hostname)) {
    return {
      ok: false,
      host: primary.hostname,
      problem: `${primary.hostname} is a sign-in host, not an API host: tool calls never reach it; the sign-in runs in the console or on the provider's page. Make primaryHost the host the vendor's API answers on (for Gmail, gmail.googleapis.com) and keep authorizeUrl and tokenUrl in schemeConfig.`,
    };
  }
  const endpoints: { name: string; url: URL }[] = [];
  for (const name of SIGN_IN_ENDPOINT_PARAMETERS) {
    const value = schemeConfig[name];
    const url = typeof value === "string" ? parseUrl(value) : null;
    if (url) endpoints.push({ name, url });
  }
  const same = endpoints.find(
    ({ url }) => withoutTrailingSlash(url) === withoutTrailingSlash(primary),
  );
  if (same) {
    return {
      ok: false,
      host: primary.hostname,
      problem: `primaryHost is the ${same.name} endpoint itself: tool calls resolve their paths against primaryHost and never reach a sign-in endpoint. Make it the host the vendor's API answers on and keep ${same.name} in schemeConfig.`,
    };
  }
  const signIn = new Set<string>([...wellKnown, ...endpoints.map(({ url }) => url.hostname)]);
  signIn.delete(primary.hostname);
  const kept: string[] = [];
  const setAside: string[] = [];
  for (const host of hosts) {
    (signIn.has(host.replace(/:\d+$/, "")) ? setAside : kept).push(host);
  }
  return { ok: true, hosts: kept, setAside };
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function withoutTrailingSlash(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Re-exported so the service's callers and the form read one table (`@graft/proxy/scheme-parameters`). */
export { SCHEME_PARAMETERS };
export type SchemeRule = SchemeParameterRule;

/** The header name must be a token; the one it must not be is the credential's own carrier. */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/**
 * A relay scheme is never one a person chooses or a form takes (ADR 0019): a connection's provider
 * decides that it relays, and the three tables below are keyed by the signing schemes alone. So a
 * scheme from the column is narrowed here first, and a relay's name answers the sentence a person
 * would need rather than an indexing error.
 */
function signingScheme(scheme: ConnectionScheme): AuthScheme | string {
  return isAuthScheme(scheme)
    ? scheme
    : `The ${scheme} scheme is a relay's — its provider connects the vendor, and it cannot be chosen or configured here`;
}

/**
 * The scheme's parameters against its table. Two stages, one rule: an agent's **proposal** may omit
 * the parameters the person supplies on the form — an OAuth client id the person registered
 * (ADR 0005; `personEntered` in `@graft/proxy/scheme-parameters`) — and a **registration** may not.
 * The default is the registration, so the service and the form require everything; the meta-tool
 * passes `{ proposal: true }`.
 */
export function validateSchemeConfig(
  scheme: ConnectionScheme,
  config: Record<string, unknown>,
  options: { proposal?: boolean } = {},
): string | null {
  if (!isAuthScheme(scheme)) return signingScheme(scheme);
  const rule = SCHEME_PARAMETERS[scheme];
  const required = options.proposal ? rule.required : requiredParametersOf(rule);
  const known = [...requiredParametersOf(rule), ...rule.optional];
  const given = Object.keys(config);
  const missing = required.filter((key) => !given.includes(key));
  const unknown = given.filter((key) => !known.includes(key));
  if (missing.length > 0) {
    return `The ${scheme} scheme needs ${missing.join(", ")} in its configuration`;
  }
  if (unknown.length > 0) {
    return `The ${scheme} scheme takes no ${unknown.join(", ")} — its parameters are ${known.join(", ") || "none"}`;
  }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return `The scheme parameter ${key} must be a non-empty string`;
    }
  }
  if (scheme === "api_key_header") {
    const headerName = String(config.headerName);
    if (!HEADER_NAME.test(headerName)) {
      return "The header name is letters, digits and hyphens, like x-api-key";
    }
    if (headerName.toLowerCase() === "authorization" && config.prefix === undefined) {
      return "An API key in the Authorization header needs a prefix such as Bearer or Token — or use the bearer scheme";
    }
  }
  if (scheme === "oauth2_client_credentials" || scheme === "oauth_authorization_code") {
    const problem = validateHttpsUrl(String(config.tokenUrl), "The token URL");
    if (problem) return problem;
    if (config.clientAuth !== undefined && !["basic", "body"].includes(String(config.clientAuth))) {
      return "clientAuth is basic or body";
    }
  }
  if (scheme === "oauth_authorization_code") {
    // The person's browser is sent here with the client id in the URL; the same address rule as
    // the token endpoint, because the consent is the vendor's and a private host is nobody's.
    const problem = validateHttpsUrl(String(config.authorizeUrl), "The authorize URL");
    if (problem) return problem;
  }
  return null;
}

function validateHttpsUrl(raw: string, what: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return `${what} must use https`;
    if (!isPublicHost(url.hostname)) return notPublic(url.hostname).problem;
    return null;
  } catch {
    return `${what} is not a valid URL`;
  }
}

/**
 * The credential's field names against the scheme's table, so a typo is a sentence at entry rather
 * than a `credential_incomplete` at the first vendor call. Values are checked to be non-empty
 * strings and never inspected further — this file does not know what a key looks like.
 */
export function validateCredentialFields(
  scheme: ConnectionScheme,
  fields: Record<string, unknown>,
): string | null {
  if (!isAuthScheme(scheme)) return signingScheme(scheme);
  const required = SCHEME_CREDENTIAL_FIELDS[scheme];
  const optional = SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? [];
  const given = Object.keys(fields);
  const missing = required.filter((field) => !given.includes(field));
  const unknown = given.filter((field) => !required.includes(field) && !optional.includes(field));
  if (missing.length > 0) {
    return `The ${scheme} credential needs ${missing.join(", ")}`;
  }
  if (unknown.length > 0) {
    const fields = [...required, ...optional];
    return fields.length === 0
      ? `The ${scheme} scheme sends no credential and takes no fields — not ${unknown.join(", ")}`
      : `The ${scheme} credential takes no ${unknown.join(", ")} — its fields are ${fields.join(", ")}`;
  }
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) {
      return `The credential field ${field} must be a non-empty string`;
    }
  }
  return null;
}

/**
 * Whether a connection of this scheme holds a credential in Graft at all. `none` does not (GRA-66),
 * and neither does a relay scheme, whose provider holds it (ADR 0019); every other signing scheme
 * needs one entered before the connection is usable. The one question `isConnectionUsable`,
 * `setConnectionCredential` and the console's status ask of a scheme, so they cannot drift.
 */
export function takesCredential(scheme: ConnectionScheme): boolean {
  if (!isAuthScheme(scheme)) return false;
  return (
    SCHEME_CREDENTIAL_FIELDS[scheme].length +
      (SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? []).length >
    0
  );
}

/**
 * The fields a consent or a refresh writes into an authorization-code credential beside the client
 * secret — the issued table's, each a non-empty string when present, and never anything the person
 * types (`validateCredentialFields` is the entry rule and refuses them). The access token is the
 * one the record cannot do without once a consent has completed.
 */
export function validateIssuedCredentialFields(
  scheme: ConnectionScheme,
  fields: Record<string, unknown>,
): string | null {
  if (!isAuthScheme(scheme)) return signingScheme(scheme);
  const entered = [
    ...SCHEME_CREDENTIAL_FIELDS[scheme],
    ...(SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? []),
  ];
  const issued = SCHEME_ISSUED_CREDENTIAL_FIELDS[scheme] ?? [];
  if (issued.length === 0) return `The ${scheme} scheme issues no credential fields`;
  const given = Object.keys(fields);
  const unknown = given.filter((field) => !entered.includes(field) && !issued.includes(field));
  if (unknown.length > 0) {
    return `The ${scheme} credential takes no ${unknown.join(", ")} — its fields are ${[...entered, ...issued].join(", ")}`;
  }
  const missingEntered = SCHEME_CREDENTIAL_FIELDS[scheme].filter((f) => !given.includes(f));
  if (missingEntered.length > 0) {
    return `The ${scheme} credential needs ${missingEntered.join(", ")}`;
  }
  if (!given.includes("accessToken")) {
    return `The ${scheme} credential needs accessToken once the consent has completed`;
  }
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) {
      return `The credential field ${field} must be a non-empty string`;
    }
  }
  return null;
}
