import {
  type AgentDeps,
  type ApprovalDeps,
  allowVendorWhenConnecting,
  type ConnectionDeps,
  type ConnectionOutput,
  type ConnectionProvider,
  type ConsoleLinkStatePayload,
  connectThroughProvider,
  getAgentScope,
  grantBuildApproval,
  type IntegrationDirectory,
  isConnectionUsable,
  KEYRING_PROVIDER,
  LINK_OUTCOME_PARAM,
  LINK_STATE_PARAM,
  LINK_STATE_TTL_MS,
  type LinkCallbackOutcome,
  linkCallbackUri,
  listAgents,
  listConnections,
  type Principal,
  providerDisplayName,
  providerFor,
  providerLinkOf,
  providerNamed,
  registerConnectionWithCredential,
  registerProviderConnection,
  type ServiceContext,
  ServiceError,
  signConsoleLinkState,
  starterProposal,
  starterVendorOf,
  widenKeylessConnectionHosts,
  widenProviderConnectionHosts,
} from "@graft/core";
import {
  type ConnectionProposalInput,
  coversProposal,
  normaliseProposal,
  notifyAgentsReachingConnection,
  type ToolListChangedNotifier,
} from "@graft/mcp";
import type { AuthScheme } from "@graft/proxy/types";

import { directoryProposal, withStarter } from "./directory";

/**
 * The person connects an integration from the console with **no agent asking** (ADR 0006 as
 * amended 2026-10-14; GRA-304): Discover's Connect and a proposal Graft read from an API's
 * documentation. `POST /api/connect` routes the integration to the first provider that covers it
 * (`providerFor`, the deployment's order) exactly as `request_connection` would, and answers what
 * the console does next, with no pending action anywhere:
 *
 * - `connected`: a provider with no person step made the row (or widened the person's own), or a
 *   keyless integration was made at once on the keyring, or the person already had a usable row
 *   reaching every host, which is answered rather than duplicated.
 * - `form`: the keyring's form. Nothing is written; the console shows the form pre-filled and
 *   posts the secret to `POST /api/connections`, with the same `access` (ADR 0004: the secret is
 *   typed on Graft's page alone). A link provider that could not start its link answers the form
 *   too, with `fallback` saying so (GRA-147's step-aside, with no ask to rewrite).
 * - `link`: a link provider's link, its state the short-lived record (`signConsoleLinkState`),
 *   so the return route (`provider-link.ts`) makes the connection on any replica with no row
 *   written before the provider confirms the account. ADR 0019's `start` and `complete` are
 *   unchanged.
 *
 * The new row joins the scope of every agent on `all` by being the person's (ADR 0007 as amended
 * 2026-09-19); nothing here grants it to a listed agent. `access: "full"` records, for every active
 * agent whose scope reaches the row at that moment, its build approval and its standing approval
 * for the integration's non-destructive tools, the rows the connection confirmation writes (ADR
 * 0008 as amended 2026-10-14); `ask` records nothing.
 */

export type ConnectAccess = "full" | "ask";

export type ConsoleConnectDeps = {
  connection: ConnectionDeps;
  agent: AgentDeps;
  approval: ApprovalDeps;
  /** The integration directory a `slug` is read from, as Setup's task route reads it. */
  directory: () => IntegrationDirectory;
  handoff: { secret: string };
  /** `GRAFT_AUTH_URL`, where the link's return route answers; null where none is configured. */
  authUrl: string | null;
  notifier?: Pick<ToolListChangedNotifier, "changed">;
};

/** `POST /api/connect`'s body, parsed: a directory entry by slug, or a whole proposal. */
export type ConsoleConnectInput = ({ slug: string } | { proposal: ConnectionProposalInput }) & {
  access?: ConnectAccess;
};

/** The proposal as the keyring's form pre-fills it, normalised by the same rules an agent's is. */
export type ConsoleConnectProposal = {
  vendor: string;
  displayName: string;
  scheme: AuthScheme;
  schemeConfig: Record<string, string>;
  primaryHost: string;
  hosts: string[];
  docsUrl: string | null;
};

export type ConsoleConnectResult =
  | {
      kind: "connected";
      connection: ConnectionOutput;
      /** False when the person's existing row answered (or was widened to) the integration. */
      created: boolean;
      access: ConnectAccess;
      /** The agents `full` recorded approvals for; empty under `ask`. */
      approvedAgentIds: string[];
    }
  | {
      kind: "form";
      /** The form's provider: the keyring, today the one provider that connects with a form. */
      provider: string;
      schemes: AuthScheme[];
      proposal: ConsoleConnectProposal;
      access: ConnectAccess;
      /** A link provider that could not start its sign-in and stepped aside to this form. */
      fallback: { provider: string; message: string } | null;
    }
  | {
      kind: "link";
      /** The record's id: the console's `/link/callback` carries it back as `connectId`. */
      connectId: string;
      url: string;
      expiresAt: Date;
      provider: string;
      access: ConnectAccess;
    };

/** The proposal a `slug` or a `proposal` names, read again from the directory for a slug. */
async function proposalOf(
  input: ConsoleConnectInput,
  deps: ConsoleConnectDeps,
): Promise<ConnectionProposalInput> {
  if ("proposal" in input) return input.proposal;
  const entry = await deps.directory().get(input.slug);
  if (!entry) throw new ServiceError("NOT_FOUND", "The directory has no such integration");
  // A starter found through the directory is proposed as the starter is, its scheme's parameters
  // included, as Setup's task route does; any other entry from its own fields.
  const starterId = withStarter(entry).starterId;
  const starter = starterId ? starterVendorOf(starterId) : null;
  return starter ? starterProposal(starter) : directoryProposal(entry);
}

export async function connectFromConsole(
  ctx: ServiceContext,
  principal: Principal,
  input: ConsoleConnectInput,
  deps: ConsoleConnectDeps,
): Promise<ConsoleConnectResult> {
  const access = input.access ?? "ask";
  const verdict = normaliseProposal(await proposalOf(input, deps));
  if (!verdict.ok) {
    throw new ServiceError("BAD_REQUEST", verdict.message, {
      details: { ...verdict.details, reason: verdict.reason },
    });
  }
  const { note: _note, ...proposal } = verdict.payload;
  const provider = await providerFor(
    deps.connection.providers,
    proposal.vendor,
    proposal.hosts,
    proposal.scheme,
  );

  if (provider.connect.kind === "none") {
    return connectWithNoStep(ctx, principal, provider, proposal, access, deps);
  }
  if (provider.connect.kind === "form") {
    if (proposal.scheme === "none") {
      return connectKeyless(ctx, principal, provider, proposal, access, deps);
    }
    return {
      kind: "form",
      provider: provider.name,
      schemes: [...provider.connect.schemes],
      proposal,
      access,
      fallback: null,
    };
  }
  return startConsoleLink(principal, provider, proposal, access, deps);
}

/**
 * A row made (or found) at once, its approvals in the same transaction and the agents reaching it
 * told after the commit, as `connected.ts` says the maker must. The find-or-make runs under the
 * person's lock on the provider and vendor (Greptile on #238): neither row kind has a uniqueness
 * the database could hold, so two connects at once would otherwise both find nothing and insert.
 */
async function connected(
  ctx: ServiceContext,
  principal: Principal,
  access: ConnectAccess,
  deps: ConsoleConnectDeps,
  key: { provider: string; vendor: string },
  make: (scoped: ServiceContext) => Promise<{ connection: ConnectionOutput; created: boolean }>,
): Promise<ConsoleConnectResult> {
  const result = await ctx.db.transaction(async (tx) => {
    const scoped: ServiceContext = { db: tx };
    await deps.connection.lockConnectionKey(
      tx,
      principal.personId,
      `${key.provider}:${key.vendor}`,
    );
    const made = await make(scoped);
    const approvedAgentIds =
      access === "full" ? await recordFullAccess(scoped, principal, made.connection, deps) : [];
    return { ...made, approvedAgentIds };
  });
  await notifyAgentsReachingConnection(
    ctx,
    principal,
    result.connection.id,
    { connection: deps.connection },
    deps.notifier,
  );
  return { kind: "connected", access, ...result };
}

/**
 * A keyless integration on the keyring: the row at once, with nothing to type. A usable keyless
 * keyring row of the vendor already reaching every host answers instead, and one reaching fewer is
 * widened to the union rather than doubled (GRA-167's rule, here with the person choosing).
 */
async function connectKeyless(
  ctx: ServiceContext,
  principal: Principal,
  provider: ConnectionProvider,
  proposal: ConsoleConnectProposal,
  access: ConnectAccess,
  deps: ConsoleConnectDeps,
): Promise<ConsoleConnectResult> {
  const key = { provider: provider.name, vendor: proposal.vendor };
  return connected(ctx, principal, access, deps, key, async (scoped) => {
    const keyless = (await listConnections(scoped, principal, deps.connection)).filter(
      (row) =>
        row.vendor === proposal.vendor &&
        row.provider === KEYRING_PROVIDER &&
        row.scheme === "none" &&
        isConnectionUsable(row, deps.connection.providers),
    );
    const whole = keyless.find((row) => coversProposal(row, proposal));
    if (whole) return { connection: whole, created: false };
    const [narrower] = keyless;
    if (narrower) {
      const widened = await widenKeylessConnectionHosts(
        scoped,
        principal,
        narrower.id,
        [...new Set([...narrower.hosts, ...proposal.hosts])],
        deps.connection,
      );
      return { connection: widened, created: false };
    }
    const connection = await registerConnectionWithCredential(
      scoped,
      principal,
      {
        provider: provider.name,
        vendor: proposal.vendor,
        displayName: proposal.displayName,
        scheme: proposal.scheme,
        schemeConfig: proposal.schemeConfig,
        primaryHost: proposal.primaryHost,
        hosts: proposal.hosts,
        credential: {},
      },
      deps.connection,
    );
    return { connection, created: true };
  });
}

/**
 * A provider with no person step (the gateway, GRA-58): the rules `request_connection`'s
 * `connectWithoutPersonStep` applies to an agent, less the scope, which is not this route's to
 * judge. The person's rows of the vendor are the candidates, whatever primary host they spell, and
 * host coverage decides (Greptile on #238): a live row reaching every host answers, a narrower one
 * of the provider's is widened, and with none live a revoked one of the provider's is refused
 * naming the Reconnect that brings it back.
 */
async function connectWithNoStep(
  ctx: ServiceContext,
  principal: Principal,
  provider: ConnectionProvider,
  proposal: ConsoleConnectProposal,
  access: ConnectAccess,
  deps: ConsoleConnectDeps,
): Promise<ConsoleConnectResult> {
  const key = { provider: provider.name, vendor: proposal.vendor };
  return connected(ctx, principal, access, deps, key, async (scoped) => {
    const rows = (await listConnections(scoped, principal, deps.connection)).filter(
      (row) => row.vendor === proposal.vendor,
    );
    const live = rows.filter(
      (row) => row.revokedAt === null && isConnectionUsable(row, deps.connection.providers),
    );
    const whole = live.find((row) => coversProposal(row, proposal));
    if (whole) return { connection: whole, created: false };
    const narrower = live.find((row) => row.provider === provider.name);
    if (narrower) {
      const widened = await widenProviderConnectionHosts(
        scoped,
        principal,
        provider,
        narrower.id,
        proposal.hosts,
        deps.connection,
      );
      return { connection: widened, created: false };
    }
    const revoked = rows.find((row) => row.provider === provider.name && row.revokedAt !== null);
    if (revoked) {
      throw new ServiceError(
        "CONFLICT",
        `${proposal.displayName} was connected through ${providerDisplayName(provider.name)} and revoked. Reconnect it on its connection instead.`,
        { details: { reason: "connection_revoked", connectionId: revoked.id } },
      );
    }
    const connection = await registerProviderConnection(
      scoped,
      principal,
      provider,
      {
        vendor: proposal.vendor,
        displayName: proposal.displayName,
        primaryHost: proposal.primaryHost,
        hosts: proposal.hosts,
      },
      deps.connection,
    );
    return { connection, created: true };
  });
}

/**
 * A link provider's start keyed by the short-lived record the signed state is. A provider that
 * cannot start steps aside to the keyring's form, as GRA-147 does for an ask: one stable sentence,
 * never the provider's own words.
 */
async function startConsoleLink(
  principal: Principal,
  provider: ConnectionProvider,
  proposal: ConsoleConnectProposal,
  access: ConnectAccess,
  deps: ConsoleConnectDeps,
): Promise<ConsoleConnectResult> {
  const link = providerLinkOf(provider);
  if (!link) throw new Error(`The ${provider.name} provider has no link`);
  if (!deps.authUrl) {
    throw new ServiceError(
      "BAD_REQUEST",
      "This server has no public URL configured, so a provider's link cannot be started",
    );
  }
  const now = deps.connection.now();
  const expiresAt = new Date(now.getTime() + LINK_STATE_TTL_MS);
  const record: ConsoleLinkStatePayload = {
    connectId: deps.connection.newId(),
    personId: principal.personId,
    provider: provider.name,
    vendor: proposal.vendor,
    displayName: proposal.displayName,
    primaryHost: proposal.primaryHost,
    hosts: proposal.hosts,
    access,
    expiresAt: expiresAt.getTime(),
  };
  const state = signConsoleLinkState(record, deps.handoff.secret);
  const authUrl = deps.authUrl;
  const returnTo = (outcome: "success" | "error") => {
    const url = new URL(linkCallbackUri(authUrl));
    url.searchParams.set(LINK_STATE_PARAM, state);
    url.searchParams.set(LINK_OUTCOME_PARAM, outcome);
    return url.toString();
  };
  let started: Awaited<ReturnType<typeof link.start>>;
  try {
    started = await link.start({
      personId: principal.personId,
      vendor: proposal.vendor,
      hosts: proposal.hosts,
      returnTo: { success: returnTo("success"), error: returnTo("error") },
    });
  } catch {
    const keyring = providerNamed(deps.connection.providers, KEYRING_PROVIDER);
    if (!keyring || keyring.connect.kind !== "form") throw new Error("The keyring is missing");
    return {
      kind: "form",
      provider: keyring.name,
      schemes: [...keyring.connect.schemes],
      proposal,
      access,
      fallback: {
        provider: provider.name,
        message: `${providerDisplayName(provider.name)} could not start its sign-in, so connect ${proposal.displayName} on Graft's own page instead.`,
      },
    };
  }
  return {
    kind: "link",
    connectId: record.connectId,
    url: started.url,
    expiresAt: started.expiresAt.getTime() < expiresAt.getTime() ? started.expiresAt : expiresAt,
    provider: provider.name,
    access,
  };
}

/**
 * `access: "full"` (ADR 0008 as amended 2026-10-14): for every active agent of the person's whose
 * scope reaches the connection now, its build approval for the connection and its standing
 * approval for the integration's tools, destructive ones left out, through the two writes the
 * connection confirmation makes. An agent that gains the connection later asks. Answers the ids.
 *
 * The row is read under the lock a revoke takes (`findConnectionForUpdate`) and refused when it is
 * revoked or gone (Greptile on #238): a revoke landing between the find and these writes sweeps
 * the approvals, and writing them after would hand them back on a Reconnect. Called inside the
 * caller's transaction, so the lock holds until the approvals commit.
 */
export async function recordFullAccess(
  ctx: ServiceContext,
  principal: Principal,
  connection: Pick<ConnectionOutput, "id" | "vendor">,
  deps: Pick<ConsoleConnectDeps, "agent" | "approval" | "connection">,
): Promise<string[]> {
  const locked = await deps.connection.findConnectionForUpdate(
    ctx.db,
    principal.personId,
    connection.id,
  );
  if (!locked || locked.revokedAt) {
    throw new ServiceError(
      "CONFLICT",
      "This connection was revoked while it was being connected, so no access was recorded",
      { details: { reason: "connection_revoked", connectionId: connection.id } },
    );
  }
  const agents = (await listAgents(ctx, principal, deps.agent)).filter((agent) => !agent.revokedAt);
  const approved: string[] = [];
  for (const agent of agents) {
    const scope = { personId: principal.personId, agentId: agent.id };
    if (!(await getAgentScope(ctx, scope, deps.agent)).includes(connection.id)) continue;
    await grantBuildApproval(ctx, scope, connection.id, deps.approval);
    await allowVendorWhenConnecting(ctx, scope, connection.vendor, deps.approval);
    approved.push(agent.id);
  }
  return approved;
}

/**
 * The console connect's return (`provider-link.ts`'s callback, for a state `signConsoleLinkState`
 * signed): the provider is asked what the person connected, never its redirect's say-so, as for
 * an ask; then the row and, under `full`, the approvals in one transaction. A landing repeated
 * (a refresh, a second tab) finds the row the first made and says so, before asking the provider.
 */
export async function completeConsoleLink(
  ctx: ServiceContext,
  record: ConsoleLinkStatePayload,
  outcomeWord: string | undefined,
  deps: Pick<ConsoleConnectDeps, "connection" | "agent" | "approval" | "notifier">,
): Promise<LinkCallbackOutcome> {
  const principal: Principal = { personId: record.personId };
  const outcome = (
    status: LinkCallbackOutcome["status"],
    message: string,
    connectionId: string | null = null,
  ): LinkCallbackOutcome => ({
    status,
    pendingActionId: null,
    connectionId,
    message,
    connectId: record.connectId,
  });
  const provider = providerNamed(deps.connection.providers, record.provider);
  const link = provider ? providerLinkOf(provider) : null;
  if (!provider || !link) {
    return outcome(
      "failed",
      `${providerDisplayName(record.provider)} is not enabled on this deployment, so nothing was connected.`,
    );
  }
  const name = providerDisplayName(provider.name);
  if (outcomeWord === "error") {
    return outcome(
      "failed",
      `${name} reported that the sign-in to ${record.displayName} did not complete, and nothing was connected. Press Connect to try again.`,
    );
  }
  // What this record already made, judged before the provider is asked again (Greptile on #238):
  // asked again, with the first account among the taken ones, a provider holding a second account
  // for the person would answer it and a refresh would connect that too. The row this link inserted
  // carries the record's id; a released row it reconnected in place keeps its own, and is the one
  // of this provider and integration made before the record was issued and touched since.
  //
  // A record that made its row is spent even once that row is revoked (Greptile on #238): landing
  // on it again would reconnect the released row to whatever account the provider holds next and
  // write the old record's access over the revoke's sweep, so it says what happened instead.
  const issuedAt = record.expiresAt - LINK_STATE_TTL_MS;
  const madeByThisLink = async (scoped: ServiceContext) =>
    (await listConnections(scoped, principal, deps.connection)).find(
      (row) =>
        row.provider === provider.name &&
        row.vendor === record.vendor &&
        (row.id === record.connectId ||
          (row.createdAt.getTime() < issuedAt && row.updatedAt.getTime() >= issuedAt)),
    ) ?? null;
  const already = (row: Pick<ConnectionOutput, "id" | "revokedAt">) =>
    row.revokedAt
      ? outcome(
          "failed",
          `This link already connected ${record.displayName}, and the connection was revoked since. Connect it again from the console.`,
        )
      : outcome(
          "connected",
          `${record.displayName} is connected through ${name}. The console updates on its own.`,
          row.id,
        );
  const before = await madeByThisLink(ctx);
  if (before) return already(before);

  const takenRefs = (await deps.connection.listConnections(ctx.db, principal.personId)).flatMap(
    (row) => (row.provider === provider.name && row.providerRef ? [row.providerRef] : []),
  );
  let completed: Awaited<ReturnType<typeof link.complete>>;
  try {
    completed = await link.complete({
      personId: principal.personId,
      vendor: record.vendor,
      hosts: record.hosts,
      takenRefs,
    });
  } catch {
    return outcome(
      "failed",
      `${name} could not be asked which account was connected, so nothing was connected. Press Connect to try again.`,
    );
  }
  if (!completed.ok) {
    const landed = await madeByThisLink(ctx);
    return landed ? already(landed) : outcome("failed", completed.message);
  }
  const ref = completed.ref;

  let made: { connection: Pick<ConnectionOutput, "id" | "revokedAt">; now: boolean };
  try {
    made = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      // Two landings of one record take turns here, and the later finds the earlier's row rather
      // than claiming the account the provider answered it; the record's id on the new row is the
      // database's guard beside the lock.
      await deps.connection.lockConnectionKey(tx, principal.personId, `link:${record.connectId}`);
      const earlier = await madeByThisLink(scoped);
      if (earlier) return { connection: earlier, now: false };
      const connection = await connectThroughProvider(
        scoped,
        principal,
        {
          provider,
          vendor: record.vendor,
          displayName: record.displayName,
          primaryHost: record.primaryHost,
          hosts: record.hosts,
          ref,
          id: record.connectId,
        },
        deps.connection,
      );
      // No agent asked, so no agent's scope is granted: the row is in every `all` agent's already.
      if (record.access === "full") await recordFullAccess(scoped, principal, connection, deps);
      return { connection, now: true };
    });
  } catch (error) {
    // Two landings claimed the same account and the database let one in.
    if (error instanceof ServiceError && error.code === "CONFLICT") {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const settled = await madeByThisLink(ctx);
        if (settled) return already(settled);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const detail =
      error instanceof ServiceError ? error.message : "the connection could not be made";
    return outcome(
      "failed",
      `${record.displayName} was connected at ${name} but not in Graft: ${detail}. Press Connect to try again.`,
    );
  }
  if (!made.now) return already(made.connection);
  const connectionId = made.connection.id;
  await notifyAgentsReachingConnection(
    ctx,
    principal,
    connectionId,
    { connection: deps.connection },
    deps.notifier,
  );
  return outcome(
    "connected",
    `${record.displayName} is connected through ${name}${completed.label ? ` as ${completed.label}` : ""}. The console updates on its own.`,
    connectionId,
  );
}
