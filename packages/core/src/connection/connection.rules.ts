import type { ConnectionScheme } from "@graft/db/schema/connection";
import { SCHEME_CREDENTIAL_FIELDS, SCHEME_OPTIONAL_CREDENTIAL_FIELDS } from "@graft/proxy";
import { isPublicHost } from "@graft/proxy/public-host";

import { isKebabCase } from "../kebab-case";

/**
 * The rules that make a connection registrable (GRA-1, "Connections, schemes and OAuth"): the
 * vendor slug's shape, the host set's address rule, and what each scheme needs in its non-secret
 * configuration and in its credential. Total functions over strings — no `ctx`, no `deps` — so the
 * service stays about orchestration and these get a test that needs no fakes.
 *
 * Each validator answers with a sentence a person can act on, or with the normalised value. The
 * address rule and the field table come from `@graft/proxy`: the proxy applies `isPublicHost` again
 * at resolution (ADR 0010), and its scheme plugins are the side that knows which fields a
 * credential must hold — this package imports from the proxy, never the reverse.
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

export type HostSetVerdict =
  | { ok: true; primaryHost: string; hosts: string[] }
  | { ok: false; problem: string };

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
  let url: URL;
  try {
    url = new URL(primaryHost.trim());
  } catch {
    return { ok: false, problem: "The primary host is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      problem: "The primary host must use https — a credential is never sent in the clear",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      problem: "The primary host must not carry credentials — they belong in the credential fields",
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      problem:
        "The primary host is a host and an optional path, without a query string or fragment",
    };
  }
  if (!isPublicHost(url.hostname)) {
    return { ok: false, problem: notPublic(url.hostname) };
  }

  const set = new Set<string>([url.host.toLowerCase()]);
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (!HOSTNAME_WITH_PORT.test(host)) {
      return {
        ok: false,
        problem: `"${raw}" is not a hostname — a host in the set is a name like files.vendor.example, optionally with a port`,
      };
    }
    const hostname = host.replace(/:\d+$/, "");
    if (!isPublicHost(hostname)) return { ok: false, problem: notPublic(hostname) };
    set.add(host);
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, primaryHost: `${url.origin}${path}`, hosts: [...set] };
}

function notPublic(hostname: string): string {
  return `${hostname} is not a public host — private, loopback, link-local, metadata and internal addresses are refused`;
}

export type SchemeRule = { required: readonly string[]; optional: readonly string[] };

/**
 * What each scheme plugin is parameterised by (`@graft/proxy`'s `schemes.ts`). Keyed by the
 * column's enum so adding a scheme without saying what it takes fails to compile. Nothing here is a
 * secret: a header *name* and a *prefix*, a query parameter *name*, a token *endpoint*, *scopes*,
 * where the OAuth2 client authenticates, a Snowflake *account* and *user*.
 */
export const SCHEME_PARAMETERS: Record<ConnectionScheme, SchemeRule> = {
  api_key_header: { required: ["headerName"], optional: ["prefix"] },
  api_key_query: { required: ["queryParam"], optional: [] },
  bearer: { required: [], optional: [] },
  basic: { required: [], optional: [] },
  oauth2_client_credentials: { required: ["tokenUrl"], optional: ["scopes", "clientAuth"] },
  unleashed_hmac: { required: [], optional: [] },
  snowflake_keypair_jwt: { required: ["account", "user"], optional: [] },
};

/** The header name must be a token; the one it must not be is the credential's own carrier. */
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

export function validateSchemeConfig(
  scheme: ConnectionScheme,
  config: Record<string, unknown>,
): string | null {
  const rule = SCHEME_PARAMETERS[scheme];
  const given = Object.keys(config);
  const missing = rule.required.filter((key) => !given.includes(key));
  const unknown = given.filter(
    (key) => !rule.required.includes(key) && !rule.optional.includes(key),
  );
  if (missing.length > 0) {
    return `The ${scheme} scheme needs ${missing.join(", ")} in its configuration`;
  }
  if (unknown.length > 0) {
    return `The ${scheme} scheme takes no ${unknown.join(", ")} — its parameters are ${[...rule.required, ...rule.optional].join(", ") || "none"}`;
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
  if (scheme === "oauth2_client_credentials") {
    const problem = validateHttpsUrl(String(config.tokenUrl), "The token URL");
    if (problem) return problem;
    if (config.clientAuth !== undefined && !["basic", "body"].includes(String(config.clientAuth))) {
      return "clientAuth is basic or body";
    }
  }
  return null;
}

function validateHttpsUrl(raw: string, what: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return `${what} must use https`;
    if (!isPublicHost(url.hostname)) return notPublic(url.hostname);
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
  const required = SCHEME_CREDENTIAL_FIELDS[scheme];
  const optional = SCHEME_OPTIONAL_CREDENTIAL_FIELDS[scheme] ?? [];
  const given = Object.keys(fields);
  const missing = required.filter((field) => !given.includes(field));
  const unknown = given.filter((field) => !required.includes(field) && !optional.includes(field));
  if (missing.length > 0) {
    return `The ${scheme} credential needs ${missing.join(", ")}`;
  }
  if (unknown.length > 0) {
    return `The ${scheme} credential takes no ${unknown.join(", ")} — its fields are ${[...required, ...optional].join(", ")}`;
  }
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) {
      return `The credential field ${field} must be a non-empty string`;
    }
  }
  return null;
}

export type OAuthClientVerdict =
  | { ok: true; clientId: string; authorizeUrl: string; tokenUrl: string; scopes: string[] }
  | { ok: false; problem: string };

/**
 * An authorization-code client the person registered (ADR 0005): the id and the two endpoints,
 * https on public hosts, and the scopes as a list. The client secret is a credential and takes the
 * vault's path, never this one.
 */
export function validateOAuthClient(input: {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes?: readonly string[];
}): OAuthClientVerdict {
  const clientId = input.clientId.trim();
  if (clientId.length === 0) return { ok: false, problem: "The OAuth client id is required" };
  for (const [what, raw] of [
    ["The authorize URL", input.authorizeUrl],
    ["The token URL", input.tokenUrl],
  ] as const) {
    const problem = validateHttpsUrl(raw.trim(), what);
    if (problem) return { ok: false, problem };
  }
  const scopes = [...new Set((input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
  return {
    ok: true,
    clientId,
    authorizeUrl: input.authorizeUrl.trim(),
    tokenUrl: input.tokenUrl.trim(),
    scopes,
  };
}
