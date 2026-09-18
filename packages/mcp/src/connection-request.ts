import {
  type AgentScope,
  addConnectionToAgentScope,
  type ConnectionOutput,
  type ConnectionProvider,
  consumePendingAction,
  createPendingAction,
  getAgentScope,
  getConnection,
  getPendingAction,
  HOST_NOT_PUBLIC,
  isConnectionUsable,
  isOAuthAuthorizationCode,
  listConnections,
  providerFor,
  providerNamed,
  registerProviderConnection,
  type ServiceContext,
  ServiceError,
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
 * whose credential or consent is missing — the re-entry its card handles, consent included), the
 * console's Reconnect (a revoked row), or the console's scope picker (a row this agent was not
 * given). Hosts are matched as the proxy matches them at resolution (`hostSetOf`): the proposal's
 * set within the row's, so a row reaching more than proposed counts and one reaching less does
 * not. One row takes a new ask on purpose: a revoked row of a **link** provider, because the
 * link's return reconnects it in place (GRA-59, `connectThroughProvider`) — the ask *is* its
 * reconnection. A gateway proposal never reaches this check (`connectWithoutPersonStep` has its
 * own two refusals, above).
 */

export const CONNECTION_ASK_KIND = "connection";
export const CREDENTIAL_ASK_KIND = "credential";

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
};

/** The result a call returns when the person has not entered the secret inside the wait. */
export type AwaitingHandoff = {
  error: "awaiting_connection" | "awaiting_credential";
  reason: "awaiting_connection" | "awaiting_credential";
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
};

export type ConnectionRequestOutcome =
  | { isError: false; answer: Connected }
  | { isError: true; answer: Record<string, unknown> };

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
  | { ok: true; payload: Omit<ConnectionProposalPayload, "provider"> }
  | { ok: false; reason: string; message: string; details: Record<string, unknown> };

/**
 * The proposal against the connection service's own rules — the same functions the service applies
 * at create and the form applies as the person types — normalised into the payload the card
 * pre-fills. A refusal names the first thing to fix and, for a host, the reason word and the host.
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
  const hostSet = validateHostSet(input.primaryHost, input.hosts ?? []);
  if (!hostSet.ok) {
    return {
      ok: false,
      reason: hostSet.reason === HOST_NOT_PUBLIC ? HOST_NOT_PUBLIC : "input_invalid",
      message: hostSet.problem,
      details: hostSet.host ? { host: hostSet.host } : {},
    };
  }
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
  return {
    ok: true,
    payload: {
      vendor,
      displayName,
      scheme: input.scheme,
      schemeConfig: schemeConfig as Record<string, string>,
      primaryHost: hostSet.primaryHost,
      hosts: hostSet.hosts,
      docsUrl,
      note: PROPOSAL_PROVENANCE_NOTE,
    },
  };
}

/** Two proposals are the same ask when everything the form would pre-fill is the same. */
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
 * return reconnects it in place and the ask is its reconnection (GRA-59).
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
    message =
      `${what}, but it is not in this agent's scope. Ask the person to add it on this agent's page in the console, under Scope` +
      (row.credentialSetAt === null && reenterable
        ? ", and to enter its credential on the connection"
        : "") +
      `; a second account at the same vendor is added in the console, not proposed here. ${EXISTS_BECAUSE}`;
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
 * account. One that exists but is not this agent's to call through — its credential missing,
 * revoked, or outside this agent's scope — is the `connection_exists` refusal naming it and the
 * step that keeps the row (GRA-76). A person who wants a second account at the same host adds it
 * in the console.
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
  const provider = providerFor(
    deps.connection.providers,
    verdict.payload.vendor,
    verdict.payload.hosts,
  );
  if (provider.connect.kind === "none") {
    return connectWithoutPersonStep(ctx, scope, provider, verdict.payload, deps, notifier);
  }
  const link = provider.connect.kind === "link" ? provider.connect : null;
  const payload: ConnectionProposalPayload = {
    provider: provider.name,
    providerConnect: provider.connect.kind,
    providerTarget: link?.target(verdict.payload.vendor, verdict.payload.hosts) ?? null,
    ...verdict.payload,
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
      return { isError: false, answer: connected(existing.connection, "already") };
    }
    if (existing?.kind === "refuse") {
      return refuse(existing.reason, existing.message, existing.details);
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
  return waitForAnswer(ctx, scope, action, deps, {
    awaiting: "awaiting_connection",
    what: `${payload.displayName} (${payload.vendor})`,
    declinedReason: "connection_declined",
    onConnected: (connection) => {
      // The connection's execute tool is now in this agent's list (ADR 0003).
      notifier?.changed(scope.agentId);
      return connected(connection, "new");
    },
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
          : `Graft needs the person to enter the credential for ${payload.displayName} (${payload.vendor}) in the console — the secret never passes through you. ` +
            `Relay this link so they can check the hosts and enter it: ${url} It expires at ${expiresAt}. ` +
            `${BUILD_APPROVAL_ON_THE_PAGE} ` +
            "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected.",
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
    // The agent that asked gets it, and no other (ADR 0007), as the console's submit does.
    await addConnectionToAgentScope(scoped, principal, scope.agentId, created.id, deps.agent);
    return created;
  });
  // The connection's execute tool is now in this agent's list (ADR 0003).
  notifier?.changed(scope.agentId);
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

  return waitForAnswer(ctx, scope, action, deps, {
    awaiting: "awaiting_credential",
    what: `${connection.displayName} (${connection.vendor})`,
    declinedReason: "credential_declined",
    onConnected: (row) => connected(row, "credential"),
    awaitingMessage: (url, expiresAt) =>
      `Graft needs the person to re-enter the credential for ${connection.displayName} (${connection.vendor}) in the console — the secret never passes through you. ` +
      `Relay this link: ${url} It expires at ${expiresAt}. ` +
      "Call request_credential again once they have — the answer is kept, and the call then answers connected.",
  });
}

function connected(
  connection: ConnectionOutput,
  how: "new" | "already" | "credential" | "provider" | "widened",
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
 * The wait, shared by both asks: poll for the answer up to the handoff's wait, then return the
 * awaiting result the agent relays. An answer that names a connection is `connected`; one that
 * does not — the generic decline — is a refusal that says so; an expired ask is a refusal too,
 * and the next call asks afresh. `CONFLICT` means a sibling call of this agent took the answer,
 * and the row is read back so both calls answer alike rather than one asking the person again.
 */
async function waitForAnswer(
  ctx: ServiceContext,
  scope: AgentScope,
  action: PendingActionRow,
  deps: McpDeps,
  ask: {
    awaiting: AwaitingHandoff["error"];
    what: string;
    declinedReason: string;
    onConnected: (connection: ConnectionOutput) => Connected;
    awaitingMessage: (url: string, expiresAt: string) => string;
    /** What the awaiting answer carries beyond the link — the redirect URI of an OAuth proposal, or a link provider's name. */
    awaitingExtra?: Pick<AwaitingHandoff, "redirectUri" | "provider">;
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
          `The ask to connect ${ask.what} expired before the person answered. Calling again asks afresh.`,
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
    if (taken) return settle(ctx, scope, taken, deps, ask);
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
  return { isError: true, answer: awaiting };
}

async function settle(
  ctx: ServiceContext,
  scope: AgentScope,
  taken: PendingActionRow,
  deps: McpDeps,
  ask: { what: string; declinedReason: string; onConnected: (c: ConnectionOutput) => Connected },
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
  return { isError: false, answer: ask.onConnected(connection) };
}
