import {
  type AgentDeps,
  type ConnectionDeps,
  createAgent,
  getAgent,
  getAgentScope,
  getConnection,
  listAgents,
  listConnections,
  listTools,
  listWorkingSetChanges,
  orNotFound,
  registerConnection,
  requirePerson,
  revokeAgent,
  revokeConnection,
  type ServiceContext,
  ServiceError,
  type SessionLike,
  setAgentScope,
  setConnectionCredential,
  type ToolDeps,
  updateAgentLimits,
  type WorkingSetDeps,
} from "@graft/core";
import type { DbOrTx } from "@graft/db";
import { connectionScheme } from "@graft/db/schema/connection";
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
};

export type ApiOptions = {
  auth: AuthHandle;
  deps: ApiDeps;
  /** The console's origins (`GRAFT_CORS_ORIGIN`); empty means no CORS header is ever written. */
  corsOrigins: readonly string[];
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

  /** Better Auth's own routes: sign-up, sign-in, sign-out, session. */
  api.on(["POST", "GET"], "/auth/*", (c) => options.auth.handler(c.req.raw));

  const principalOf = async (headers: Headers) =>
    requirePerson(await options.auth.getSession(headers));

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

  return api;
}
