import {
  type AgentScope,
  type ConnectionOutput,
  consumePendingAction,
  createPendingAction,
  getAgentScope,
  getConnection,
  getPendingAction,
  HOST_NOT_PUBLIC,
  isConnectionUsable,
  isOAuthAuthorizationCode,
  listConnections,
  type ServiceContext,
  ServiceError,
  validateDisplayName,
  validateHostSet,
  validateSchemeConfig,
  validateVendor,
} from "@graft/core";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { type ConnectionScheme, connectionScheme } from "@graft/db/schema/connection";
import { SCHEME_CREDENTIAL_FIELDS } from "@graft/proxy/credential-fields";
import { SCHEME_PARAMETERS } from "@graft/proxy/scheme-parameters";

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
 */

export const CONNECTION_ASK_KIND = "connection";
export const CREDENTIAL_ASK_KIND = "credential";

/** What a `connection` ask carries: the proposal, normalised — everything the form pre-fills (ADR 0006). */
export type ConnectionProposalPayload = {
  vendor: string;
  displayName: string;
  scheme: ConnectionScheme;
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
  scheme: ConnectionScheme;
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

/** What either tool answers once the person has entered the secret — and nothing about the secret. */
export type Connected = {
  status: "connected";
  connectionId: string;
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

/** The scheme table in one sentence, for the tool's description — generated so it cannot drift. */
export function describeSchemes(): string {
  return connectionScheme
    .map((scheme) => {
      const rule = SCHEME_PARAMETERS[scheme];
      const parameters = [
        ...rule.required,
        ...rule.optional.map((parameter) => `optional ${parameter}`),
      ];
      // What the person supplies on the form: the scheme's secret fields, and the parameters only
      // they can know — an OAuth client id (ADR 0005), which the proposal leaves out.
      const entered = [...(rule.personEntered ?? []), ...SCHEME_CREDENTIAL_FIELDS[scheme]].join(
        ", ",
      );
      return `${scheme} (parameters: ${parameters.join(", ") || "none"}; the person enters: ${entered})`;
    })
    .join("; ");
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
  | { ok: true; payload: ConnectionProposalPayload }
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
  if (!isConnectionScheme(input.scheme)) {
    return invalid(
      `Unknown scheme ${JSON.stringify(input.scheme)} — one of ${connectionScheme.join(", ")}`,
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

function isConnectionScheme(value: string): value is ConnectionScheme {
  return (connectionScheme as readonly string[]).includes(value);
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
 * `request_connection`: propose, and wait for the person to create the connection in the console.
 *
 * A connection to the same vendor and primary host already in the agent's scope and holding a
 * credential is answered `connected` at once, with no ask — the agent that calls again after a
 * "connected" answer, or after a turn ended, should not have the person asked twice for one
 * account. A person who wants a second account at the same host adds it in the console.
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
  const { payload } = verdict;

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
    // Usable, not merely present: an authorization-code connection whose consent has not completed
    // is not one the agent can call through (ADR 0005), so the ask proceeds.
    const existing = connections.find(
      (connection) =>
        scopeIds.includes(connection.id) &&
        isConnectionUsable(connection) &&
        connection.vendor === payload.vendor &&
        connection.primaryHost === payload.primaryHost,
    );
    if (existing) return { isError: false, answer: connected(existing, "already") };
  }

  const action =
    open ??
    (await createPendingAction(
      ctx,
      scope,
      { kind: CONNECTION_ASK_KIND, payload, ttlMs: deps.handoff.ttlMs },
      deps.pendingAction,
    ));

  const oauth = isOAuthAuthorizationCode(payload.scheme);
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
    awaitingMessage: (url, expiresAt) =>
      oauth
        ? // The agent is the guide (ADR 0005): which console, what to name the client, which URI.
          `Graft needs the person to connect ${payload.displayName} (${payload.vendor}) with an OAuth client they register at the vendor — the client secret and the tokens never pass through you. ` +
          "Guide them in three sentences: open the vendor's developer console and create an OAuth client of the web-application kind; name it after Graft so they recognise it later; " +
          (redirectUri
            ? `and paste exactly this redirect URI into it: ${redirectUri} `
            : "and paste the redirect URI the form shows into it. ") +
          `Then relay this link so they can enter the client id and secret and complete the consent in a popup: ${url} It expires at ${expiresAt}. ` +
          "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected. " +
          "A Google Cloud project in Testing mode expires refresh tokens after seven days, so a Google connection reconnects weekly until the app is published."
        : `Graft needs the person to enter the credential for ${payload.displayName} (${payload.vendor}) in the console — the secret never passes through you. ` +
          `Relay this link so they can check the hosts and enter it: ${url} It expires at ${expiresAt}. ` +
          "Call request_connection again with the same proposal once they have — the answer is kept, and the call then answers connected.",
  });
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

function connected(connection: ConnectionOutput, how: "new" | "already" | "credential"): Connected {
  const executeTool = executeToolName(connection.id);
  const message =
    how === "credential"
      ? `The credential for ${connection.displayName} (${connection.vendor}) was re-entered. Call the vendor again; nothing else changed.`
      : how === "already"
        ? `${connection.displayName} (${connection.vendor}) is already connected and in your scope as ${executeTool}; no new ask was made.`
        : `Connected. ${connection.displayName} (${connection.vendor}) is in your scope; its execute tool is ${executeTool}. Your tool list changed; re-fetch it.`;
  return { status: "connected", connectionId: connection.id, executeTool, message };
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
    /** What the awaiting answer carries beyond the link — the redirect URI of an OAuth proposal. */
    awaitingExtra?: Pick<AwaitingHandoff, "redirectUri">;
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
