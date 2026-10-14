import { isIP } from "node:net";

import { VENDOR_MAX_LENGTH, validateDisplayName, validateVendor } from "@graft/core";
import {
  CONNECTION_PROPOSAL_INPUT_MAX_CHARS,
  type ConnectionProposalOutcome,
  type ConnectionProposalPage,
  type ConnectionProposalScheme,
  type ModelAdapter,
  type ModelUsage,
} from "@graft/model";
import { isPublicAddress, isPublicHost } from "@graft/proxy/public-host";
import { SCHEME_PARAMETERS } from "@graft/proxy/scheme-parameters";
import { AUTH_SCHEMES, type AuthScheme } from "@graft/proxy/types";

import { normaliseProposal } from "./connection-request";
import { defaultWebPageDeps, type ReadWebPage, type ResolvedAddress } from "./web-page";

/**
 * A connection proposal from an API's documentation (GRA-299, the console's Flow C): the person
 * names an integration and pastes a link to its API docs, and Graft works out the address, the
 * hosts and the sign-in scheme for the person to check before adding their key. Until this, a
 * proposal was only ever written by the harness's model (`request_connection`), and `acquire` read
 * documentation only to write tools.
 *
 * Four stages, the console's four checklist lines: the pages are read through `readWebPage`, the
 * SSRF-guarded reader `acquire` uses, at most `PROPOSAL_DOC_WINDOWS` windows of the one page the
 * person pasted and `CONNECTION_PROPOSAL_INPUT_MAX_CHARS` characters in all (no search, and no page
 * the model picks); the model's `proposeConnection` reads off them how the API signs in and where
 * it answers; the answer is judged by `normaliseProposal`, the rules `request_connection` applies
 * to an agent's proposal, so a private, loopback or metadata host is refused `host_not_public`
 * exactly as it is there; then every host is resolved once, an answer on a private address
 * refused the same way and a name that does not resolve kept and listed, since the person can fix
 * the address on the form. Nothing here holds or asks for a credential.
 */

/** How many windows of the pasted page are read (`readWebPage`'s `offset`), each `MAX_PAGE_CHARS`. */
export const PROPOSAL_DOC_WINDOWS = 3;

/** The four checklist lines, in order. */
export const DOCS_PROPOSAL_STAGES = [
  "reading_docs",
  "finding_sign_in",
  "checking_address",
  "preparing",
] as const;
export type DocsProposalStage = (typeof DOCS_PROPOSAL_STAGES)[number];

/** Why a proposal ended without one; each has a sentence in `DocsProposalFailure.message`. */
export type DocsProposalFailureReason =
  /** The pasted page could not be read: `readWebPage`'s own sentence. */
  | "docs_unreadable"
  /** The model read the pages and said they do not say. */
  | "not_found"
  /** The model's answer was out of shape, ran past its bound, failed, or no model answers this person. */
  | "model_unusable"
  | "model_timeout"
  | "model_failed"
  | "model_unavailable"
  /** The whole job ran past the caller's deadline (a stalled lookup before any bound of its own started). */
  | "proposal_timeout"
  /** The address is private, loopback, link-local, metadata or internal, by its name or by what it resolves to. */
  | "host_not_public"
  /** The proposal broke another connection rule (a header name, a scheme parameter, an https address). */
  | "input_invalid";

export type DocsProposalFailure = {
  reason: DocsProposalFailureReason;
  message: string;
  host?: string;
};

/**
 * The proposal as `request_connection` would take it, normalised by its rules: the vendor slug,
 * the person's name for the integration, the scheme and its parameters, the address, the hosts
 * (the address's among them) and the documentation link the person pasted.
 */
export type DocsProposal = {
  vendor: string;
  displayName: string;
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: string[];
  docsUrl: string;
  /** Sign-in hosts the model listed and the rules set aside (GRA-89); empty when none. */
  hostsSetAside: string[];
};

/** What has been found so far, for the checklist's second lines; each null until its stage has run. */
export type DocsProposalFound = {
  docsHost: string | null;
  scheme: AuthScheme | null;
  primaryHost: string | null;
};

/** Counts and kinds for the log, never the pages or the proposal's values. */
export type DocsProposalStats = {
  pages: number;
  characters: number;
  outcome: ConnectionProposalOutcome | null;
  usage: ModelUsage;
  /** The provider's failure message, cut to `PROPOSAL_ERROR_MAX_CHARS`, when the model call failed; for the log alone. */
  error?: string;
};

/** How much of a provider's failure message the log is handed. */
export const PROPOSAL_ERROR_MAX_CHARS = 300;

/**
 * How long the address check may take, every host together (Greptile on #231): the lookups run at
 * once, and a host whose answer has not arrived by then is listed as unresolved rather than holding
 * the person's one proposal in flight.
 */
export const ADDRESS_CHECK_TIMEOUT_MS = 5_000;

export type DocsProposalResult =
  | {
      ok: true;
      proposal: DocsProposal;
      found: DocsProposalFound;
      /** Hosts whose name did not resolve when checked, for the person to look at; empty when all did. */
      unresolvedHosts: string[];
      stats: DocsProposalStats;
    }
  | { ok: false; failure: DocsProposalFailure; found: DocsProposalFound; stats: DocsProposalStats };

export type DocsProposalDeps = {
  model?: ModelAdapter | null;
  readWebPage: ReadWebPage;
  /** Answers a hostname's addresses; DNS through `readWebPage`'s own resolver when absent. */
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** The address check's bound; `ADDRESS_CHECK_TIMEOUT_MS` when absent. */
  addressCheckTimeoutMs?: number;
};

export type DocsProposalInput = { personId: string; name: string; docsUrl: string };

/**
 * One line per scheme for the model, beside the parameters the scheme table says a proposal
 * carries. Keyed by the enum so a new scheme does not compile without one.
 */
const SCHEME_SUMMARIES: Record<AuthScheme, string> = {
  api_key_header: "A key sent in a request header, optionally after a prefix.",
  api_key_query: "A key sent as a query parameter.",
  bearer: "A token sent as Authorization: Bearer <token>.",
  basic: "A username and password sent as HTTP Basic authentication.",
  oauth2_client_credentials:
    "OAuth 2 client credentials: a client id and secret exchanged at a token URL for an access token.",
  oauth_authorization_code:
    "OAuth 2 authorization code: the person signs in on the vendor's consent page, then tokens from a token URL.",
  unleashed_hmac: "Unleashed's own signing: an API id header and an HMAC signature of the query.",
  snowflake_keypair_jwt: "Snowflake's key-pair JWT, for an account and a user.",
  none: "Nothing: a public API called without a key.",
};

/** The schemes the model may answer, as `@graft/model` takes them: the signing schemes, never a relay's. */
export const DOCS_PROPOSAL_SCHEMES: readonly ConnectionProposalScheme[] = AUTH_SCHEMES.map(
  (scheme) => ({
    scheme,
    summary: SCHEME_SUMMARIES[scheme],
    required: SCHEME_PARAMETERS[scheme].required,
    optional: SCHEME_PARAMETERS[scheme].optional,
  }),
);

export type DocsProposalInputVerdict =
  | { ok: true; name: string; docsUrl: string }
  | { ok: false; reason: "input_invalid" | "host_not_public"; message: string; field: string };

/**
 * The person's two fields before anything is read: a name a connection may carry, and an https
 * link on a public host, since that is all `readWebPage` reads. A private documentation host is
 * `host_not_public` here, as a private API host is after the model.
 */
export function readDocsProposalInput(input: {
  name: string;
  docsUrl: string;
}): DocsProposalInputVerdict {
  const name = input.name.trim();
  const nameProblem = validateDisplayName(name);
  if (nameProblem)
    return { ok: false, reason: "input_invalid", message: nameProblem, field: "name" };
  let url: URL;
  try {
    url = new URL(input.docsUrl.trim());
  } catch {
    return {
      ok: false,
      reason: "input_invalid",
      message: "The documentation link is not a valid URL",
      field: "docsUrl",
    };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return {
      ok: false,
      reason: "input_invalid",
      message: "The documentation link is an https URL with no credentials in it",
      field: "docsUrl",
    };
  }
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!isPublicHost(hostname)) {
    return {
      ok: false,
      reason: "host_not_public",
      message: `${hostname} is not a public host, so its pages are not read`,
      field: "docsUrl",
    };
  }
  return { ok: true, name, docsUrl: url.toString() };
}

/** The person's name as a vendor slug, for a model that answered none the rules take. */
export function vendorSlugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VENDOR_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug === "" ? "integration" : slug;
}

const MODEL_FAILURES: Record<
  Exclude<ConnectionProposalOutcome, "proposed" | "declined">,
  DocsProposalFailure
> = {
  unusable: {
    reason: "model_unusable",
    message: "Graft's model answered in a shape it could not use. Try again, or set it up by hand.",
  },
  timeout: {
    reason: "model_timeout",
    message:
      "Graft's model took too long to read the documentation. Try again, or set it up by hand.",
  },
  failed: {
    reason: "model_failed",
    message: "Graft's model could not be reached. Try again, or set it up by hand.",
  },
  unavailable: {
    reason: "model_unavailable",
    message: "No model answers for you here, so Graft cannot read the documentation.",
  },
};

/**
 * Read the pasted page, ask the model, judge the answer, check the address. Never throws for a
 * reason a person can act on; `onStage` hears each stage as it starts, with what was found so far.
 */
export async function proposeConnectionFromDocs(
  input: DocsProposalInput,
  deps: DocsProposalDeps,
  onStage: (stage: DocsProposalStage, found: DocsProposalFound) => void = () => {},
): Promise<DocsProposalResult> {
  const found: DocsProposalFound = { docsHost: null, scheme: null, primaryHost: null };
  const stats: DocsProposalStats = {
    pages: 0,
    characters: 0,
    outcome: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const fail = (failure: DocsProposalFailure): DocsProposalResult => ({
    ok: false,
    failure,
    found: { ...found },
    stats,
  });

  onStage("reading_docs", { ...found });
  const pages: ConnectionProposalPage[] = [];
  let offset: number | null = 0;
  for (let window = 0; window < PROPOSAL_DOC_WINDOWS && offset !== null; window += 1) {
    if (stats.characters >= CONNECTION_PROPOSAL_INPUT_MAX_CHARS) break;
    const page = await deps.readWebPage({ url: input.docsUrl, offset });
    if (!page.ok) {
      // A later window that fails leaves the windows already read; the first is the page itself.
      if (pages.length === 0) {
        return fail({
          reason: "docs_unreadable",
          message: `Graft could not read the documentation: ${page.error}`,
        });
      }
      break;
    }
    pages.push({
      url: page.url,
      title: page.title,
      content: page.content,
      truncated: page.truncated,
    });
    stats.pages += 1;
    stats.characters += page.content.length;
    offset = page.nextOffset;
  }
  found.docsHost = hostnameOf(pages[0]?.url ?? input.docsUrl);

  onStage("finding_sign_in", { ...found });
  const propose = deps.model?.proposeConnection?.bind(deps.model);
  if (!propose) return fail(MODEL_FAILURES.unavailable);
  const answer = await propose({
    personId: input.personId,
    traceId: `connect:${input.personId}`,
    name: input.name,
    docsUrl: input.docsUrl,
    pages,
    schemes: DOCS_PROPOSAL_SCHEMES,
  });
  stats.outcome = answer.outcome;
  stats.usage = answer.usage;
  if (answer.error) stats.error = answer.error.slice(0, PROPOSAL_ERROR_MAX_CHARS);
  if (answer.outcome === "declined") {
    return fail({
      reason: "not_found",
      message: `Graft read the documentation but could not tell how the API is reached: ${answer.reason ?? "the pages do not say"}. Try a link to the API's authentication or reference page, or set it up by hand.`,
    });
  }
  const raw = answer.proposal;
  if (answer.outcome !== "proposed") return fail(MODEL_FAILURES[answer.outcome]);
  if (!raw) return fail(MODEL_FAILURES.unusable);

  onStage("checking_address", { ...found, primaryHost: hostnameOf(raw.primaryHost) });
  const verdict = normaliseProposal({
    vendor:
      validateVendor(raw.vendor.trim()) === null ? raw.vendor.trim() : vendorSlugOf(input.name),
    displayName: input.name,
    primaryHost: raw.primaryHost,
    hosts: raw.hosts,
    scheme: raw.scheme,
    schemeConfig: raw.schemeConfig,
    docsUrl: input.docsUrl,
  });
  if (!verdict.ok) {
    const host = typeof verdict.details.host === "string" ? verdict.details.host : undefined;
    return fail({
      reason: verdict.reason === "host_not_public" ? "host_not_public" : "input_invalid",
      message: verdict.message,
      ...(host ? { host } : {}),
    });
  }
  const { payload } = verdict;
  found.scheme = payload.scheme;
  found.primaryHost = hostnameOf(payload.primaryHost);
  // The sign-in line is done once the rules took the scheme: polls during the lookups show it.
  onStage("checking_address", { ...found });
  const resolve = deps.resolveHost ?? defaultWebPageDeps.resolve;
  // The rules keep an IPv6 literal bracketed (`[2001:db8::1]:443`): bare, it is judged a literal
  // and never sent to DNS (Greptile on #231).
  const hostnames = [
    ...new Set(payload.hosts.map((host) => host.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))),
  ].filter(
    // A literal was judged by the rules above.
    (hostname) => isIP(hostname) === 0,
  );
  const resolved = await resolveWithin(
    hostnames,
    resolve,
    deps.addressCheckTimeoutMs ?? ADDRESS_CHECK_TIMEOUT_MS,
  );
  const unresolvedHosts: string[] = [];
  for (const [index, hostname] of hostnames.entries()) {
    const addresses = resolved[index] ?? [];
    if (addresses.length === 0) {
      unresolvedHosts.push(hostname);
      continue;
    }
    const offending = addresses.find((entry) => !isPublicAddress(entry.address));
    if (offending) {
      return fail({
        reason: "host_not_public",
        host: hostname,
        message: `${hostname} resolves to ${offending.address}, which is not a public address; private, loopback, link-local, metadata and internal addresses are refused`,
      });
    }
  }

  onStage("preparing", { ...found });
  return {
    ok: true,
    proposal: {
      vendor: payload.vendor,
      displayName: payload.displayName,
      scheme: payload.scheme,
      schemeConfig: payload.schemeConfig,
      primaryHost: payload.primaryHost,
      hosts: payload.hosts,
      docsUrl: payload.docsUrl ?? input.docsUrl,
      hostsSetAside: verdict.hostsSetAside,
    },
    found: { ...found },
    unresolvedHosts,
    stats,
  };
}

/**
 * Every hostname's addresses, looked up at once and bounded together: a lookup that fails, or has
 * not answered when the bound passes, answers none.
 */
async function resolveWithin(
  hostnames: readonly string[],
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  timeoutMs: number,
): Promise<ResolvedAddress[][]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), timeoutMs);
  });
  try {
    return await Promise.all(
      hostnames.map(async (hostname) => {
        const lookup = resolve(hostname).catch(() => [] as ResolvedAddress[]);
        const answer = await Promise.race([lookup, deadline]);
        return answer === "timeout" ? [] : answer;
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
