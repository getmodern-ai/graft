import {
  type AgentDeps,
  type ApprovalDeps,
  answerPendingAction,
  type ConnectionDeps,
  consumePendingAction,
  createAgent,
  getAgent,
  getAgentScope,
  getConnection,
  getPendingActionForPerson,
  getToolById,
  grantBuildApproval,
  listAgents,
  listApprovals,
  listConnections,
  listOpenPendingActions,
  orNotFound,
  type PendingActionDeps,
  type Principal,
  registerConnection,
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
  type ToolDeps,
  updateAgentLimits,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import { connectionScheme } from "@graft/db/schema/connection";
import {
  HANDOFF_TOKEN_PARAM,
  type HandoffConfig,
  handoffUrl,
  readApprovalAnswer,
  signHandoffToken,
  verifyHandoff,
} from "@graft/mcp";
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
  tool: ToolDeps;
  approval: ApprovalDeps;
  pendingAction: PendingActionDeps;
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
 * ask wrote (`@graft/mcp`'s `ToolAskPayload` or `BuildAskPayload`), its clocks, and the signed link.
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

const connectionBody = z.object({
  vendor: z.string(),
  displayName: z.string(),
  scheme: z.enum(connectionScheme),
  schemeConfig: z.record(z.string(), z.unknown()).optional(),
  primaryHost: z.string(),
  hosts: z.array(z.string()).optional(),
  oauth: z
    .object({
      clientId: z.string(),
      authorizeUrl: z.string(),
      tokenUrl: z.string(),
      scopes: z.array(z.string()).optional(),
    })
    .optional(),
});

const credentialBody = z.object({ fields: z.record(z.string(), z.unknown()) });

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
  const { agent: agentDeps, connection: connectionDeps } = options.deps;

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

  /** Better Auth's own routes: sign-up, sign-in, sign-out, session. */
  api.on(["POST", "GET"], "/auth/*", (c) => options.auth.handler(c.req.raw));

  const { tool: toolDeps, approval: approvalDeps, pendingAction: pendingActionDeps } = options.deps;
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

  api.put("/agents/:id/scope", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, scopeBody);
    return c.json(
      await setAgentScope(ctx, principal, c.req.param("id"), body.connectionIds, agentDeps),
    );
  });

  api.get("/connections", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    return c.json({ connections: await listConnections(ctx, principal, connectionDeps) });
  });

  api.post("/connections", async (c) => {
    const principal = await principalOf(c.req.raw.headers);
    const body = await parseBody(c.req.raw, connectionBody);
    return c.json(
      { connection: await registerConnection(ctx, principal, body, connectionDeps) },
      201,
    );
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
