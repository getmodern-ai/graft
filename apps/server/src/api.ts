import {
  type AgentDeps,
  type ConnectionDeps,
  createAgent,
  getAgent,
  getAgentScope,
  getConnection,
  listAgents,
  listConnections,
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
  updateAgentLimits,
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
