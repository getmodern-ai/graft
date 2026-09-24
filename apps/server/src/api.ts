import type { SocialProviderName } from "@graft/auth";
import {
  type AgentDeps,
  type ApprovalDeps,
  answerPendingAction,
  type ConnectionDeps,
  createAgent,
  defaultSetupDeps,
  deletePersonModelKey,
  getAgent,
  getAgentScope,
  getConnection,
  getPendingActionForPerson,
  getPersonModelKey,
  getSetupState,
  isOAuthAuthorizationCode,
  type LedgerDeps,
  listAgents,
  listApprovals,
  listConnections,
  listOpenPendingActions,
  listTools,
  listVendorUsage,
  listWorkingSet,
  listWorkingSetChanges,
  type ModelKeyDeps,
  orNotFound,
  type PendingActionDeps,
  type Principal,
  reconnectConnection,
  registerConnection,
  registerConnectionWithCredential,
  requirePerson,
  retryProviderRelease,
  revokeAgent,
  revokeApproval,
  type ServiceContext,
  ServiceError,
  type ServiceErrorCode,
  type SessionLike,
  type SetupDeps,
  setAgentScope,
  setAskEveryCall,
  setConnectionCredential,
  setPersonModelKey,
  skipSetup,
  startSetup,
  type ToolDeps,
  updateAgentLimits,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { agentScopeMode } from "@graft/db/schema/agent";
import { setupHarness } from "@graft/db/schema/setup";
import type { UsageOutcome } from "@graft/db/schema/usage";
import type { WorkingSetPromotedBy } from "@graft/db/schema/working-set";
import {
  CONNECTION_ASK_KIND,
  CREDENTIAL_ASK_KIND,
  confirmConnectionAsk,
  HANDOFF_TOKEN_PARAM,
  type HandoffConfig,
  handoffUrl,
  notifyAgentsReachingConnection,
  openAskOfKind,
  recordApprovalAnswer,
  refuseUnlessOpen,
  revokeConnectionAndNotify,
  signHandoffToken,
  type ToolListChangedNotifier,
  verifyHandoff,
} from "@graft/mcp";
import { executeToolName } from "@graft/mcp/tool-names";
import { type Analytics, NO_ANALYTICS } from "@graft/observability";
import { AUTH_SCHEMES } from "@graft/proxy";
import { useLogger } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { trackedRoute } from "./analytics-routes";
import { createMcpConsentRoutes, type McpOAuthServerOptions } from "./mcp-oauth";
import { beginConsent, createOAuthRoutes, type OAuthOptions } from "./oauth";
import { createOriginGuard } from "./origin-guard";
import {
  createProviderLinkRoutes,
  isProviderLinkFallback,
  startProviderLink,
} from "./provider-link";
import {
  apiDoorKey,
  NO_RATE_LIMITING,
  type RateLimiting,
  rateLimit,
  signInDoorKey,
} from "./rate-limit";
import {
  createSetupPromptRoutes,
  isSetupPromptPath,
  SETUP_PROMPT_PATH,
  setupPromptCors,
} from "./setup-prompt";

/**
 * The person's JSON API — the routes the console (GRA-26) will call, a plain Hono app for now (GRA-1
 * names oRPC for later; nothing here would change but the transport). Every route resolves the
 * session and passes a `Principal` into `@graft/core`, whose services do the rest; this file holds
 * no rule of its own beyond the wire shapes.
 *
 * Errors: a `ServiceError` becomes `{ error, message, details? }` at its status; a body that fails
 * its schema is a 400 with zod's issues; anything else is a 500 with no message, because a message
 * from a dependency might carry anything.
 *
 * **Pending actions and approvals** (GRA-23; ADR 0006, ADR 0008) are the routes the console's
 * approval pages call: the open actions across the person's agents, one action by its signed
 * handoff link, the answer — which also writes the record the ask was for, the approval or, for a
 * `scope` ask (GRA-104), the scope grant, so the agent's next call proceeds whether or not it is
 * still waiting — and the standing approvals per agent, to set a tool to ask every call or back,
 * or to withdraw an answer.
 *
 * **The connection handoff's submits** (GRA-28; ADR 0006) are two more routes on a pending action,
 * apart from the generic answer because their bodies carry a secret and their work is one
 * transaction: `POST /pending-actions/:id/connection` creates the connection an agent proposed with
 * its credential and gives it to that agent alone, `POST /pending-actions/:id/credential` re-enters
 * an existing connection's. The secret travels in the request body to the vault and nowhere else —
 * never logged, never echoed, never on the action or its answer, which names the connection only.
 *
 * **An authorization-code connection has one more step** (GRA-30; ADR 0005). What the person enters
 * on the form is the client id and secret of a client they registered at the vendor; the tokens come
 * from a consent that runs in a popup. So the three routes that store a credential — `POST
 * /connections`, and the two submits above — start the consent when the scheme is
 * `oauth_authorization_code` and answer `authorizeUrl` beside the connection, and the two submits
 * leave the ask **unanswered**: the callback (`oauth.ts`) answers it with `{ connectionId }` once
 * the tokens are stored, so the waiting `request_connection` says connected when the agent can
 * actually call the vendor. `POST /connections/:id/oauth/authorize-url` starts a consent on its own
 * — the console's Connect and Reconnect — and `GET /oauth/redirect-uri` and `GET /oauth/callback`
 * are the consent's two ends.
 *
 * **A link provider's ask has a button rather than a form** (GRA-59; ADR 0019). `POST
 * /pending-actions/:id/link` mints the provider's link for the ask — a broker's Connect Link, for
 * the person's id at the broker — and the console opens it in a popup; `GET /providers/link/callback`
 * is where the provider sends the browser back, with no session and a signed state, and is what
 * makes the connection and answers the ask once the provider has confirmed the account
 * (`provider-link.ts`). No secret is entered anywhere in that flow, and none is stored.
 */

/** The slice of Better Auth the API reads — structural, so a test fakes it without a database. */
export type AuthHandle = {
  handler: (request: Request) => Promise<Response>;
  getSession: (headers: Headers) => Promise<SessionLike>;
};

/**
 * How a person may sign in at this deployment (GRA-81): email and password always, and the
 * providers the server was handed clients for, in the order the console draws them. Public, so the
 * door can paint the right buttons before anyone has a session.
 */
export type SignInMethods = { social: readonly SocialProviderName[] };

export type ApiDeps = {
  db: DbOrTx;
  agent: AgentDeps;
  connection: ConnectionDeps;
  /** The working-set history route (GRA-24) reads the changes and the toolbox they name. */
  workingSet: WorkingSetDeps;
  tool: ToolDeps;
  /** The connections page's "recent vendor calls" (GRA-26) read the ledger. */
  ledger: LedgerDeps;
  /** The pending-action and approval routes (GRA-23) read and write the ask's two records. */
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
  /** The person's own model key (GRA-31, ADR 0014) — the vault's encrypt half rides inside. */
  modelKey: ModelKeyDeps;
  /**
   * The person's Setup record (ADR 0024; GRA-204). Optional, and `defaultSetupDeps` when absent,
   * so a harness that never reaches `/setup` binds nothing; a suite that does passes fakes.
   */
  setup?: SetupDeps;
};

export type ApiOptions = {
  auth: AuthHandle;
  deps: ApiDeps;
  /** The console's origins (`GRAFT_CORS_ORIGIN`); empty means no CORS header is ever written. */
  corsOrigins: readonly string[];
  /** The sign-in providers `auth` registered (`@graft/auth`'s `socialProviders`); none when absent. */
  signInMethods?: SignInMethods;
  /**
   * The analytics seam's backing (`@graft/observability`; GRA-100) — `Backings.analytics`, the
   * no-op in the open form. The console's actions are counted here, at the API's mutation routes
   * (`analytics-routes.ts`), rather than in the browser: the console carries no analytics library
   * (ADR 0002 as amended 2026-09-19).
   */
  analytics?: Analytics;
  /** What signs and roots a handoff URL (`@graft/mcp`'s `handoff.ts`) — the console's URL and the secret. */
  handoff: Pick<HandoffConfig, "consoleUrl" | "secret">;
  /**
   * The consent's configuration (`oauth.ts`; ADR 0005): the server's origin the redirect URI is
   * built on and the vault's decrypt half the callback exchanges the code with. Optional so a harness
   * with no OAuth in it binds nothing; `index.ts` always binds it, and a route that needs it without
   * it refuses with a sentence saying so.
   */
  oauth?: OAuthOptions;
  /**
   * The MCP OAuth consent's two routes under `/mcp-oauth` (ADR 0018; `mcp-oauth.ts`): the
   * console's consent page describes the request and decides it through them, with the person's
   * session. The same options `createServer` mounts the protocol's endpoints with.
   */
  mcpOAuth?: McpOAuthServerOptions;
  /**
   * `GRAFT_AUTH_URL` — the server's own origin, on which a link provider's return route answers
   * (`provider-link.ts`; ADR 0019) and which the origin check treats as the console's in the
   * one-origin form (`origin-guard.ts`, GRA-148). Optional so a harness with no link provider
   * binds nothing; `index.ts` always binds it, and the link routes are mounted only with it.
   */
  authUrl?: string;
  /**
   * The process's `tools/list_changed` notifier (`@graft/mcp`'s `notifier.ts`), the one the MCP
   * endpoint's sessions and the sweep share, so a revoke from the console reaches a live session
   * the way a promotion does (GRA-69). Optional so a harness with no MCP endpoint binds nothing;
   * `index.ts` binds `mcp.notifier`, and without it a revoke changes the list silently.
   */
  notifier?: Pick<ToolListChangedNotifier, "changed">;
  /**
   * The rate-limit seam's backing (GRA-149; `rate-limit.ts`), for the two doors under `/api`:
   * `sign_in` over Better Auth's writes and `api` over this app's mutations. `createServer` hands
   * it down; absent, `NO_RATE_LIMITING` and every door open, which is the default in both forms.
   */
  rateLimit?: RateLimiting;
};

/**
 * A pending action as the console shows it (ADR 0006): the requesting agent named, the payload the
 * ask wrote (`@graft/mcp`'s `ToolAskPayload`, `BuildAskPayload`, `ConnectionProposalPayload`,
 * `CredentialAskPayload` or `ScopeAskPayload`), its clocks, and the signed link.
 */
export type PendingActionCard = {
  id: string;
  agentId: string;
  agent: { id: string; name: string } | null;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  answeredAt: Date | null;
  answer: Record<string, unknown> | null;
  consumedAt: Date | null;
  url: string;
};

/**
 * The person's answer to a `tool`, `build` or `scope` ask: `allow`; for a tool ask, whether it
 * should ask every call from now on (ADR 0008 as amended 2026-09-15); for a scope ask, whether the
 * agent may also build against the connection (GRA-75's choice, GRA-104's card). Absent fields
 * leave the setting where it stands and grant nothing.
 */
const answerBody = z.object({
  allow: z.boolean(),
  askEveryCall: z.boolean().optional(),
  approveBuild: z.boolean().optional(),
});
const askEveryCallBody = z.object({ on: z.boolean() });

/** The answer's wire shape, as the console posts it — the console imports this rather than writing it again. */
export type AnswerBody = z.input<typeof answerBody>;

/** How a handoff verdict lands on the wire: the reason word rides in `details`. */
const HANDOFF_REFUSAL_CODE: Record<"tampered" | "expired" | "consumed", ServiceErrorCode> = {
  tampered: "FORBIDDEN",
  expired: "GONE",
  consumed: "CONFLICT",
};

const agentBody = z.object({
  name: z.string(),
  workingSetCap: z.number().int().optional(),
  idleWindowDays: z.number().int().optional(),
  /** `all` when absent (ADR 0007 as amended 2026-09-19); `listed` takes `connectionIds`. */
  scopeMode: z.enum(agentScopeMode).optional(),
  connectionIds: z.array(z.string()).optional(),
});

const agentPatch = agentBody.omit({ connectionIds: true, scopeMode: true }).partial();

/**
 * `POST /setup/start` (ADR 0024; `startSetup` in `@graft/core` says what each field decides):
 * the harness picked, the agent to run as when the person has one or several, or the agent to mint
 * under *Advanced options*, the create dialog's body less its list. Strict at both levels, so a
 * `connectionIds` or a `scopeMode` sent beside `agent` rather than inside it is refused rather than
 * dropped, which would mint an agent on `all`: Setup's agent is narrowed on the agent page, later.
 */
const setupStartBody = z.strictObject({
  harness: z.enum(setupHarness).optional(),
  agentId: z.string().optional(),
  agent: z
    .strictObject({
      name: z.string().optional(),
      workingSetCap: z.number().int().optional(),
      idleWindowDays: z.number().int().optional(),
      scopeMode: z.enum(agentScopeMode).optional(),
    })
    .optional(),
});
/** The start's wire shape, as the console posts it. */
export type SetupStartBody = z.input<typeof setupStartBody>;

/**
 * `PUT /agents/:id/scope`: every connection, or a list — `SetAgentScopeInput` in `@graft/core`
 * says what a `listed` write with no list does. The console imports `ScopeBody` rather than
 * writing the shape again.
 */
const scopeBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("listed"), connectionIds: z.array(z.string()).optional() }),
]);
export type ScopeBody = z.input<typeof scopeBody>;

/** The scheme's secret fields as the console posts them; the service holds them to the scheme's table. */
const credentialFields = z.record(z.string(), z.unknown());

const registrationBody = z.object({
  /** Where the connection comes from (ADR 0019); the keyring when absent, and the service holds it to the enabled list. */
  provider: z.string().optional(),
  vendor: z.string(),
  displayName: z.string(),
  /** A signing scheme: a relay scheme is a provider's to write, never the form's (ADR 0019). */
  scheme: z.enum(AUTH_SCHEMES),
  schemeConfig: z.record(z.string(), z.unknown()).optional(),
  primaryHost: z.string(),
  hosts: z.array(z.string()).optional(),
});

const connectionBody = registrationBody.extend({
  /** With it, the connection is registered with its credential in one transaction (GRA-28's Add connection). */
  credential: credentialFields.optional(),
});

const credentialBody = z.object({ fields: credentialFields });

/**
 * The one choice both connection cards add to the confirmation (GRA-75; ADR 0008, amendment of
 * 2026-09-18): whether the asking agent may build against the connection. Absent reads as no, so a
 * body written before the control existed asks nothing new of the person.
 */
const approveBuildField = {
  approveBuild: z.boolean().default(false),
};

/** GRA-28's submit for a `connection` ask: the proposal as the person edited it, the secret, and the build choice. */
const connectionSubmitBody = registrationBody.extend({
  credential: credentialFields,
  ...approveBuildField,
});
/** The console's button for a link ask (GRA-59): nothing to edit, so the body is the build choice alone — or empty. */
const linkStartBody = z.object(approveBuildField);
const credentialSubmitBody = z.object({ credential: credentialFields });

/** The submit's wire shape, as the console posts it — the console imports this rather than writing it again. */
export type ConnectionSubmitBody = z.input<typeof connectionSubmitBody>;
/** The link button's wire shape, as the console posts it. */
export type LinkStartBody = z.input<typeof linkStartBody>;

const modelKeyBody = z.object({
  provider: z.string(),
  apiKey: z.string(),
  authoringModel: z.string().nullable().optional(),
  triageModel: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
});

/** Start a consent on an existing connection, answering an open ask about it when one is named. */
const authorizeUrlBody = z.object({ pendingActionId: z.string().optional() });

/** How much history one page of the console's working-set view reads; bounded so a query cannot ask for all of it. */
export const WORKING_SET_CHANGES_DEFAULT_LIMIT = 50;
export const WORKING_SET_CHANGES_MAX_LIMIT = 500;

const changesQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKING_SET_CHANGES_MAX_LIMIT)
    .default(WORKING_SET_CHANGES_DEFAULT_LIMIT),
});

/**
 * One line of an agent's working-set history as the console reads it (GRA-1, user story 21): what
 * changed, why (`agent` and `publish` from the agent; `idle` and `cap` from ADR 0009's rule;
 * `revoke` from a connection's revoke, ADR 0009 as amended 2026-09-18), when, and the tool by
 * vendor and name rather than by id alone, so the view
 * needs no second request to say which tool it was. `tool` is null only for a change whose tool row
 * is gone, which the schema's cascade prevents; the field is nullable so the console never assumes.
 */
export type WorkingSetChangeOutput = {
  id: string;
  change: "promote" | "demote";
  cause: "agent" | "publish" | "idle" | "cap" | "revoke";
  createdAt: Date;
  tool: { id: string; vendor: string; name: string; description: string } | null;
};

/**
 * A toolbox row as the console reads it (GRA-26): the pointer and the annotations the check derived
 * (ADR 0008), never the code — Postgres holds no code, and the console shows none. `defaultConnectionId`
 * is how the connections page finds the tools a revoked connection leaves behind (ADR 0007), and
 * `vendor` how it finds them when the row's default was cleared.
 */
export type ToolOutput = {
  id: string;
  vendor: string;
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  defaultConnectionId: string | null;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toToolOutput(row: AuthoredToolRow): ToolOutput {
  return {
    id: row.id,
    vendor: row.vendor,
    name: row.name,
    description: row.description,
    readOnly: row.readOnly,
    destructive: row.destructive,
    defaultConnectionId: row.defaultConnectionId,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One promoted tool in an agent's working set, with the tool — the console's working-set view (ADR 0003). */
export type WorkingSetEntryOutput = {
  toolId: string;
  promotedAt: Date;
  /** Null until the first call — the contraction rule's clock (ADR 0009). */
  lastUsedAt: Date | null;
  promotedBy: WorkingSetPromotedBy;
  tool: ToolOutput;
};

/**
 * One recent call against a connection's vendor, from the ledger (GRA-26). The proxy's wide events
 * are not persisted, so this is the invocation the MCP server recorded rather than the HTTP exchange
 * the proxy saw: which tool, for which agent, how it ended, how long it took.
 */
export type ConnectionCallOutput = {
  id: string;
  agentId: string;
  agentName: string;
  /** Null for the connection's own `execute__<id>` tool, which has no toolbox row. */
  toolId: string | null;
  toolName: string;
  outcome: UsageOutcome;
  dryRun: boolean;
  latencyMs: number;
  createdAt: Date;
};

/** How many calls one page of a connection's recent vendor calls reads; bounded like the history. */
export const CONNECTION_CALLS_DEFAULT_LIMIT = 50;
export const CONNECTION_CALLS_MAX_LIMIT = 500;

const callsQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONNECTION_CALLS_MAX_LIMIT)
    .default(CONNECTION_CALLS_DEFAULT_LIMIT),
});

/**
 * Whether a `content-type` declares JSON: `application/json`, or any type whose subtype carries
 * RFC 6839's `+json` structured-syntax suffix. Parameters after the first `;` (a charset, a
 * boundary) are not part of the media type and are dropped before the comparison.
 */
export function declaresJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || /^[a-z0-9.+-]+\/[a-z0-9.-]+\+json$/.test(mediaType);
}

/**
 * The body against the route's schema. A route that once took no body (`emptyIs`) reads an empty
 * one as the value given, so an older console's bare `POST` still means what it meant.
 *
 * **A body has to declare itself JSON**, and is 415 otherwise (GRA-148). Not pedantry: a `POST`
 * with `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data` is a CORS
 * *simple request*, which a browser sends cross-site with the cookie and no preflight. Demanding
 * JSON puts every route that reads a body behind a preflight the browser will only pass for an
 * origin `cors()` names. That is the second half of what `origin-guard.ts` does, and the half
 * that works in the browser rather than in this process. The console always declares it
 * (`apps/web/src/lib/api.ts` sets the header whenever it sends a body), and Better Auth's own
 * router admits `application/json` alone for the same reason.
 *
 * The rule is on the body and not on the request, so the bare `POST` above keeps working: a
 * request with no body carries nothing to declare, and a content type would describe nothing.
 * That leaves one shape the rule does not reach, a bodyless cross-site `POST` to a route with
 * `emptyIs`, which today is `POST /pending-actions/:id/link` alone; the origin check refuses it,
 * and refusing it here too would break the one caller the `emptyIs` path exists for.
 */
async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  options: { emptyIs?: unknown } = {},
): Promise<z.infer<T>> {
  const text = await request.text();
  const empty = text.trim().length === 0;
  if (!empty && !declaresJson(request.headers.get("content-type"))) {
    throw new ServiceError(
      "UNSUPPORTED_MEDIA_TYPE",
      "This route reads a JSON body, so the request must carry `content-type: application/json`",
    );
  }
  let json: unknown;
  try {
    json = empty && "emptyIs" in options ? options.emptyIs : JSON.parse(text);
  } catch {
    throw new ServiceError("BAD_REQUEST", "The body is not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ServiceError("BAD_REQUEST", "The body does not match the route's shape", {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

export function createApi(options: ApiOptions): Hono {
  const api = new Hono();
  const ctx: ServiceContext = { db: options.deps.db };
  const {
    agent: agentDeps,
    connection: connectionDeps,
    workingSet: workingSetDeps,
    tool: toolDeps,
    ledger: ledgerDeps,
  } = options.deps;

  /**
   * The setup prompt is read from other origins with no credentials (`setup-prompt.ts`), so its path
   * takes the open policy and the console's credentialed one skips it: two `cors()` on one request
   * would each write `Access-Control-Allow-Origin`, and a preflight would be answered by the first.
   */
  api.use(SETUP_PROMPT_PATH, setupPromptCors);
  if (options.corsOrigins.length > 0) {
    const consoleCors = cors({ origin: [...options.corsOrigins], credentials: true });
    api.use("*", (c, next) => (isSetupPromptPath(c.req.path) ? next() : consoleCors(c, next)));
  }

  /**
   * Every state-changing request under `/api` names the console's origin or is refused
   * (`origin-guard.ts`, GRA-148). Above the analytics chokepoint and every route, so a refused
   * request resolves no session and counts nothing; below `cors()`, so the refusal still carries
   * the headers a listed console needs to read it.
   */
  api.use(
    "*",
    createOriginGuard({
      ...(options.authUrl === undefined ? {} : { authUrl: options.authUrl }),
      corsOrigins: options.corsOrigins,
    }),
  );

  /**
   * The two rate-limited doors under `/api` (GRA-149), below the origin guard so a refused origin
   * counts nothing, and above every route of this app because Hono
   * runs middleware in registration order: Better Auth's writes keyed by the caller's address,
   * and this app's own mutations keyed by the person whose session made them. Unlimited by
   * default in both forms, in which case neither reads a header or resolves a session
   * (`rate-limit.ts`).
   */
  const rateLimiting = options.rateLimit ?? NO_RATE_LIMITING;
  api.use("/auth/*", rateLimit(rateLimiting.limiter, "sign_in", signInDoorKey(rateLimiting)));
  api.use("*", rateLimit(rateLimiting.limiter, "api", apiDoorKey(options.auth.getSession)));

  /**
   * The console's product events, one chokepoint (GRA-100): after a tracked mutation has answered
   * 2xx, `analytics-routes.ts` names the event and the person it happened to is the session's. The
   * session is resolved again here — one more read on a handful of rare mutations — rather than
   * threaded out of every handler, so no route knows analytics exists; a session that cannot be
   * resolved counts nothing, since without a person there is no profile to file it on.
   */
  const analytics = options.analytics ?? NO_ANALYTICS;
  api.use("*", async (c, next) => {
    await next();
    if (analytics === NO_ANALYTICS || c.res.status >= 300) return;
    const route = trackedRoute(c.req.method, c.req.path);
    if (!route) return;
    const session = await options.auth.getSession(c.req.raw.headers).catch(() => null);
    const personId = session?.user.id;
    if (!personId) return;
    // A row that reads its answer reads a clone, so the body the console receives is untouched.
    const answer = route.properties
      ? await c.res
          .clone()
          .json()
          .catch(() => null)
      : null;
    analytics.capture({
      distinctId: personId,
      event: route.event,
      properties: { via: "console", ...(route.properties ? route.properties(answer) : {}) },
    });
  });

  api.onError((error, c) => {
    if (error instanceof ServiceError) {
      // A refusal the route meant — a consumed handoff link's 409, a tampered one's 403 — is the
      // request's answer, not its failure. Hono has already put the throw on `c.error`, which is
      // what evlog's middleware logs as the event's error, stack and all, at `error` level; clearing
      // it leaves an `info` event at the status, with the refusal readable under `refusal` (GRA-164).
      // An error that is not a `ServiceError` keeps the stack: that one is ours to read.
      useLogger().set({ refusal: { code: error.code, message: error.message } });
      c.error = undefined;
      return c.json(
        {
          error: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status as 400,
      );
    }
    console.error("api error", error);
    return c.json({ error: "INTERNAL", message: "Something went wrong" }, 500);
  });

  /**
   * Liveness, for the compose file's health check and a load balancer's (GRA-33, GRA-34): the
   * process is up and answering. Deliberately nothing about the database — the boot migrated it
   * before this route could answer, and a probe that queried it would turn a database hiccup into
   * a restart loop of a server that would have recovered on its own.
   */
  api.get("/health", (c) => c.json({ ok: true }));

  /** Better Auth's own routes: sign-up, sign-in, sign-out, session, and each provider's callback. */
  api.on(["POST", "GET"], "/auth/*", (c) => options.auth.handler(c.req.raw));

  /**
   * Which providers the door may offer, without a session: the names alone, never a client id,
   * so a self-host with no client configured shows the email form and nothing that cannot work.
   */
  const signInMethods: SignInMethods = { social: options.signInMethods?.social ?? [] };
  api.get("/sign-in-methods", (c) => c.json(signInMethods));

  /**
   * The generic setup prompt per harness, for the marketing site and the docs (GRA-205). A read
   * with no session: the origin check exempts every read, so it does not apply here, and nothing
   * here reads a cookie. Mounted only with `authUrl`, which names the MCP URL the prompt carries.
   */
  if (options.authUrl) {
    api.route(
      SETUP_PROMPT_PATH,
      createSetupPromptRoutes({ authUrl: options.authUrl, consoleUrl: options.handoff.consoleUrl }),
    );
  }

  const {
    approval: approvalDeps,
    pendingAction: pendingActionDeps,
    modelKey: modelKeyDeps,
  } = options.deps;
  const { handoff } = options;

  const principalOf = async (headers: Headers) =>
    requirePerson(await options.auth.getSession(headers));

  /** What `beginConsent` needs; a harness that bound no `oauth` cannot start one and is told so. */
  const oauthOptions = () => {
    if (!options.oauth) {
      throw new ServiceError(
        "BAD_REQUEST",
        "This server has no OAuth configuration, so a consent cannot be started",
      );
    }
    return { connection: connectionDeps, handoff, oauth: options.oauth };
  };

  /**
   * An authorization-code connection's next step once its client secret is stored: the consent,
   * started here so the route's answer carries the authorize URL (ADR 0005). Null for every other
   * scheme, whose credential is complete as entered.
   */
  const consentFor = async (
    scoped: ServiceContext,
    principal: Principal,
    connectionId: string,
    scheme: string,
    pendingActionId: string | null,
  ) =>
    isOAuthAuthorizationCode(scheme)
      ? beginConsent(scoped, principal, connectionId, pendingActionId, oauthOptions())
      : null;

  if (options.mcpOAuth) {
    api.route(
      "/mcp-oauth",
      createMcpConsentRoutes({ ...options.mcpOAuth, getSession: options.auth.getSession }),
    );
  }

  if (options.oauth) {
    api.route(
      "/oauth",
      createOAuthRoutes({
        db: options.deps.db,
        connection: connectionDeps,
        pendingAction: pendingActionDeps,
        getSession: options.auth.getSession,
        handoff,
        oauth: options.oauth,
        notifier: options.notifier,
      }),
    );
  }

  /** What the link's two ends need (`provider-link.ts`); a harness that bound no `authUrl` has neither. */
  const linkOptions = () => {
    if (!options.authUrl) {
      throw new ServiceError(
        "BAD_REQUEST",
        "This server has no public URL configured, so a provider's link cannot be started",
      );
    }
    return {
      db: options.deps.db,
      connection: connectionDeps,
      agent: agentDeps,
      pendingAction: pendingActionDeps,
      approval: approvalDeps,
      handoff,
      authUrl: options.authUrl,
      notifier: options.notifier,
      analytics: options.analytics,
    };
  };

  if (options.authUrl) {
    api.route("/providers/link", createProviderLinkRoutes(linkOptions()));
  }

  /** `?agentId=` on the approval routes — an approval is per agent, and the path names the tool. */
  const agentIdOf = (query: string | undefined): string => {
    if (!query) throw new ServiceError("BAD_REQUEST", "agentId is required as a query parameter");
    return query;
  };

  const card = async (row: PendingActionRow, principal: Principal): Promise<PendingActionCard> => {
    const agent = await getAgent(ctx, principal, row.agentId, agentDeps);
    return {
      id: row.id,
      agentId: row.agentId,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      kind: row.kind,
      payload: row.payload,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      answeredAt: row.answeredAt,
      answer: row.answer,
      consumedAt: row.consumedAt,
      url: handoffUrl(handoff.consoleUrl, row.id, signHandoffToken(row, handoff.secret)),
    };
  };

  api.get("/me", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ personId: principal.personId });
  });

  /**
   * The person's own model key (ADR 0014: bring your own key to the hosted form). Three routes on
   * one resource, because there is one row per person: read what is set — provider, model ids,
   * base URL, when — enter or replace it, remove it. The key itself goes in over TLS and comes out
   * of the vault only in the model resolver that runs this person's jobs (`model.ts`); no answer
   * here carries it, and the console shows "set at" in its place.
   */
  api.get("/me/model-key", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ modelKey: await getPersonModelKey(ctx, principal, modelKeyDeps) });
  });

  api.put("/me/model-key", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, modelKeyBody);
    return c.json({ modelKey: await setPersonModelKey(ctx, principal, body, modelKeyDeps) });
  });

  api.delete("/me/model-key", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ deleted: await deletePersonModelKey(ctx, principal, modelKeyDeps) });
  });

  /**
   * **Setup** (ADR 0024; GRA-204): the person's guided first run, one record per person. `GET`
   * answers `SetupState` — the record, the step the person is on, the show rule's verdict the
   * console's shell redirects on, the agent it runs as and the person's active agents. `start`
   * mints or adopts the agent and moves the record to the vendor step; `skip` marks it skipped. Both
   * answer the state as it now stands, and both are rows in `analytics-routes.ts` carrying the
   * harness. Later steps are GRA-206's and GRA-208's, on the same record.
   */
  const setupDeps = options.deps.setup ?? defaultSetupDeps;

  api.get("/setup", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json(await getSetupState(ctx, principal, setupDeps, agentDeps));
  });

  api.post("/setup/start", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, setupStartBody);
    return c.json(await startSetup(ctx, principal, body, setupDeps, agentDeps));
  });

  api.post("/setup/skip", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    await parseBody(c.req.raw, z.object({}), { emptyIs: {} });
    return c.json(await skipSetup(ctx, principal, setupDeps, agentDeps));
  });

  api.get("/agents", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ agents: await listAgents(ctx, principal, agentDeps) });
  });

  api.post("/agents", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, agentBody);
    // The token is in this answer and nowhere else; every later read shows the prefix alone.
    return c.json(await createAgent(ctx, principal, body, agentDeps), 201);
  });

  api.get("/agents/:id", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const agentId = c.req.param("id");
    const agent = orNotFound(await getAgent(ctx, principal, agentId, agentDeps), "Agent not found");
    const connectionIds = await getAgentScope(
      ctx,
      { personId: principal.personId, agentId: agent.id },
      agentDeps,
    );
    return c.json({ agent, connectionIds });
  });

  api.patch("/agents/:id", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, agentPatch);
    const agent = orNotFound(
      await updateAgentLimits(ctx, principal, c.req.param("id"), body, agentDeps),
      "Agent not found",
    );
    return c.json({ agent });
  });

  api.post("/agents/:id/revoke", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const agent = orNotFound(
      await revokeAgent(ctx, principal, c.req.param("id"), agentDeps),
      "Agent not found, or already revoked",
    );
    return c.json({ agent });
  });

  /**
   * The agent's working set as the harness sees it (ADR 0003): every promoted tool with the row that
   * describes it. A revoked agent's set still answers, for the same reason its history does.
   */
  api.get("/agents/:id/working-set", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const agent = orNotFound(
      await getAgent(ctx, principal, c.req.param("id"), agentDeps),
      "Agent not found",
    );
    const entries = await listWorkingSet(
      ctx,
      { personId: principal.personId, agentId: agent.id },
      workingSetDeps,
    );
    const workingSet: WorkingSetEntryOutput[] = entries.map((entry) => ({
      toolId: entry.toolId,
      promotedAt: entry.promotedAt,
      lastUsedAt: entry.lastUsedAt,
      promotedBy: entry.promotedBy,
      tool: toToolOutput(entry.tool),
    }));
    return c.json({ workingSet });
  });

  /**
   * The agent's working-set history, newest first — every promotion and demotion with its cause
   * (ADR 0003: tool-list churn is a first-class event; ADR 0009: the rule's demotions are recorded
   * beside the agent's). A revoked agent's history still answers: the rows are the person's records.
   * `?limit=` caps the page; the tool's vendor and name are joined in from the person's toolbox.
   */
  api.get("/agents/:id/working-set/changes", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const query = changesQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ServiceError(
        "BAD_REQUEST",
        `limit must be a whole number from 1 to ${WORKING_SET_CHANGES_MAX_LIMIT}`,
        { details: { issues: query.error.issues } },
      );
    }
    const agent = orNotFound(
      await getAgent(ctx, principal, c.req.param("id"), agentDeps),
      "Agent not found",
    );
    const scope = { personId: principal.personId, agentId: agent.id };
    const [rows, tools] = await Promise.all([
      listWorkingSetChanges(ctx, scope, query.data.limit, workingSetDeps),
      listTools(ctx, principal, toolDeps),
    ]);
    const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
    const changes: WorkingSetChangeOutput[] = rows.map((row) => {
      const tool = toolsById.get(row.toolId);
      return {
        id: row.id,
        change: row.change,
        cause: row.cause,
        createdAt: row.createdAt,
        tool: tool
          ? { id: tool.id, vendor: tool.vendor, name: tool.name, description: tool.description }
          : null,
      };
    });
    return c.json({ changes });
  });

  api.put("/agents/:id/scope", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, scopeBody);
    return c.json(await setAgentScope(ctx, principal, c.req.param("id"), body, agentDeps));
  });

  /** The person's toolbox, demoted tools included — what a connection's tools are read from (ADR 0007). */
  api.get("/tools", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const tools = await listTools(ctx, principal, toolDeps);
    return c.json({ tools: tools.map(toToolOutput) });
  });

  api.get("/connections", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ connections: await listConnections(ctx, principal, connectionDeps) });
  });

  /**
   * Register a connection. With `credential` in the body the row and its ciphertext are written in
   * one transaction (GRA-28: the console's Add connection, the same form as an agent's proposal with
   * no pending action behind it); without, the row waits for `PUT /connections/:id/credential`.
   */
  /**
   * A row made or reconnected is announced to every live session whose scope reaches it — every
   * agent on `all`, and every agent whose list names it (ADR 0007 as amended 2026-09-19) — through
   * `@graft/mcp`'s `notifyAgentsReachingConnection`, as the revoke route announces the row leaving.
   * After the transaction that makes the row, so a session re-fetching on the notification reads
   * the committed row.
   */
  const announceConnection = (principal: Principal, connectionId: string) =>
    notifyAgentsReachingConnection(
      ctx,
      principal,
      connectionId,
      { connection: connectionDeps },
      options.notifier,
    );

  api.post("/connections", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const { credential, ...registration } = await parseBody(c.req.raw, connectionBody);
    if (!credential) {
      const connection = await registerConnection(ctx, principal, registration, connectionDeps);
      await announceConnection(principal, connection.id);
      return c.json({ connection }, 201);
    }
    // With a credential: the row, its ciphertext and — for an authorization-code connection — the
    // consent's start, in one transaction, so the answer carries the authorize URL to open.
    const result = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const connection = await registerConnectionWithCredential(
        scoped,
        principal,
        { ...registration, credential },
        connectionDeps,
      );
      const consent = await consentFor(scoped, principal, connection.id, connection.scheme, null);
      return consent
        ? { connection: consent.connection, authorizeUrl: consent.authorizeUrl }
        : { connection };
    });
    await announceConnection(principal, result.connection.id);
    return c.json(result, 201);
  });

  /**
   * Start — or start again — the consent of an authorization-code connection (ADR 0005): the
   * console's Connect after entering the client secret, and its Reconnect after a refused refresh.
   * Answers the authorize URL to open in a popup and until when the callback accepts it. With
   * `pendingActionId`, the consent answers that ask when it completes: the ask must be the person's,
   * open, and — for a credential re-entry — about this connection.
   */
  api.post("/connections/:id/oauth/authorize-url", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, authorizeUrlBody);
    const connectionId = c.req.param("id");
    let pendingActionId: string | null = null;
    if (body.pendingActionId) {
      const action = await openAction(ctx, principal, body.pendingActionId);
      if (action.kind !== CONNECTION_ASK_KIND && action.kind !== CREDENTIAL_ASK_KIND) {
        throw new ServiceError("BAD_REQUEST", `A ${action.kind} ask is not answered by a consent`);
      }
      if (action.kind === CREDENTIAL_ASK_KIND && action.payload.connectionId !== connectionId) {
        throw new ServiceError("BAD_REQUEST", "This ask is about another connection");
      }
      pendingActionId = action.id;
    }
    const started = await beginConsent(
      ctx,
      principal,
      connectionId,
      pendingActionId,
      oauthOptions(),
    );
    return c.json({
      authorizeUrl: started.authorizeUrl,
      expiresAt: started.expiresAt,
      connection: started.connection,
    });
  });

  api.get("/connections/:id", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const connection = orNotFound(
      await getConnection(ctx, principal, c.req.param("id"), connectionDeps),
      "Connection not found",
    );
    return c.json({ connection });
  });

  /**
   * The connection's recent vendor calls, newest first, across every agent of the person (GRA-26).
   * From the ledger, not from the proxy's wide events, which are not persisted — so a line is the
   * invocation the MCP server recorded (`ConnectionCallOutput`). A call is the connection's when its
   * tool is bound to the connection's vendor, or when it is the connection's own execute tool, whose
   * wire name carries the id (CONTEXT.md, *Tool*). `?limit=` caps the page.
   */
  api.get("/connections/:id/usage", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const query = callsQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ServiceError(
        "BAD_REQUEST",
        `limit must be a whole number from 1 to ${CONNECTION_CALLS_MAX_LIMIT}`,
        { details: { issues: query.error.issues } },
      );
    }
    const connection = orNotFound(
      await getConnection(ctx, principal, c.req.param("id"), connectionDeps),
      "Connection not found",
    );
    const rows = await listVendorUsage(
      ctx,
      principal,
      {
        vendor: connection.vendor,
        toolNames: [executeToolName(connection.id)],
        limit: query.data.limit,
      },
      ledgerDeps,
    );
    const calls: ConnectionCallOutput[] = rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      toolId: row.toolId,
      toolName: row.toolName,
      outcome: row.outcome,
      dryRun: row.dryRun,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt,
    }));
    return c.json({ calls });
  });

  /**
   * The credential's one way in (ADR 0006): the console posts the fields here over TLS, the
   * service encrypts them, and the answer is the row's public shape — `credentialSetAt` and no
   * more. The same route re-enters a rotated credential.
   */
  api.put("/connections/:id/credential", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, credentialBody);
    const id = c.req.param("id");
    // A re-entry on a revoked row is its reconnection (ADR 0007): the execute tool comes back to
    // every list whose scope reaches it, so those sessions are told; a rotation on a live row
    // changes no list and tells nobody.
    const before = await getConnection(ctx, principal, id, connectionDeps);
    const connection = await setConnectionCredential(
      ctx,
      principal,
      id,
      body.fields,
      connectionDeps,
    );
    if (before?.revokedAt) await announceConnection(principal, connection.id);
    return c.json({ connection });
  });

  /**
   * Revoke (ADR 0007), and say whether the row's provider let go of what it held outside Graft
   * (ADR 0019). The local revoke has committed by the time the provider is asked, so a release that
   * failed rides the answer and the wide event, with the connection id so an operator can find the
   * row to release by hand, and never the status: revoking again is the retry. Through
   * `@graft/mcp`'s `revokeConnectionAndNotify` rather than the service, so every live session whose
   * list the revoke changed hears `tools/list_changed` (GRA-69); the answer also names what left
   * each agent's working set (`demoted`) and which agents were told (`affectedAgentIds`).
   */
  api.post("/connections/:id/revoke", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const connectionId = c.req.param("id");
    const result = orNotFound(
      await revokeConnectionAndNotify(
        ctx,
        principal,
        connectionId,
        { connection: connectionDeps },
        options.notifier,
      ),
      "Connection not found",
    );
    useLogger().set({
      providerRelease: { connectionId, ...result.providerRelease },
      workingSetDemoted: result.demoted.length,
    });
    return c.json(result);
  });

  /**
   * Reconnect a revoked connection that holds no credential to re-enter — a provider's with no
   * person step, the gateway's (ADR 0019, GRA-58). The keyring's way back stays the credential
   * re-entry above; the service refuses the other kinds, naming theirs.
   */
  api.post("/connections/:id/reconnect", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const connection = await reconnectConnection(ctx, principal, c.req.param("id"), connectionDeps);
    await announceConnection(principal, connection.id);
    return c.json({ connection });
  });

  /**
   * The retry of a provider's release that failed on a revoke (ADR 0019; GRA-59): the card offers
   * it while the row says the account is still at the provider (`providerReleaseFailedAt`), and
   * this runs the same release, recorded the same way, so a success clears the mark and a second
   * failure keeps it. The status is the request's, never the release's, for the revoke's reason.
   */
  api.post("/connections/:id/release", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const connectionId = c.req.param("id");
    const result = await retryProviderRelease(ctx, principal, connectionId, connectionDeps);
    useLogger().set({ providerRelease: { connectionId, ...result.providerRelease } });
    return c.json(result);
  });

  /** The console's inbox: every open action across the person's agents, newest first, each with its link. */
  api.get("/pending-actions", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const rows = await listOpenPendingActions(ctx, principal, pendingActionDeps);
    return c.json({
      pendingActions: await Promise.all(rows.map((row) => card(row, principal))),
    });
  });

  /**
   * Where a handoff link lands (`<console>/pending/<id>?t=…` calls this with the same `t`). The
   * token is verified against the row — tampered 403, already used 409, expired 410, each naming
   * its reason in `details` — and the session must be the owning person's too: the link is a
   * pointer the person carries, never a credential (ADR 0006).
   */
  api.get("/pending-actions/:id", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const row = orNotFound(
      await getPendingActionForPerson(ctx, principal, c.req.param("id"), pendingActionDeps),
      "Pending action not found",
    );
    const verdict = verifyHandoff({
      token: c.req.query(HANDOFF_TOKEN_PARAM),
      subject: row,
      secret: handoff.secret,
      now: pendingActionDeps.now(),
    });
    if (!verdict.ok) {
      throw new ServiceError(HANDOFF_REFUSAL_CODE[verdict.reason], verdict.message, {
        details: { reason: verdict.reason },
      });
    }
    return c.json({ pendingAction: await card(row, principal) });
  });

  /**
   * The person's answer, `{ allow, askEveryCall? }`. Recording the answer and writing the approval
   * it is for happen in one transaction: for a `tool` ask the answer becomes the standing `approval`
   * row (`allow` or `deny` — a no holds too, ADR 0008), and `askEveryCall` with an allow sets the
   * tool's per-call opt-in on or off, absent leaving it as it stands (ADR 0008, amendment of
   * 2026-09-15); for a `build` ask an `allow` grants the build approval and a decline writes nothing,
   * so the next `acquire` asks again; for a `scope` ask (GRA-104) an `allow` adds the connection
   * the person already holds to the asking agent's scope — the write `PUT /agents/:id/scope`
   * makes, one connection at a time — and, with `approveBuild`, grants the build approval for it
   * (GRA-75), in the answer's transaction, while a decline writes nothing.
   *
   * **An answer the standing row now carries in full is consumed here.** Otherwise it would outlive
   * the row: a yes left answered-but-unconsumed would still be found and honoured by a call made
   * after the approval was withdrawn, which is exactly what withdrawing is meant to prevent. The
   * answers the agent's next call must read for itself stay unconsumed — a yes on a tool set to ask
   * every call (the row says allow and the rule still says ask, so this call's yes is the action's),
   * a build decline (no row records it), and a scope ask's answer either way (the waiting
   * `request_connection` reads it to answer connected or declined). A call that is waiting sees a
   * consumed action as `CONFLICT` and reads the rule again (`@graft/mcp`'s `approval.ts`), which is
   * how it proceeds on a yes and refuses on a no.
   */
  api.post("/pending-actions/:id/answer", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, answerBody);
    // The record is `@graft/mcp`'s `recordApprovalAnswer` (GRA-84): the same writes the ask
    // card's `answer_ask` makes, so the two doors cannot record two different things.
    const result = await recordApprovalAnswer(
      ctx,
      principal,
      c.req.param("id"),
      {
        allow: body.allow,
        ...(body.askEveryCall === undefined ? {} : { askEveryCall: body.askEveryCall }),
        ...(body.approveBuild === undefined ? {} : { approveBuild: body.approveBuild }),
      },
      {
        approval: approvalDeps,
        pendingAction: pendingActionDeps,
        connection: connectionDeps,
        agent: agentDeps,
      },
    );
    return c.json(result);
  });

  /**
   * The action a submit route is for: the person's, of the kind the route serves, unanswered and in
   * time — refused with the answer route's codes (409 answered or taken, 410 expired) before anything
   * is written (`@graft/mcp`'s `openAskOfKind`; `refuseUnlessOpen` for a route that takes two kinds).
   */
  const openAction = async (
    scoped: ServiceContext,
    principal: Principal,
    id: string,
  ): Promise<PendingActionRow> =>
    refuseUnlessOpen(
      orNotFound(
        await getPendingActionForPerson(scoped, principal, id, pendingActionDeps),
        "Pending action not found",
      ),
      pendingActionDeps.now(),
    );

  /**
   * The person's submit for a `connection` ask (GRA-28; ADR 0006): the proposal as they edited it
   * becomes a connection with its credential written once through the vault's encrypt half, the
   * connection joins the requesting agent's scope and no other agent's (ADR 0007), and the action's
   * answer records `{ connectionId }` and nothing of the credential — one transaction, so a refused
   * host or a mistyped field leaves no row, no scope change and no answer. The waiting
   * `request_connection` call takes the answer and says connected; a proposed host that is not
   * public is refused here as `host_not_public`, as it was to the agent and as the form said.
   *
   * With `approveBuild` the same transaction records the asking agent's build approval for the new
   * connection (GRA-75; ADR 0008, amendment of 2026-09-18) — the yes `acquire`'s own ask would
   * take, given one page earlier by the same person about the same agent and connection — so the
   * next `acquire` finds it standing and asks nothing. In the transaction, so a refused connection
   * leaves no approval and a recorded approval never lacks its connection.
   */
  api.post("/pending-actions/:id/connection", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, connectionSubmitBody);
    // The record is `@graft/mcp`'s `confirmConnectionAsk` (GRA-84), shared with the ask card's
    // `answer_ask` for a keyless proposal; the consent hook is this server's alone (ADR 0005), since
    // a scheme with a client secret is never the card's to answer.
    const result = await confirmConnectionAsk(
      ctx,
      principal,
      c.req.param("id"),
      body,
      {
        connection: connectionDeps,
        agent: agentDeps,
        approval: approvalDeps,
        pendingAction: pendingActionDeps,
      },
      { consent: consentFor },
    );
    await announceConnection(principal, result.connection.id);
    return c.json(result, 201);
  });

  /**
   * The person's button for a `connection` ask a **link** provider covers (GRA-59; ADR 0019): the
   * provider mints the link the console opens in a popup, for this person, with this server's
   * return route as where the provider sends the browser back. The ask stays open — the return
   * route answers it once the provider has confirmed the account (`provider-link.ts`) — so a popup
   * closed half-way leaves the button where it was. The body is the build choice alone
   * (GRA-75) — everything else the link needs is on the ask, and nothing about it is the person's
   * to edit; an empty body is the choice left off. The choice rides the signed state to the return
   * route, which records it with the connection it makes (`provider-link.ts`).
   */
  api.post("/pending-actions/:id/link", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, linkStartBody, { emptyIs: {} });
    const started = await startProviderLink(ctx, principal, c.req.param("id"), linkOptions(), {
      approveBuild: body.approveBuild,
    });
    // Counted here rather than in the route table (GRA-147): the same 200 is a link minted or a
    // provider that stepped aside, and the two are different facts about the provider.
    (options.analytics ?? NO_ANALYTICS).capture({
      distinctId: principal.personId,
      event: isProviderLinkFallback(started) ? "provider_link_fell_back" : "provider_link_started",
      properties: { provider: started.provider, via: "console" },
    });
    return c.json(started);
  });

  /**
   * The person's submit for a `credential` ask (GRA-28): the connection the ask names gets the new
   * credential, the answer records the connection, and no approval is touched — the credential
   * changing is not a reason for a tool to ask again (ADR 0008). A revoked connection is reconnected
   * by it (ADR 0007; the repo clears `revoked_at` with the ciphertext).
   */
  api.post("/pending-actions/:id/credential", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, credentialSubmitBody);
    const id = c.req.param("id");
    const result = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const action = await openAskOfKind(
        scoped,
        principal,
        id,
        CREDENTIAL_ASK_KIND,
        pendingActionDeps,
      );
      const connectionId = action.payload.connectionId;
      if (typeof connectionId !== "string") {
        throw new ServiceError("BAD_REQUEST", "This credential ask names no connection");
      }
      // Whether this re-entry is a reconnection (the route above says why it matters).
      const before = await getConnection(scoped, principal, connectionId, connectionDeps);
      const connection = await setConnectionCredential(
        scoped,
        principal,
        connectionId,
        body.credential,
        connectionDeps,
      );
      // A re-entered client secret is followed by a consent, and the callback answers the ask.
      const consent = await consentFor(
        scoped,
        principal,
        connection.id,
        connection.scheme,
        action.id,
      );
      if (consent) {
        return {
          connection: consent.connection,
          pendingAction: action,
          authorizeUrl: consent.authorizeUrl,
        };
      }
      const pendingAction = await answerPendingAction(
        scoped,
        principal,
        action.id,
        { connectionId },
        pendingActionDeps,
      );
      return { connection, pendingAction, reconnected: before?.revokedAt !== null };
    });
    const { reconnected, ...answer } = result;
    if (reconnected) await announceConnection(principal, answer.connection.id);
    return c.json(answer);
  });

  /** One agent's standing approvals — what the console lists to set how a tool asks, or withdraw. */
  api.get("/approvals", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const scope = { personId: principal.personId, agentId: agentIdOf(c.req.query("agentId")) };
    return c.json({ approvals: await listApprovals(ctx, scope, approvalDeps) });
  });

  /**
   * Set a tool's ask-every-call opt-in on or off for one agent, `{ on }` (ADR 0008, amendment of
   * 2026-09-15). A `PUT` because the body is the whole setting and a repeat changes nothing. 400 for
   * a read-only tool, which never asks; 404 when no approval stands to carry the setting.
   */
  api.put("/approvals/:toolId/ask-every-call", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, askEveryCallBody);
    const scope = { personId: principal.personId, agentId: agentIdOf(c.req.query("agentId")) };
    return c.json({
      approval: await setAskEveryCall(ctx, scope, c.req.param("toolId"), body.on, approvalDeps),
    });
  });

  /** Withdraw one agent's answer for one tool; the tool asks again on its next call. */
  api.delete("/approvals/:toolId", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const scope = { personId: principal.personId, agentId: agentIdOf(c.req.query("agentId")) };
    const approval = orNotFound(
      await revokeApproval(ctx, scope, c.req.param("toolId"), approvalDeps),
      "No approval stands for this tool and agent",
    );
    return c.json({ approval });
  });

  return api;
}
