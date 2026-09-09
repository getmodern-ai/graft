import {
  type AgentDeps,
  type ApprovalDeps,
  addConnectionToAgentScope,
  answerPendingAction,
  type ConnectionDeps,
  consumePendingAction,
  createAgent,
  deletePersonModelKey,
  getAgent,
  getAgentScope,
  getConnection,
  getPendingActionForPerson,
  getPersonModelKey,
  getToolById,
  grantBuildApproval,
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
  registerConnection,
  registerConnectionWithCredential,
  relaxDestructiveApproval,
  requirePerson,
  revokeAgent,
  revokeApproval,
  revokeConnection,
  type ServiceContext,
  ServiceError,
  type ServiceErrorCode,
  type SessionLike,
  setAgentScope,
  setApproval,
  setConnectionCredential,
  setPersonModelKey,
  type ToolDeps,
  updateAgentLimits,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { AuthoredToolRow } from "@graft/db/repo/tool";
import { connectionScheme } from "@graft/db/schema/connection";
import type { UsageOutcome } from "@graft/db/schema/usage";
import type { WorkingSetPromotedBy } from "@graft/db/schema/working-set";
import {
  CONNECTION_ASK_KIND,
  CREDENTIAL_ASK_KIND,
  HANDOFF_TOKEN_PARAM,
  type HandoffConfig,
  handoffUrl,
  readApprovalAnswer,
  signHandoffToken,
  verifyHandoff,
} from "@graft/mcp";
import { executeToolName } from "@graft/mcp/tool-names";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

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
 * handoff link, the answer — which also writes the approval the ask was for, so the agent's next
 * call proceeds whether or not it is still waiting — and the standing approvals per agent, to relax
 * a destructive tool's per-call ask or to withdraw an answer.
 *
 * **The connection handoff's submits** (GRA-28; ADR 0006) are two more routes on a pending action,
 * apart from the generic answer because their bodies carry a secret and their work is one
 * transaction: `POST /pending-actions/:id/connection` creates the connection an agent proposed with
 * its credential and gives it to that agent alone, `POST /pending-actions/:id/credential` re-enters
 * an existing connection's. The secret travels in the request body to the vault and nowhere else —
 * never logged, never echoed, never on the action or its answer, which names the connection only.
 */

/** The slice of Better Auth the API reads — structural, so a test fakes it without a database. */
export type AuthHandle = {
  handler: (request: Request) => Promise<Response>;
  getSession: (headers: Headers) => Promise<SessionLike>;
};

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
};

export type ApiOptions = {
  auth: AuthHandle;
  deps: ApiDeps;
  /** The console's origins (`GRAFT_CORS_ORIGIN`); empty means no CORS header is ever written. */
  corsOrigins: readonly string[];
  /** What signs and roots a handoff URL (`@graft/mcp`'s `handoff.ts`) — the console's URL and the secret. */
  handoff: Pick<HandoffConfig, "consoleUrl" | "secret">;
};

/**
 * A pending action as the console shows it (ADR 0006): the requesting agent named, the payload the
 * ask wrote (`@graft/mcp`'s `ToolAskPayload`, `BuildAskPayload`, `ConnectionProposalPayload` or
 * `CredentialAskPayload`), its clocks, and the signed link.
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

const answerBody = z.object({ allow: z.boolean(), relax: z.boolean().optional() });

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
  connectionIds: z.array(z.string()).optional(),
});

const agentPatch = agentBody.omit({ connectionIds: true }).partial();

const scopeBody = z.object({ connectionIds: z.array(z.string()) });

/** The scheme's secret fields as the console posts them; the service holds them to the scheme's table. */
const credentialFields = z.record(z.string(), z.unknown());

const registrationBody = z.object({
  vendor: z.string(),
  displayName: z.string(),
  scheme: z.enum(connectionScheme),
  schemeConfig: z.record(z.string(), z.unknown()).optional(),
  primaryHost: z.string(),
  hosts: z.array(z.string()).optional(),
});

const connectionBody = registrationBody.extend({
  oauth: z
    .object({
      clientId: z.string(),
      authorizeUrl: z.string(),
      tokenUrl: z.string(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
  /** With it, the connection is registered with its credential in one transaction (GRA-28's Add connection). */
  credential: credentialFields.optional(),
});

const credentialBody = z.object({ fields: credentialFields });

/** GRA-28's submit for a `connection` ask: the proposal as the person edited it, and the secret. */
const connectionSubmitBody = registrationBody.extend({ credential: credentialFields });
const credentialSubmitBody = z.object({ credential: credentialFields });

const modelKeyBody = z.object({
  provider: z.string(),
  apiKey: z.string(),
  authoringModel: z.string().nullable().optional(),
  triageModel: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
});

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
 * changed, why (`agent`, `publish`, `idle`, `cap`, `revoke` — ADR 0009's two rule causes beside the
 * agent-driven ones), when, and the tool by vendor and name rather than by id alone, so the view
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

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await request.json();
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

  if (options.corsOrigins.length > 0) {
    api.use("*", cors({ origin: [...options.corsOrigins], credentials: true }));
  }

  api.onError((error, c) => {
    if (error instanceof ServiceError) {
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

  /** Better Auth's own routes: sign-up, sign-in, sign-out, session. */
  api.on(["POST", "GET"], "/auth/*", (c) => options.auth.handler(c.req.raw));

  const {
    approval: approvalDeps,
    pendingAction: pendingActionDeps,
    modelKey: modelKeyDeps,
  } = options.deps;
  const { handoff } = options;

  const principalOf = async (headers: Headers) =>
    requirePerson(await options.auth.getSession(headers));

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
    return c.json(
      await setAgentScope(ctx, principal, c.req.param("id"), body.connectionIds, agentDeps),
    );
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
  api.post("/connections", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const { credential, ...registration } = await parseBody(c.req.raw, connectionBody);
    const connection = credential
      ? await registerConnectionWithCredential(
          ctx,
          principal,
          { ...registration, credential },
          connectionDeps,
        )
      : await registerConnection(ctx, principal, registration, connectionDeps);
    return c.json({ connection }, 201);
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
    const connection = await setConnectionCredential(
      ctx,
      principal,
      c.req.param("id"),
      body.fields,
      connectionDeps,
    );
    return c.json({ connection });
  });

  api.post("/connections/:id/revoke", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const result = orNotFound(
      await revokeConnection(ctx, principal, c.req.param("id"), connectionDeps),
      "Connection not found",
    );
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
   * The person's answer, `{ allow, relax? }`. Recording the answer and writing the approval it is
   * for happen in one transaction: for a `tool` ask the answer becomes the standing `approval` row
   * (`allow` or `deny` — a no holds too, ADR 0008), and `relax` on a destructive tool lifts its
   * per-call ask; for a `build` ask an `allow` grants the build approval and a decline writes
   * nothing, so the next `acquire` asks again.
   *
   * **An answer the standing row now carries in full is consumed here.** Otherwise it would outlive
   * the row: a yes left answered-but-unconsumed would still be found and honoured by a call made
   * after the approval was withdrawn, which is exactly what withdrawing is meant to prevent. The two
   * answers the agent's next call must read for itself stay unconsumed — a destructive tool's
   * per-call yes (ADR 0008: it asks every call) and a build decline (no row records it). A call that
   * is waiting sees the consumed action as `CONFLICT` and reads the rule again (`@graft/mcp`'s
   * `approval.ts`), which is how it proceeds on a yes and refuses on a no.
   */
  api.post("/pending-actions/:id/answer", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, answerBody);
    const id = c.req.param("id");
    const result = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const answer = {
        allow: body.allow,
        ...(body.relax === undefined ? {} : { relax: body.relax }),
      };
      const action = await answerPendingAction(scoped, principal, id, answer, pendingActionDeps);
      const scope = { personId: principal.personId, agentId: action.agentId };
      const said = readApprovalAnswer(action.answer);
      /** Mark the answer spent; the agent may have taken it between the two statements, which is fine. */
      const settle = async () => {
        try {
          await consumePendingAction(scoped, scope, action.id, pendingActionDeps);
        } catch (error) {
          if (!(error instanceof ServiceError && error.code === "CONFLICT")) throw error;
        }
      };
      if (action.kind === "tool" && typeof action.payload.toolId === "string") {
        const toolId = action.payload.toolId;
        const tool = await getToolById(scoped, principal, toolId, toolDeps);
        let approval = await setApproval(
          scoped,
          scope,
          toolId,
          said.allow ? "allow" : "deny",
          approvalDeps,
        );
        const relaxed = said.allow && said.relax === true && tool?.destructive === true;
        if (relaxed) approval = await relaxDestructiveApproval(scoped, scope, toolId, approvalDeps);
        if (!said.allow || !tool?.destructive || relaxed) await settle();
        return { pendingAction: action, approval };
      }
      if (
        action.kind === "build" &&
        said.allow &&
        typeof action.payload.connectionId === "string"
      ) {
        const buildApproval = await grantBuildApproval(
          scoped,
          scope,
          action.payload.connectionId,
          approvalDeps,
        );
        await settle();
        return { pendingAction: action, buildApproval };
      }
      return { pendingAction: action };
    });
    return c.json(result);
  });

  /**
   * The action a submit route is for: the person's, of the kind the route serves, unanswered and in
   * time — refused with the answer route's codes (409 answered or taken, 410 expired) before anything
   * is written. The answer's own predicate refuses again inside the transaction, so two submits of
   * one link make one connection and the second is told so.
   */
  const openActionOfKind = async (
    scoped: ServiceContext,
    principal: Principal,
    id: string,
    kind: string,
  ): Promise<PendingActionRow> => {
    const row = orNotFound(
      await getPendingActionForPerson(scoped, principal, id, pendingActionDeps),
      "Pending action not found",
    );
    if (row.kind !== kind) {
      throw new ServiceError("BAD_REQUEST", `This action is a ${row.kind} ask, not a ${kind} one`);
    }
    if (row.answeredAt || row.consumedAt) {
      throw new ServiceError("CONFLICT", "This action has already been answered");
    }
    if (row.expiresAt.getTime() <= pendingActionDeps.now().getTime()) {
      throw new ServiceError(
        "GONE",
        "This action has expired — the agent will ask again if it still needs to",
      );
    }
    return row;
  };

  /**
   * The person's submit for a `connection` ask (GRA-28; ADR 0006): the proposal as they edited it
   * becomes a connection with its credential written once through the vault's encrypt half, the
   * connection joins the requesting agent's scope and no other agent's (ADR 0007), and the action's
   * answer records `{ connectionId }` and nothing of the credential — one transaction, so a refused
   * host or a mistyped field leaves no row, no scope change and no answer. The waiting
   * `request_connection` call takes the answer and says connected; a proposed host that is not
   * public is refused here as `host_not_public`, as it was to the agent and as the form said.
   */
  api.post("/pending-actions/:id/connection", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, connectionSubmitBody);
    const id = c.req.param("id");
    const result = await ctx.db.transaction(async (tx) => {
      const scoped: ServiceContext = { db: tx };
      const action = await openActionOfKind(scoped, principal, id, CONNECTION_ASK_KIND);
      const connection = await registerConnectionWithCredential(
        scoped,
        principal,
        body,
        connectionDeps,
      );
      await addConnectionToAgentScope(scoped, principal, action.agentId, connection.id, agentDeps);
      const pendingAction = await answerPendingAction(
        scoped,
        principal,
        action.id,
        { connectionId: connection.id },
        pendingActionDeps,
      );
      return { connection, pendingAction };
    });
    return c.json(result, 201);
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
      const action = await openActionOfKind(scoped, principal, id, CREDENTIAL_ASK_KIND);
      const connectionId = action.payload.connectionId;
      if (typeof connectionId !== "string") {
        throw new ServiceError("BAD_REQUEST", "This credential ask names no connection");
      }
      const connection = await setConnectionCredential(
        scoped,
        principal,
        connectionId,
        body.credential,
        connectionDeps,
      );
      const pendingAction = await answerPendingAction(
        scoped,
        principal,
        action.id,
        { connectionId },
        pendingActionDeps,
      );
      return { connection, pendingAction };
    });
    return c.json(result);
  });

  /** One agent's standing approvals — what the console lists to relax or withdraw. */
  api.get("/approvals", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const scope = { personId: principal.personId, agentId: agentIdOf(c.req.query("agentId")) };
    return c.json({ approvals: await listApprovals(ctx, scope, approvalDeps) });
  });

  /** Relax a destructive tool's per-call ask for one agent (ADR 0008). 400 for a tool that is not destructive. */
  api.post("/approvals/:toolId/relax", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const scope = { personId: principal.personId, agentId: agentIdOf(c.req.query("agentId")) };
    return c.json({
      approval: await relaxDestructiveApproval(ctx, scope, c.req.param("toolId"), approvalDeps),
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
