import { randomUUID } from "node:crypto";

import { type AgentScope, bearerTokenFrom, requireAgent, ServiceError } from "@graft/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";

import type { McpDeps } from "./deps";
import { createToolListChangedNotifier, type ToolListChangedNotifier } from "./notifier";
import { type AgentSession, createAgentSession } from "./session";

/**
 * The streamable-HTTP endpoint (GRA-1, "The MCP server and the working set": one endpoint per
 * deployment, the bearer token identifies the agent). Mounted by `apps/server` at `/mcp`; this app
 * answers `POST`, `GET` and `DELETE` on its root, which is what the transport needs.
 *
 * **The token is checked on every request, before the transport sees it.** A missing, unknown or
 * revoked token is a 401 with no MCP handshake (ADR 0007: a revoked agent stops at once, and an
 * unknown token and a revoked one are one refusal). A session is opened by an `initialize` and
 * bound to the agent that opened it; a later request carrying that session id with another agent's
 * token is refused too — a session id is not a credential, and must never become one by being
 * guessed or leaked. Sessions live in this process's memory, as the SDK's transport keeps them.
 *
 * Refusals share the proxy's body shape, `{ error, reason, message }`, so an agent's code reads one
 * vocabulary from both doors.
 */

export type McpHttpOptions = {
  /** Shared across every session the process holds; one is created when none is given. */
  notifier?: ToolListChangedNotifier;
  /** Injectable so a test can predict a session id. */
  sessionIdGenerator?: () => string;
};

type LiveSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  session: AgentSession;
};

function jsonRpcError(status: 400 | 404, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function unauthorized(reason: string, message: string): Response {
  return Response.json({ error: "unauthorized", reason, message }, { status: 401 });
}

export function createMcpHttpApp(deps: McpDeps, options: McpHttpOptions = {}): Hono {
  // The process's one notifier, so the sweep's `changed` reaches these sessions (`deps.notifier`);
  // a fresh one only when the deps were built by hand without it.
  const notifier =
    options.notifier ??
    deps.notifier ??
    createToolListChangedNotifier({ windowMs: deps.listChangedWindowMs });
  const sessions = new Map<string, LiveSession>();
  const ctx = { db: deps.db };
  const app = new Hono();

  app.all("/", async (c) => {
    const request = c.req.raw;
    const token = bearerTokenFrom(request.headers);
    let scope: AgentScope;
    try {
      scope = await requireAgent(ctx, token, deps.agent);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "UNAUTHORIZED") {
        return unauthorized(token ? "token_unknown" : "token_missing", error.message);
      }
      throw error;
    }

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const live = sessions.get(sessionId);
      if (!live) return jsonRpcError(404, -32001, "Session not found");
      if (live.session.scope.agentId !== scope.agentId) {
        return unauthorized("session_mismatch", "This session was opened by another agent");
      }
      return live.transport.handleRequest(request);
    }

    if (request.method !== "POST") {
      return jsonRpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required");
    }

    // No session yet: this must be an `initialize`. The transport says so if it is not, in which
    // case nothing below registers a session and the pair is closed once the answer is written.
    const session = createAgentSession(deps, scope, notifier);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: options.sessionIdGenerator ?? randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, session });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await session.server.connect(transport);
    // `connect` installed its own `transport.onclose`, which calls this; the session's own onclose
    // detaches it from the notifier, and this removes it from the map on the way.
    const detach = session.server.onclose;
    session.server.onclose = () => {
      detach?.();
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const response = await transport.handleRequest(request);
    if (transport.sessionId === undefined) {
      // Not an `initialize` after all — the transport answered 400 and no session exists to keep.
      await session.close();
    }
    return response;
  });

  return app;
}
