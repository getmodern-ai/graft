import type { AskCard } from "@graft/ask-card/shape";
import {
  type AgentScope,
  addConnectionToAgentScope,
  type ConnectionOutput,
  type ConnectionProvider,
  consumePendingAction,
  createPendingAction,
  getAgent,
  getAgentScope,
  getConnection,
  getPendingAction,
  HOST_NOT_PUBLIC,
  isConnectionUsable,
  isOAuthAuthorizationCode,
  KEYRING_PROVIDER,
  listConnections,
  providerFor,
  providerNamed,
  registerProviderConnection,
  type ServiceContext,
  ServiceError,
  setAsideSignInHosts,
  takesCredential,
  validateDisplayName,
  validateHostSet,
  validateSchemeConfig,
  validateVendor,
  widenProviderConnectionHosts,
} from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { SCHEME_CREDENTIAL_FIELDS } from "@graft/proxy/credential-fields";
import { hostSetOf } from "@graft/proxy/credential-source";
import { SCHEME_PARAMETERS } from "@graft/proxy/scheme-parameters";
import { AUTH_SCHEMES, type AuthScheme, isAuthScheme } from "@graft/proxy/types";

import { DEFAULT_POLL_MS } from "./approval";
import { connectionAskCard, credentialAskCard, scopeAskCard } from "./ask-card";
import { notifyAgentsReachingConnection } from "./connected";
import type { McpDeps } from "./deps";
import { handoffUrl, signHandoffToken } from "./handoff";
import type { ToolListChangedNotifier } from "./notifier";
import { isPlainObject, refusal } from "./result";
import { executeToolName } from "./tool-names";

/**
 * The two handoffs about a connection's **credential** (CONTEXT.md, *Handoff*; ADR 0006), as the
 * `request_connection` and `request_credential` meta-tools apply them. Both are GRA-23's ask flow
 * (`approval.ts`) with a different record behind the link: the agent proposes everything that is
 * not secret, a durable pending action holds it, the person opens the signed URL, confirms the
 * hosts and types the secret in the console — and the secret goes to the vault through the
 * server's submit route (`apps/server/src/api.ts`), never through this process, never into the
 * action or its answer. The waiting call takes the answer once and says "connected" and nothing
 * more. Elicitation is never used here: the specification forbids asking for a secret through it
 * (ADR 0006), so a harness with the capability is handed the same URL as one without.
 *
 * **Two asks, two kinds.** `connection` proposes a connection that does not exist yet — its
 * `connectionId` column is null until the person creates it — and the answer names the row the
 * console made. `credential` targets an existing connection after a vendor 401 or 403, and the
 * re-entry replaces the credential and touches no approval (ADR 0008: the approvals are the
 * person's answers about the tools, and the credential changing is not a reason to ask again).
 *
 * **The host rule is applied here first.** The proposal's hosts go through `@graft/core`'s
 * `validateHostSet` before any record exists, so a private, link-local or metadata host is a
 * refusal to the agent with the reason word `host_not_public` — the same word the connection
 * service answers at create and the form shows as the person types (GRA-28), and the same
 * predicate the proxy applies again at resolution (ADR 0010).
 *
 * **Sign-in endpoints are not hosts, and are set aside before a provider sees the proposal**
 * (ADR 0019, consequence of 2026-09-18; GRA-89). `normaliseProposal` applies `@graft/core`'s
 * `setAsideSignInHosts` to the validated set, so every path reads the same hosts: the routing to a
 * provider, the open-ask match (`proposalKey` hashes the normalised hosts, so the same proposal
 * with or without the sign-in hosts is one ask), the payload the card shows and the row the
 * console or a link's return makes. The set-aside hosts are dropped from the row, not merely
 * ignored for coverage, and the answer names them (`hostsSetAside`). A primary host that is a
 * sign-in endpoint is `input_invalid` with the reason in the message.
 *
 * **The proposal is routed to a provider** (ADR 0019): the first of the deployment's providers that
 * covers the vendor at these hosts decides how the person connects it. The keyring covers every
 * vendor and is always last, so with it alone every proposal takes the form below and the ask,
 * the answer and the card are exactly what they were before providers existed. A provider that
 * connects with a **link** (GRA-59; Pipedream) takes the same ask with a different card: the
 * payload names the provider and what it calls the vendor, the person presses one button, the
 * provider's page runs the vendor's sign-in, and the server's return route — not a submit — makes
 * the connection and answers the ask once the provider has confirmed the account
 * (`apps/server/src/provider-link.ts`). The agent proposes a scheme as it always did; for a link
 * provider the row records the provider's relay scheme instead, and the proposed one is only what
 * the keyring would have used. A provider with **no person step** — the gateway (GRA-58) — makes
 * the row and puts it in this agent's scope in one transaction and answers `connected` at once
 * (`connectWithoutPersonStep`); no ask, no link.
 *
 * **Why the gateway asks nobody, and where it stops** (GRA-58's connect decision). The person's
 * consent for a keyring connection is the secret they type for *this* agent's ask; a gateway
 * connection has no secret, and the operator gave the standing consent at deployment by naming the
 * vendor's hosts as covered — a per-agent ask would re-ask a decision already made, and "no person
 * step" is what the provider is for. The person keeps every later control: the connection is on the
 * console with its provider, the scope picker takes it away from an agent, Revoke takes it from
 * all, and every approval ADR 0008 asks still asks before code is authored against it or a write
 * leaves. What an agent may never do is undo one of those decisions: a row the person revoked, or
 * one the person has not given this agent, is refused with the console step that would grant it —
 * the smallest consent that exists today — rather than re-made or re-scoped by the agent's call.
 *
 * **A build approval stays with the connection row, so a rotation re-enters in place** (ADR 0008
 * as amended 2026-09-18; GRA-76). A proposal naming a vendor and hosts that a connection of the
 * person's already reaches — live or revoked — is never a second ask: a second row would carry no
 * scope and no approvals, and the person would answer `acquire`'s build ask again for one account.
 * `existingConnectionFor` finds that row, and the call answers with it named and the step that
 * keeps it: `connected` when it is usable and in this agent's scope; otherwise the
 * `connection_exists` refusal saying whether the step is `request_credential` (a live row in scope
 * whose credential or consent is missing — the re-entry its card handles, consent included) or the
 * console's Reconnect (a revoked row). Hosts are matched as the proxy matches them at resolution
 * (`hostSetOf`): the proposal's
 * set within the row's, so a row reaching more than proposed counts and one reaching less does
 * not. One row takes a new ask on purpose: a revoked row of a **link** provider, because the
 * link's return reconnects it in place (GRA-59, `connectThroughProvider`) — the ask *is* its
 * reconnection. A gateway proposal never reaches this check (`connectWithoutPersonStep` has its
 * own two refusals, above).
 *
 * **A usable row the person holds but this agent was not given is an ask, not a refusal** (GRA-104;
 * ADR 0006). Until 2026-09-19 that case was `connection_exists` with `inScope: false` and a
 * navigation instruction — the one person step with no handoff URL, so a chat product's model
 * relayed "add it under Scope" with no link, and the ask card had nothing to render. Now it is the
 * third ask kind here, `scope`: a pending action stamped with the connection, a signed URL into
 * the console, and the same wait and poll as the connection ask; the call answers
 * `awaiting_scope` in GRA-55's shape. The page — and the ask card (GRA-84), since this is a yes or
 * no on a connection the person already made — says "<agent> asks to use <connection>" with Allow
 * and Decline and GRA-75's build choice, on by default. Allow is the same scope change the agent
 * page's picker makes (`addConnectionToAgentScope`) and, ticked, the build approval, in one
 * transaction (`ask-answer.ts`); the next call then answers `connected` with the execute tool
 * named. One open `scope` ask per agent and connection: a re-proposal while it stands re-uses it,
 * and a revoke closes it through the `connectionId` column like any other ask about the row. A
 * revoked row and a live row in scope keep GRA-76's answers; a live row outside the scope whose
 * credential is missing keeps its refusal too, since allowing it would give the agent nothing to
 * call through.
 *
 * **An agent on `all` never reaches the scope ask, and every grant here is a no-op for it**
 * (ADR 0007 as amended 2026-09-19; GRA-105). `getAgentScope` answers every connection of the
 * person's for such an agent, so `existingConnectionFor` finds every usable row in scope and
 * answers `connected`; the `scope` ask and the gateway's `connection_not_in_scope` are the
 * narrowed agent's answers alone. The grant after a connect (`addConnectionToAgentScope`, here and
 * in the console's submit, the link's return and the scope ask's yes) writes nothing for an agent
 * on `all` — the row is the person's and therefore already that agent's — and this file does not
 * read the mode to know it.
 */

export const CONNECTION_ASK_KIND = "connection";
export const CREDENTIAL_ASK_KIND = "credential";
/** The ask to let this agent use a connection the person already holds (GRA-104; the header's last paragraph). */
export const SCOPE_ASK_KIND = "scope";

/** What a `connection` ask carries: the proposal, normalised — everything the form pre-fills (ADR 0006). */
export type ConnectionProposalPayload = {
  /** The provider the proposal was routed to (ADR 0019) — `keyring` for every ask made before or without another. */
  provider: string;
  /**
   * How that provider connects — `form`, `link` or `none` — so the console draws the right card
   * without asking the server about providers; absent on an ask recorded before GRA-59, which is
   * the keyring's form.
   */
  providerConnect?: "form" | "link" | "none";
  /** What a link provider calls the vendor on its side — Pipedream's app slug — for the card; null otherwise. */
  providerTarget?: string | null;
  vendor: string;
  displayName: string;
  /** The scheme the agent proposed — a signing scheme, since a relay scheme is a provider's (ADR 0019). */
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  /** Normalised: origin plus an optional path, no trailing slash. */
  primaryHost: string;
  /** Every hostname the credential will be sent to, the primary's among them, lower-case. */
  hosts: string[];
  /** The documentation the agent's model read, so the person can check it. */
  docsUrl: string | null;
  /** The provenance sentence the card shows. */
  note: string;
};

/** What a `credential` ask carries: the connection, and what the vendor said. */
export type CredentialAskPayload = {
  connectionId: string;
  vendor: string;
  connectionName: string;
  /** A signing scheme: a re-entry is the keyring's, and a relay provider's row is refused before this is built. */
  scheme: AuthScheme;
  hosts: string[];
  /** What the vendor answered, in the agent's words; the card shows it as such. */
  reason: string | null;
  /** Whether the connection was revoked, so the re-entry is a reconnection (ADR 0007). */
  revoked: boolean;
};

/**
 * What a `scope` ask carries: the connection the person already holds, as its card shows it, and
 * the documentation the proposing model read (GRA-104). Nothing here is the agent's to edit — the
 * row exists — so the person's answer is a yes or no and the build choice.
 */
export type ScopeAskPayload = {
  connectionId: string;
  vendor: string;
  displayName: string;
  /** Where the row comes from (ADR 0019), so the card can say "via pipedream". */
  provider: string;
  primaryHost: string;
  hosts: string[];
  /** The row's scheme, a relay scheme included — the card labels it, nothing enters it. */
  scheme: string;
  /** The documentation the agent's model read, so the person can check what it is about to use it for. */
  docsUrl: string | null;
};

/**
 * What the console records on a `scope` ask (GRA-104): the person's yes or no, and whether they
 * left the build choice on. Recorded verbatim, as a tool ask's answer is — the connection is the
 * payload's, not the answer's — and read by `readScopeAnswer`.
 */
export type ScopeAnswer = { allow: boolean; approveBuild?: boolean };

/**
 * What the console records on either action once the secret is in the vault: the connection the
 * credential now belongs to. Anything else on the answer — a plain `{ allow: false }` from the
 * generic decline — reads as a decline. Never a field of the credential.
 */
export type ConnectionAnswer = { connectionId: string };

export const PROPOSAL_PROVENANCE_NOTE =
  "This proposal was written by the agent's model from the documentation it read. Check the hosts and the documentation link before entering a secret: the credential will be sent to every host listed, and to nothing else.";

/**
 * What every awaiting answer says about the build approval (GRA-75; ADR 0008, amendment of
 * 2026-09-18): the confirmation page offers it, on by default, for the asking agent and the
 * connection it is about to make — so the agent does not promise the person a second link that
 * `acquire` will not send. The tool's description says the same (`tools/meta.ts`), as does the
 * Hermes skill; `session.test.ts` pins the two.
 */
export const BUILD_APPROVAL_ON_THE_PAGE =
  "The same page offers to allow you to build tools against the connection, on by default; left on, acquire against it starts without a second link, so do not tell them to expect one.";

/** The same provenance for a link provider's ask, where nothing is entered and the calls are relayed (GRA-59). */
export const LINK_PROVENANCE_NOTE =
  "This proposal was written by the agent's model from the documentation it read. Check the hosts and the documentation link before connecting: calls for this connection will be relayed to every host listed, and to nothing else.";

/** What either tool answers once the connection can be called through — and nothing about a secret. */
export type Connected = {
  status: "connected";
  connectionId: string;
  /** Where the connection comes from (ADR 0019): `keyring`, or the provider that connected it with no person step. */
  provider: string;
  /** The connection's execute tool, `execute__<id>`, now in the agent's list. */
  executeTool: string;
  message: string;
  /** Sign-in hosts the proposal listed that were set aside and are not on the row (GRA-89); absent when none were. */
  hostsSetAside?: string[];
};

/** The result a call returns when the person has not entered the secret inside the wait. */
export type AwaitingHandoff = {
  error: "awaiting_connection" | "awaiting_credential" | "awaiting_scope";
  reason: "awaiting_connection" | "awaiting_credential" | "awaiting_scope";
  pendingActionId: string;
  url: string;
  expiresAt: string;
  message: string;
  /**
   * For an authorization-code proposal (ADR 0005): the redirect URI the person pastes into the
   * client they register at the vendor — the agent is the guide, and this is the one value it has
   * to relay exactly. Absent for every other scheme.
   */
  redirectUri?: string;
  /** For a proposal a link provider covers (ADR 0019): the provider's name, so the agent can say who runs the sign-in. */
  provider?: string;
  /** For a `scope` ask (GRA-104): the connection the person is asked to let this agent use. */
  connectionId?: string;
  /** Sign-in hosts the proposal listed that were set aside and will not be on the row (GRA-89); absent when none were. */
  hostsSetAside?: string[];
};

/**
 * What either tool answers: `connected`, or the body it returns instead — a refusal, or an
 * awaiting answer with the ask card's data beside it (`ask-card.ts`, GRA-84) for the host to render.
 */
export type ConnectionRequestOutcome =
  | { isError: false; answer: Connected }
  | { isError: true; answer: Record<string, unknown>; card?: AskCard };

/** The proposal as the agent sends it, before normalisation. */
export type ConnectionProposalInput = {
  vendor: string;
  displayName?: string;
  primaryHost: string;
  hosts?: readonly string[];
  scheme: string;
  schemeConfig?: Record<string, unknown>;
  docsUrl?: string;
};

export type CredentialRequestInput = { connectionId: string; reason?: string };

/**
 * The scheme table in one sentence, for the tool's description — generated so it cannot drift. The
 * signing schemes alone: a relay scheme is a provider's and never one the agent proposes (ADR 0019).
 */
export function describeSchemes(): string {
  return AUTH_SCHEMES.map((scheme) => {
    const rule = SCHEME_PARAMETERS[scheme];
    const parameters = [
      ...rule.required,
      ...rule.optional.map((parameter) => `optional ${parameter}`),
    ];
    // What the person supplies on the form: the scheme's secret fields, and the parameters only
    // they can know — an OAuth client id (ADR 0005), which the proposal leaves out.
    const entered = [...(rule.personEntered ?? []), ...SCHEME_CREDENTIAL_FIELDS[scheme]].join(", ");
    return `${scheme} (parameters: ${parameters.join(", ") || "none"}; the person enters: ${entered || "nothing"})`;
  }).join("; ");
}

function refuse(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): ConnectionRequestOutcome {
  return { isError: true, answer: refusal(reason, message, details) };
}

/** `pending_action.answer` as the console's submit route wrote it; anything else is a decline. */
export function readConnectionAnswer(
  answer: Record<string, unknown> | null | undefined,
): ConnectionAnswer | null {
  return typeof answer?.connectionId === "string" && answer.connectionId.length > 0
    ? { connectionId: answer.connectionId }
    : null;
}

/** `pending_action.answer` on a `scope` ask as the console or the card wrote it; anything else is a decline. */
export function readScopeAnswer(answer: Record<string, unknown> | null | undefined): ScopeAnswer {
  return {
    allow: answer?.allow === true,
    ...(typeof answer?.approveBuild === "boolean" ? { approveBuild: answer.approveBuild } : {}),
  };
}

/**
 * Read the tool's arguments into a proposal, or say what is wrong with them. Shape only — the rules
 * (vendor, hosts, scheme parameters) are `normaliseProposal`'s, so an agent reads one sentence
 * about the first thing to fix.
 */
export function readConnectionProposal(
  args: Record<string, unknown>,
): ConnectionProposalInput | { error: string } {
  const text = (key: string): string | undefined | { error: string } => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    return typeof value === "string" ? value : { error: `${key} must be a string` };
  };
  const problems: string[] = [];
  const read = (key: string) => {
    const value = text(key);
    if (typeof value === "object") {
      problems.push(value.error);
      return undefined;
    }
    return value;
  };
  const vendor = read("vendor");
  const displayName = read("displayName");
  const primaryHost = read("primaryHost");
  const scheme = read("scheme");
  const docsUrl = read("docsUrl");
  let hosts: string[] | undefined;
  if (args.hosts !== undefined) {
    if (!Array.isArray(args.hosts) || !args.hosts.every((host) => typeof host === "string")) {
      problems.push("hosts must be an array of hostnames");
    } else {
      hosts = args.hosts;
    }
  }
  let schemeConfig: Record<string, unknown> | undefined;
  if (args.schemeConfig !== undefined) {
    if (!isPlainObject(args.schemeConfig)) {
      problems.push("schemeConfig must be an object of string parameters");
    } else {
      schemeConfig = args.schemeConfig;
    }
  }
  if (problems.length > 0) return { error: problems.join("; ") };
  if (!vendor || !primaryHost || !scheme) {
    return { error: "vendor, primaryHost and scheme are required" };
  }
  return {
    vendor,
    ...(displayName === undefined ? {} : { displayName }),
    primaryHost,
    ...(hosts === undefined ? {} : { hosts }),
    scheme,
    ...(schemeConfig === undefined ? {} : { schemeConfig }),
    ...(docsUrl === undefined ? {} : { docsUrl }),
  };
}

export type ProposalVerdict =
  | {
      ok: true;
      payload: Omit<ConnectionProposalPayload, "provider">;
      /** The sign-in hosts set aside from the proposal's `hosts` (GRA-89), in the order proposed; empty when none. */
      hostsSetAside: string[];
    }
  | { ok: false; reason: string; message: string; details: Record<string, unknown> };

/**
 * The proposal against the connection service's own rules — the same functions the service applies
 * at create and the form applies as the person types — normalised into the payload the card
 * pre-fills. A refusal names the first thing to fix and, for a host, the reason word and the host.
 * The sign-in rule runs here too (the header's paragraph on GRA-89), so `payload.hosts` is what the
 * row will hold under any provider.
 */
export function normaliseProposal(input: ConnectionProposalInput): ProposalVerdict {
  const invalid = (message: string, details: Record<string, unknown> = {}): ProposalVerdict => ({
    ok: false,
    reason: "input_invalid",
    message,
    details,
  });
  const vendor = input.vendor.trim();
  const vendorProblem = validateVendor(vendor);
  if (vendorProblem) return invalid(vendorProblem, { field: "vendor" });
  const displayName = (input.displayName ?? vendor).trim();
  const nameProblem = validateDisplayName(displayName);
  if (nameProblem) return invalid(nameProblem, { field: "displayName" });
  // The signing schemes alone: a relay scheme is a provider's to write, never an agent's to propose.
  if (!isAuthScheme(input.scheme)) {
    return invalid(
      `Unknown scheme ${JSON.stringify(input.scheme)} — one of ${AUTH_SCHEMES.join(", ")}`,
      {
        field: "scheme",
      },
    );
  }
  const schemeConfig = input.schemeConfig ?? {};
  // A proposal: the person-entered parameters — an OAuth client id — may be absent (ADR 0005).
  const configProblem = validateSchemeConfig(input.scheme, schemeConfig, { proposal: true });
  if (configProblem) return invalid(configProblem, { field: "schemeConfig" });
  let docsUrl: string | null = null;
  if (input.docsUrl !== undefined && input.docsUrl.trim().length > 0) {
    try {
      const url = new URL(input.docsUrl.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http");
      docsUrl = url.toString();
    } catch {
      return invalid("docsUrl must be an http(s) URL — the page you read", { field: "docsUrl" });
    }
  }
  // The host rules come last, and the sign-in rule last of all (GRA-89): its note names hosts set
  // aside from a proposal that proceeds, so nothing refused for its shape carries one. Set aside
  // here, so the provider, the open-ask match and the row all see the same set; a primary host
  // that is a sign-in endpoint is the proposal's fault to fix.
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) {
    return {
      ok: false,
      reason: hostSet.reason === HOST_NOT_PUBLIC ? HOST_NOT_PUBLIC : "input_invalid",
      message: hostSet.problem,
      details: hostSet.host ? { host: hostSet.host } : {},
    };
  }
  const signIn = setAsideSignInHosts(
    input.scheme,
    schemeConfig,
    hostSet.primaryHost,
    hostSet.hosts,
  );
  if (!signIn.ok) return invalid(signIn.problem, { field: "primaryHost", host: signIn.host });
  return {
    ok: true,
    payload: {
      vendor,
      displayName,
      scheme: input.scheme,
      schemeConfig: schemeConfig as Record<string, string>,
      primaryHost: hostSet.primaryHost,
      hosts: signIn.hosts,
      docsUrl,
      note: PROPOSAL_PROVENANCE_NOTE,
    },
    hostsSetAside: signIn.setAside,
  };
}

/**
 * Two proposals are the same ask when everything the form would pre-fill is the same. The hosts are
 * the normalised ones, after the sign-in hosts were set aside (GRA-89): an agent that re-sends the
 * proposal with or without `accounts.google.com` in it is asking the same question, and takes the
 * answer the person already gave rather than opening a second ask.
 */
function proposalKey(payload: Record<string, unknown>): string {
  const config = isPlainObject(payload.schemeConfig) ? payload.schemeConfig : {};
  return JSON.stringify([
    payload.vendor,
    payload.displayName,
    payload.scheme,
    Object.keys(config)
      .sort()
      .map((key) => [key, config[key]]),
    payload.primaryHost,
    Array.isArray(payload.hosts) ? [...payload.hosts].sort() : [],
    payload.docsUrl ?? null,
  ]);
}

/**
 * Whether a connection of the person's reaches everything a proposal names: the same vendor, and
 * the proposal's host set within the row's, both read as the proxy reads a row at resolution
 * (`hostSetOf`: lower-case hostnames, the primary's among them). A row reaching more than proposed
 * covers it — a tool authored against it reaches every proposed host; one reaching less does not,
 * and the proposal proceeds to an ask for the wider row.
 */
export function coversProposal(
  connection: Pick<ConnectionOutput, "vendor" | "primaryHost" | "hosts">,
  proposal: Pick<ConnectionProposalPayload, "vendor" | "primaryHost" | "hosts">,
): boolean {
  if (connection.vendor !== proposal.vendor) return false;
  const reach = hostSetOf(connection);
  for (const host of hostSetOf(proposal)) {
    if (!reach.has(host)) return false;
  }
  return true;
}

/** The reason word `request_connection` answers when the person already has the connection proposed (GRA-76). */
export const CONNECTION_EXISTS = "connection_exists";

export type ExistingConnectionVerdict =
  | { kind: "connected"; connection: ConnectionOutput }
  /** A usable row of the person's this agent was not given: the `scope` ask (GRA-104). */
  | { kind: "scope"; connection: ConnectionOutput }
  | {
      kind: "refuse";
      reason: typeof CONNECTION_EXISTS;
      message: string;
      details: { connectionId: string; provider: string; revoked: boolean; inScope: boolean };
    };

const EXISTS_BECAUSE =
  "Do not propose it again: a new connection would be a new row with no scope and no approvals, and the person would answer the build approval again for the same account.";

/**
 * The connection a proposal already has, and what the agent does about it (GRA-76; the header's
 * paragraph on the approval staying with the row). Null when no row of the person's covers the
 * proposal, and the ask proceeds. Among several — a keyring row and a relay provider's for one
 * vendor — a live row beats a revoked one and this agent's beats another's, so the sentence names
 * the shortest step. A row whose provider this deployment no longer enables is not one the person
 * can act on here and is passed over; so is a revoked row of a link provider, because the link's
 * return reconnects it in place and the ask is its reconnection (GRA-59). A live, usable row this
 * agent was not given is the `scope` verdict — an ask, not a refusal (GRA-104) — and every other
 * state is the refusal naming the step.
 */
export function existingConnectionFor(
  connections: readonly ConnectionOutput[],
  scopeIds: readonly string[],
  providers: readonly ConnectionProvider[],
  proposal: Pick<ConnectionProposalPayload, "vendor" | "primaryHost" | "hosts">,
): ExistingConnectionVerdict | null {
  const candidates = connections.filter((connection) => {
    if (!coversProposal(connection, proposal)) return false;
    const provider = providerNamed(providers, connection.provider);
    if (!provider) return false;
    return !(connection.revokedAt !== null && provider.connect.kind === "link");
  });
  const inScope = (connection: ConnectionOutput) => scopeIds.includes(connection.id);
  const usable = candidates.find(
    (connection) => inScope(connection) && isConnectionUsable(connection, providers),
  );
  if (usable) return { kind: "connected", connection: usable };

  const rank = (connection: ConnectionOutput) =>
    (connection.revokedAt === null ? 0 : 2) + (inScope(connection) ? 0 : 1);
  const [row] = [...candidates].sort((a, b) => rank(a) - rank(b));
  if (!row) return null;
  // The person's row, working, not this agent's: the one step that grants it is theirs to take on
  // a page — so it is asked for, with a link (GRA-104), rather than described.
  if (row.revokedAt === null && !inScope(row) && isConnectionUsable(row, providers)) {
    return { kind: "scope", connection: row };
  }

  const what = `${row.displayName} (${row.vendor}) is already a connection of the person's, reaching every host you proposed`;
  const revoked = row.revokedAt !== null;
  const scoped = inScope(row);
  const reenter = `request_credential { connectionId: "${row.id}" }`;
  // A form row that takes a credential is the one `request_credential` re-enters (a consent
  // included); a `none` row or a provider's has nothing to enter, and the console is the step.
  const reenterable =
    providerNamed(providers, row.provider)?.connect.kind === "form" && takesCredential(row.scheme);
  let message: string;
  if (revoked) {
    message =
      `${what}, and the person revoked it. Ask them to reconnect it in the console (Connections, then Reconnect on the connection)` +
      (scoped && reenterable ? `; ${reenter} asks them the same, since it is in your scope` : "") +
      (scoped ? "" : ", and to add it to this agent's scope on this agent's page under Scope") +
      `. ${EXISTS_BECAUSE}`;
  } else if (scoped) {
    message = reenterable
      ? `${what}, and is in your scope, but its credential or consent is missing. Call ${reenter} so the person re-enters it in the console. ${EXISTS_BECAUSE}`
      : `${what}, and is in your scope, but is not usable yet. Ask the person to complete it in the console (Connections). ${EXISTS_BECAUSE}`;
  } else {
    // Outside the scope and not usable: allowing it would give the agent nothing to call through,
    // so both of the person's steps are named, the credential first (GRA-104 asks for a usable row).
    message =
      `${what}, but it is not usable yet and not in this agent's scope. Ask the person to complete it in the console (Connections${
        row.credentialSetAt === null && reenterable ? ", entering its credential" : ""
      }) and then to add it on this agent's page under Scope; ` +
      `a second account at the same vendor is added in the console, not proposed here. ${EXISTS_BECAUSE}`;
  }
  return {
    kind: "refuse",
    reason: CONNECTION_EXISTS,
    message,
    details: { connectionId: row.id, provider: row.provider, revoked, inScope: scoped },
  };
}

/**
 * `request_connection`: propose, and wait for the person to create the connection in the console.
 *
 * A connection to the same vendor reaching every proposed host, already in the agent's scope and
 * usable, is answered `connected` at once, with no ask — the agent that calls again after a
 * "connected" answer, or after a turn ended, should not have the person asked twice for one
 * account. One the person holds, usable, that this agent was not given is the `scope` ask
 * (GRA-104): `awaiting_scope` with a link, `connected` once the person allows it. One that exists
 * but is not anyone's to call through — its credential missing, or revoked — is the
 * `connection_exists` refusal naming it and the step that keeps the row (GRA-76). A person who
 * wants a second account at the same host adds it in the console.
 */
export async function requestConnection(
  ctx: ServiceContext,
  scope: AgentScope,
  input: ConnectionProposalInput,
  deps: McpDeps,
  notifier?: ToolListChangedNotifier,
): Promise<ConnectionRequestOutcome> {
  const verdict = normaliseProposal(input);
  if (!verdict.ok) return refuse(verdict.reason, verdict.message, verdict.details);
  const outcome = await routeProposal(ctx, scope, verdict.payload, deps, notifier);
  return namingHostsSetAside(outcome, verdict.hostsSetAside, verdict.payload.hosts);
}

/**
 * Whatever the call answers, the agent is told which of the hosts it listed were set aside as
 * sign-in endpoints (GRA-89) and which the connection reaches, so it does not read the shorter host
 * set on the card, or in a later `connected`, as something lost. Nothing is added when none were.
 */
function namingHostsSetAside(
  outcome: ConnectionRequestOutcome,
  setAside: readonly string[],
  hosts: readonly string[],
): ConnectionRequestOutcome {
  if (setAside.length === 0) return outcome;
  const one = setAside.length === 1;
  const sentence =
    `${setAside.join(", ")} ${one ? "is a sign-in endpoint and was" : "are sign-in endpoints and were"} set aside, not recorded on the connection: ` +
    "tool calls never reach a sign-in endpoint (the sign-in runs in the console or on the provider's page), and hosts is for the hosts they do reach, " +
    `here ${hosts.join(", ")}.`;
  const said = outcome.answer.message;
  const message = typeof said === "string" && said.length > 0 ? `${said} ${sentence}` : sentence;
  return outcome.isError
    ? { isError: true, answer: { ...outcome.answer, message, hostsSetAside: [...setAside] } }
    : { isError: false, answer: { ...outcome.answer, message, hostsSetAside: [...setAside] } };
}

/**
 * A normalised proposal to the provider that covers it, and on to the ask or the connection. The
 * host set is the normalised one, sign-in hosts already set aside, so a provider's `covers` judges
 * only the hosts tool calls will reach.
 */
async function routeProposal(
  ctx: ServiceContext,
  scope: AgentScope,
  proposal: Omit<ConnectionProposalPayload, "provider">,
  deps: McpDeps,
  notifier?: ToolListChangedNotifier,
): Promise<ConnectionRequestOutcome> {
  const provider = providerFor(deps.connection.providers, proposal.vendor, proposal.hosts);
  if (provider.connect.kind === "none") {
    return connectWithoutPersonStep(ctx, scope, provider, proposal, deps, notifier);
  }
  const link = provider.connect.kind === "link" ? provider.connect : null;
  const payload: ConnectionProposalPayload = {
    provider: provider.name,
    providerConnect: provider.connect.kind,
    providerTarget: link?.target(proposal.vendor, proposal.hosts) ?? null,
    ...proposal,
    ...(link ? { note: LINK_PROVENANCE_NOTE } : {}),
  };

  // An ask already made for this proposal comes first — answered or still open — so a call after
  // the person's submit takes the answer it was waiting for rather than finding the connection and
  // leaving the action untaken.
  const key = proposalKey(payload);
  const open = (
    await deps.listPendingActionsByKind(
      ctx.db,
      scope,
      CONNECTION_ASK_KIND,
      deps.pendingAction.now(),
    )
  ).find((row) => proposalKey(row.payload) === key);

  if (!open) {
    const principal = { personId: scope.personId };
    const [scopeIds, connections] = await Promise.all([
      getAgentScope(ctx, scope, deps.agent),
      listConnections(ctx, principal, deps.connection),
    ]);
    // The row the person already has for this vendor at these hosts, if any (the header's paragraph
    // on GRA-76): connected when it is usable and this agent's; otherwise the step that keeps it.
    const existing = existingConnectionFor(
      connections,
      scopeIds,
      deps.connection.providers,
      payload,
    );
    if (existing?.kind === "connected") {
      // A scope ask the person has answered and this agent has not read yet is taken first, so the
      // call that follows an Allow says so rather than "already connected, no ask was made".
      const answered = await openScopeAskFor(ctx, scope, existing.connection.id, deps);
      if (answered) return awaitScope(ctx, scope, answered, existing.connection, deps, notifier);
      return { isError: false, answer: connected(existing.connection, "already") };
    }
    if (existing?.kind === "refuse") {
      return refuse(existing.reason, existing.message, existing.details);
    }
    if (existing?.kind === "scope") {
      const { connection } = existing;
      // Find-or-make under a transaction-scoped advisory lock on (agent, kind, connection), so two
      // identical calls racing here make one ask: the second waits on the lock, then finds the
      // first's row. The table has no uniqueness over the payload; the lock stands in for one
      // without a migration (Greptile on #87). The wait that follows runs outside the transaction.
      const action = await ctx.db.transaction(async (tx) => {
        const scoped: ServiceContext = { db: tx };
        await deps.lockPendingActionKey(tx, scope, SCOPE_ASK_KIND, connection.id);
        return (
          (await openScopeAskFor(scoped, scope, connection.id, deps)) ??
          createPendingAction(
            scoped,
            scope,
            {
              kind: SCOPE_ASK_KIND,
              payload: scopeAskPayload(connection, proposal.docsUrl),
              ttlMs: deps.handoff.ttlMs,
              connectionId: connection.id,
            },
            deps.pendingAction,
          )
        );
      });
      return awaitScope(ctx, scope, action, connection, deps, notifier);
    }
  }

  const action =
    open ??
    (await createPendingAction(
      ctx,
      scope,
      { kind: CONNECTION_ASK_KIND, payload, ttlMs: deps.handoff.ttlMs },
      deps.pendingAction,
    ));

  // A link provider's ask is one click; the OAuth guidance is the keyring's form's alone (ADR 0005).
  const oauth = !link && isOAuthAuthorizationCode(payload.scheme);
  const redirectUri = oauth ? deps.oauthRedirectUri : undefined;
  const what = `${payload.displayName} (${payload.vendor})`;
  return waitForAnswer(ctx, scope, action, deps, {
    awaiting: "awaiting_connection",
    what,
    card: (url, agentName) => connectionAskCard({ action, agentName, payload, url }),
    settle: (taken) =>
      settleByConnectionId(ctx, scope, taken, deps, {
        what,
        declinedReason: "connection_declined",
        onConnected: async (connection) => {
          // The connection's execute tool is now in the list of every agent whose scope reaches
          // the row (ADR 0003; `connected.ts`) — this one's, and every agent on `all`.
          await notifyAgentsReachingConnection(
            ctx,
            { personId: scope.personId },
            connection.id,
            deps,
            notifier,
          );
          return connected(connection, "new");
        },
      }),
    ...(redirectUri ? { awaitingExtra: { redirectUri } } : {}),
    ...(link ? { awaitingExtra: { provider: provider.name } } : {}),
    awaitingMessage: (url, expiresAt) =>
      link
        ? `Graft needs the person to connect ${payload.displayName} (${payload.vendor}) through ${provider.name} — one click: they sign in at the vendor on ${provider.name}'s page, and the vendor's token stays there; nothing passes through you, and nothing is typed in the console. ` +
          `Relay this link so they can press Connect: ${url} It expires at ${expiresAt}. ` +
          `${BUILD_APPROVAL_ON_THE_PAGE} ` +
          "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected."
        : oauth
          ? // The agent is the guide (ADR 0005): which console, what to name the client, which URI.
            `Graft needs the person to connect ${payload.displayName} (${payload.vendor}) with an OAuth client they register at the vendor — the client secret and the tokens never pass through you. ` +
            "Guide them in three sentences: open the vendor's developer console and create an OAuth client of the web-application kind; name it after Graft so they recognise it later; " +
            (redirectUri
              ? `and paste exactly this redirect URI into it: ${redirectUri} `
              : "and paste the redirect URI the form shows into it. ") +
            `Then relay this link so they can enter the client id and secret and complete the consent in a popup: ${url} It expires at ${expiresAt}. ` +
            `${BUILD_APPROVAL_ON_THE_PAGE} ` +
            "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected. " +
            "A Google Cloud project in Testing mode expires refresh tokens after seven days, so a Google connection reconnects weekly until the app is published."
          : takesCredential(payload.scheme)
            ? `Graft needs the person to enter the credential for ${payload.displayName} (${payload.vendor}) in the console — the secret never passes through you. ` +
              `Relay this link so they can check the hosts and enter it: ${url} It expires at ${expiresAt}. ` +
              `${BUILD_APPROVAL_ON_THE_PAGE} ` +
              "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected."
            : // A keyless scheme (GRA-66) has nothing to enter: the ask is a confirmation of the
              // hosts, and the message names no credential and no secret (GRA-91).
              `Graft needs the person to confirm the connection to ${payload.displayName} (${payload.vendor}) in the console — the scheme takes no credential, so nothing is entered. ` +
              `Relay this link so they can check the hosts and confirm it: ${url} It expires at ${expiresAt}. ` +
              `${BUILD_APPROVAL_ON_THE_PAGE} ` +
              "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected.",
  });
}

/** The `scope` ask's payload off the row it is about (GRA-104): the card's facts, and the documentation proposed. */
function scopeAskPayload(connection: ConnectionOutput, docsUrl: string | null): ScopeAskPayload {
  return {
    connectionId: connection.id,
    vendor: connection.vendor,
    displayName: connection.displayName,
    provider: connection.provider,
    primaryHost: connection.primaryHost,
    hosts: connection.hosts,
    scheme: connection.scheme,
    docsUrl,
  };
}

/**
 * This agent's open `scope` ask about a connection — unanswered, or answered and not yet taken —
 * or null. One per agent and connection (GRA-104): a re-proposal re-uses it, and a call after the
 * person's answer takes that answer rather than asking again.
 */
async function openScopeAskFor(
  ctx: ServiceContext,
  scope: AgentScope,
  connectionId: string,
  deps: McpDeps,
): Promise<PendingActionRow | null> {
  const rows = await deps.listPendingActionsByKind(
    ctx.db,
    scope,
    SCOPE_ASK_KIND,
    deps.pendingAction.now(),
  );
  return rows.find((row) => row.payload.connectionId === connectionId) ?? null;
}

/**
 * The `scope` ask's wait (GRA-104): the connection ask's, with the answer read as a yes or no on
 * the row named in the payload. A yes is `connected` — the console's answer has already grown the
 * scope (`ask-answer.ts`), so the row is read back and checked to be this agent's now; a person
 * who allowed it and then took it out of the scope before the agent called again is refused
 * `connection_not_in_scope`, never read as having said yes to what stands. A no is
 * `scope_declined`, and the next call asks afresh.
 */
async function awaitScope(
  ctx: ServiceContext,
  scope: AgentScope,
  action: PendingActionRow,
  connection: ConnectionOutput,
  deps: McpDeps,
  notifier?: ToolListChangedNotifier,
): Promise<ConnectionRequestOutcome> {
  const what = `${connection.displayName} (${connection.vendor})`;
  const payload = action.payload as unknown as ScopeAskPayload;
  const via = connection.provider === KEYRING_PROVIDER ? "" : `, via ${connection.provider}`;
  return waitForAnswer(ctx, scope, action, deps, {
    awaiting: "awaiting_scope",
    what,
    card: (url, agentName) => scopeAskCard({ action, agentName, payload, url }),
    awaitingExtra: { connectionId: connection.id, provider: connection.provider },
    awaitingMessage: (url, expiresAt) =>
      `The person already has a connection to ${what}${via}, made for another of their agents; Graft needs them to allow you to use it — no new connection, nothing entered. ` +
      `Relay this link so they can allow it in the console: ${url} It expires at ${expiresAt}. ` +
      `${BUILD_APPROVAL_ON_THE_PAGE} ` +
      "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected.",
    settle: async (taken) => {
      const said = readScopeAnswer(taken.answer);
      if (!said.allow) {
        return refuse(
          "scope_declined",
          `The person declined to let you use ${what} in the console. Ask them before proposing it again.`,
          { pendingActionId: taken.id, connectionId: connection.id },
        );
      }
      const [row, scopeIds] = await Promise.all([
        getConnection(ctx, { personId: scope.personId }, connection.id, deps.connection),
        getAgentScope(ctx, scope, deps.agent),
      ]);
      if (!row || !scopeIds.includes(row.id)) {
        return refuse(
          "connection_not_in_scope",
          `The person allowed you to use ${what}, but it is not in your scope now — they took it out again, or revoked it. Ask them; the scope picker on this agent's page in the console adds it back.`,
          { pendingActionId: taken.id, connectionId: connection.id },
        );
      }
      // The connection's execute tool is now in this agent's list (ADR 0003).
      notifier?.changed(scope.agentId);
      return { isError: false, answer: connected(row, "scope") };
    },
  });
}

/**
 * A proposal a provider with no person step covers (ADR 0019; the gateway, GRA-58): the row is
 * made under the provider with no credential and put in this agent's scope in one transaction, and
 * the call answers `connected` at once — no ask, no link, nobody typed anything. The header of this
 * file says why nobody is asked. Two refusals guard the person's decisions: a row the person
 * revoked stays revoked until they reconnect it in the console, and a row the person has not given
 * this agent — made for another agent, or taken out of this one's scope — is theirs to add in the
 * scope picker; both answers name the console step, and neither is undone by asking again.
 */
async function connectWithoutPersonStep(
  ctx: ServiceContext,
  scope: AgentScope,
  provider: ConnectionProvider,
  payload: Omit<ConnectionProposalPayload, "provider">,
  deps: McpDeps,
  notifier?: ToolListChangedNotifier,
): Promise<ConnectionRequestOutcome> {
  const principal = { personId: scope.personId };
  const [scopeIds, connections] = await Promise.all([
    getAgentScope(ctx, scope, deps.agent),
    listConnections(ctx, principal, deps.connection),
  ]);
  const sameAccount = connections.filter(
    (connection) =>
      connection.vendor === payload.vendor && connection.primaryHost === payload.primaryHost,
  );
  const reaches = (connection: ConnectionOutput) =>
    payload.hosts.every((host) => connection.hosts.includes(host));
  // Already connected and in scope, under any provider: the rule every proposal answers to first —
  // for a row that reaches every host proposed. A narrower row would answer "already" and then
  // refuse the new host as `host_not_in_set`; the provider's own row is widened instead, below.
  const inScope = sameAccount.filter(
    (connection) =>
      scopeIds.includes(connection.id) && isConnectionUsable(connection, deps.connection.providers),
  );
  const whole = inScope.find(reaches);
  if (whole) return { isError: false, answer: connected(whole, "already") };
  const narrower = inScope.find((connection) => connection.provider === provider.name);
  if (narrower) {
    const widened = await widenProviderConnectionHosts(
      ctx,
      principal,
      provider,
      narrower.id,
      payload.hosts,
      deps.connection,
    );
    return { isError: false, answer: connected(widened, "widened") };
  }

  const what = `${payload.displayName} (${payload.vendor})`;
  const existing = sameAccount.find((connection) => connection.provider === provider.name);
  if (existing) {
    if (existing.revokedAt !== null) {
      return refuse(
        "connection_revoked",
        `${what} was connected through the ${provider.name} provider and the person revoked it. Ask them to reconnect it in the console (Connections, then Reconnect on the connection); do not propose it under another provider.`,
        { connectionId: existing.id, provider: provider.name },
      );
    }
    return refuse(
      "connection_not_in_scope",
      `${what} is connected through the ${provider.name} provider but is not in this agent's scope. The person can add it in the console, on this agent's page under Scope.`,
      { connectionId: existing.id, provider: provider.name },
    );
  }

  const connection = await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    const created = await registerProviderConnection(
      scoped,
      principal,
      provider,
      {
        vendor: payload.vendor,
        displayName: payload.displayName,
        primaryHost: payload.primaryHost,
        hosts: payload.hosts,
      },
      deps.connection,
    );
    // The agent that asked gets it (ADR 0007), as the console's submit does — a no-op for an
    // agent on `all`, whose scope the row is in already (ADR 0007 as amended 2026-09-19).
    await addConnectionToAgentScope(scoped, principal, scope.agentId, created.id, deps.agent);
    return created;
  });
  // The connection's execute tool is now in the list of every agent whose scope reaches the row
  // (ADR 0003; `connected.ts`): this one's, and every agent on `all`.
  await notifyAgentsReachingConnection(ctx, principal, connection.id, deps, notifier);
  return { isError: false, answer: connected(connection, "provider") };
}

/**
 * `request_credential`: ask the person to re-enter an existing connection's credential. The
 * connection must be in the agent's scope — the same rule as its execute tool, since a vendor 401
 * can only have reached an agent that could call the vendor. A revoked connection qualifies: the
 * re-entry is the reconnection ADR 0007 describes, and the card says so.
 */
export async function requestCredential(
  ctx: ServiceContext,
  scope: AgentScope,
  input: CredentialRequestInput,
  deps: McpDeps,
): Promise<ConnectionRequestOutcome> {
  const connectionId = input.connectionId.trim();
  if (!connectionId) return refuse("input_invalid", "connectionId must be a non-empty string");
  const scopeIds = await getAgentScope(ctx, scope, deps.agent);
  if (!scopeIds.includes(connectionId)) {
    return refuse(
      "connection_not_in_scope",
      `Connection ${connectionId} is not in this agent's scope. The person can add it in the console.`,
    );
  }
  const connection = await getConnection(
    ctx,
    { personId: scope.personId },
    connectionId,
    deps.connection,
  );
  if (!connection) {
    return refuse("connection_not_found", `Connection ${connectionId} does not exist.`);
  }
  // A relay provider's connection has no credential in Graft to re-enter (ADR 0019).
  const provider = providerNamed(deps.connection.providers, connection.provider);
  if (provider && provider.connect.kind !== "form") {
    return refuse(
      "credential_not_applicable",
      `${connection.displayName} (${connection.vendor}) is connected through the ${provider.name} provider, which holds its credential; there is nothing to re-enter in the console. Tell the person to reconnect it through ${provider.name}.`,
      { provider: provider.name },
    );
  }
  // The provider check above is the rule; this is its type: a keyring row carries a signing scheme.
  if (!isAuthScheme(connection.scheme)) {
    return refuse(
      "credential_not_applicable",
      `${connection.displayName} (${connection.vendor}) relays through ${connection.scheme}; there is no credential in Graft to re-enter.`,
      { provider: connection.provider },
    );
  }
  // A `none` connection sends no credential (GRA-66): a vendor refusing it is not a key problem.
  if (!takesCredential(connection.scheme)) {
    return refuse(
      "credential_not_applicable",
      `${connection.displayName} (${connection.vendor}) uses the none scheme and sends no credential; there is nothing to re-enter. If the vendor refuses calls, it is not the key: read its answer.`,
      { provider: connection.provider },
    );
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  const payload: CredentialAskPayload = {
    connectionId: connection.id,
    vendor: connection.vendor,
    connectionName: connection.displayName,
    scheme: connection.scheme,
    hosts: connection.hosts,
    reason: reason.length > 0 ? reason : null,
    revoked: connection.revokedAt !== null,
  };

  const open = (
    await deps.listPendingActionsByKind(
      ctx.db,
      scope,
      CREDENTIAL_ASK_KIND,
      deps.pendingAction.now(),
    )
  ).find((row) => row.payload.connectionId === connection.id);
  const action =
    open ??
    (await createPendingAction(
      ctx,
      scope,
      {
        kind: CREDENTIAL_ASK_KIND,
        payload,
        ttlMs: deps.handoff.ttlMs,
        connectionId: connection.id,
      },
      deps.pendingAction,
    ));

  const what = `${connection.displayName} (${connection.vendor})`;
  return waitForAnswer(ctx, scope, action, deps, {
    awaiting: "awaiting_credential",
    what,
    card: (url, agentName) => credentialAskCard({ action, agentName, payload, url }),
    settle: (taken) =>
      settleByConnectionId(ctx, scope, taken, deps, {
        what,
        declinedReason: "credential_declined",
        onConnected: (row) => connected(row, "credential"),
      }),
    awaitingMessage: (url, expiresAt) =>
      `Graft needs the person to re-enter the credential for ${connection.displayName} (${connection.vendor}) in the console — the secret never passes through you. ` +
      `Relay this link: ${url} It expires at ${expiresAt}. ` +
      "Call request_credential again once they have — the answer is kept, and the call then answers connected.",
  });
}

function connected(
  connection: ConnectionOutput,
  how: "new" | "already" | "credential" | "provider" | "widened" | "scope",
): Connected {
  const executeTool = executeToolName(connection.id);
  const what = `${connection.displayName} (${connection.vendor})`;
  const message =
    how === "credential"
      ? `The credential for ${what} was re-entered. Call the vendor again; nothing else changed.`
      : how === "already"
        ? `${what} is already connected and in your scope as ${executeTool}; no new ask was made.`
        : how === "widened"
          ? `${what} is already connected and in your scope as ${executeTool}; its host set now also reaches the hosts you proposed (${connection.hosts.join(", ")}). No new ask was made.`
          : how === "scope"
            ? `Allowed. ${what} is now in your scope; its execute tool is ${executeTool}. It is the connection the person already had, so nothing was entered and no new connection was made. Your tool list changed; re-fetch it.`
            : how === "provider"
              ? `Connected with no person step. ${what} is reachable through the API gateway this deployment is configured with (the ${connection.provider} provider), which holds the credential and receives every call; nothing was entered by anyone, and the scheme you proposed is not used. It is in your scope; its execute tool is ${executeTool}. Your tool list changed; re-fetch it.`
              : `Connected. ${what} is in your scope; its execute tool is ${executeTool}. Your tool list changed; re-fetch it.`;
  return {
    status: "connected",
    connectionId: connection.id,
    provider: connection.provider,
    executeTool,
    message,
  };
}

/**
 * The wait, shared by the three asks: poll for the answer up to the handoff's wait, then return the
 * awaiting result the agent relays. A taken answer is the ask's own to read (`settle`): for the
 * connection and credential asks one that names a connection is `connected` and one that does
 * not — the generic decline — is a refusal that says so (`settleByConnectionId`); the scope ask
 * reads a yes or no (`awaitScope`). An expired ask is a refusal too, and the next call asks
 * afresh. `CONFLICT` means a sibling call of this agent took the answer, and the row is read back
 * so both calls answer alike rather than one asking the person again.
 */
async function waitForAnswer(
  ctx: ServiceContext,
  scope: AgentScope,
  action: PendingActionRow,
  deps: McpDeps,
  ask: {
    awaiting: AwaitingHandoff["error"];
    what: string;
    /** What the taken answer means for this ask — `connected`, or the refusal that says what the person said. */
    settle: (taken: PendingActionRow) => Promise<ConnectionRequestOutcome>;
    awaitingMessage: (url: string, expiresAt: string) => string;
    /** What the awaiting answer carries beyond the link — an OAuth proposal's redirect URI, a provider's name, the scope ask's connection. */
    awaitingExtra?: Pick<AwaitingHandoff, "redirectUri" | "provider" | "connectionId">;
    /** The ask card's data for a host that renders one (GRA-84), given the link and the agent's name. */
    card: (url: string, agentName: string) => AskCard;
  },
): Promise<ConnectionRequestOutcome> {
  const url = handoffUrl(
    deps.handoff.consoleUrl,
    action.id,
    signHandoffToken(action, deps.handoff.secret),
  );
  const deadline = Date.now() + Math.max(0, deps.handoff.waitMs);
  const poll = deps.handoff.pollMs ?? DEFAULT_POLL_MS;

  for (;;) {
    let taken: PendingActionRow | null;
    try {
      taken = await consumePendingAction(ctx, scope, action.id, deps.pendingAction);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "GONE") {
        return refuse(
          "handoff_expired",
          `The ask ${ask.awaiting === "awaiting_scope" ? "to use" : "to connect"} ${ask.what} expired before the person answered. Calling again asks afresh.`,
          { pendingActionId: action.id },
        );
      }
      if (error instanceof ServiceError && error.code === "CONFLICT") {
        taken = await getPendingAction(ctx, scope, action.id, deps.pendingAction);
        if (!taken) throw error;
      } else {
        throw error;
      }
    }
    if (taken) return ask.settle(taken);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(poll, remaining)));
  }

  const expiresAt = action.expiresAt.toISOString();
  const awaiting: AwaitingHandoff = {
    error: ask.awaiting,
    reason: ask.awaiting,
    pendingActionId: action.id,
    url,
    expiresAt,
    message: ask.awaitingMessage(url, expiresAt),
    ...ask.awaitingExtra,
  };
  // The agent's name is read here, on the ask path alone: the card shows who is asking.
  const agent = await getAgent(ctx, { personId: scope.personId }, scope.agentId, deps.agent);
  return { isError: true, answer: awaiting, card: ask.card(url, agent?.name ?? scope.agentId) };
}

/** The connection and credential asks' answer: the row the console named, or the generic decline. */
async function settleByConnectionId(
  ctx: ServiceContext,
  scope: AgentScope,
  taken: PendingActionRow,
  deps: McpDeps,
  ask: {
    what: string;
    declinedReason: string;
    onConnected: (c: ConnectionOutput) => Connected | Promise<Connected>;
  },
): Promise<ConnectionRequestOutcome> {
  const answer = readConnectionAnswer(taken.answer);
  const connection = answer
    ? await getConnection(ctx, { personId: scope.personId }, answer.connectionId, deps.connection)
    : null;
  if (!connection) {
    return refuse(
      ask.declinedReason,
      `The person declined to connect ${ask.what} in the console. Ask them before proposing it again.`,
      { pendingActionId: taken.id },
    );
  }
  return { isError: false, answer: await ask.onConnected(connection) };
}
