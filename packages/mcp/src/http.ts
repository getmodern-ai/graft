import { randomUUID } from "node:crypto";

import {
  type AgentScope,
  type AgentTokenRefusal,
  bearerTokenFrom,
  requireAgent,
  ServiceError,
} from "@graft/core";
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
 * unknown token and a revoked one are one refusal). The token is one of two shapes — the static
 * agent token a harness carries, or the access token an MCP client holds after an OAuth consent
 * (ADR 0018) — and `requireAgent` tells them apart; nothing here does. A session is opened by an
 * `initialize` and bound to the agent that opened it; a later request carrying that session id
 * with another agent's token is refused too — a session id is not a credential, and must never
 * become one by being guessed or leaked. Sessions live in this process's memory, as the SDK's
 * transport keeps them.
 *
 * **Every 401 carries the OAuth discovery hint** the MCP authorization specification requires
 * (RFC 9728 §5.1): `WWW-Authenticate: Bearer resource_metadata="…"`, naming where the protected
 * resource metadata answers, so a chat product handed nothing but this endpoint's URL finds the
 * authorization server. A refused token adds `error="invalid_token"` (RFC 6750 §3.1); a request
 * with no token gets the bare challenge, as that RFC asks.
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

/**
 * The challenge a 401 carries: the resource metadata's URL always, and the RFC 6750 error only
 * when a token was presented and refused. `session_mismatch` is a refused token too — the wrong
 * agent's — so it carries the error as well. The description is cut to the characters RFC 6750
 * §3 allows in it (printable ASCII without `"` and `\`) — a header value cannot carry the em dash
 * the JSON body's sentence does, and `Headers.set` throws on it rather than transliterating.
 */
export function wwwAuthenticateChallenge(
  resourceMetadataUrl: string,
  reason: AgentTokenRefusal | "session_mismatch",
  message: string,
): string {
  const parts = [`resource_metadata="${resourceMetadataUrl}"`];
  if (reason !== "token_missing") {
    const description = message
      .replace(/[—–]/g, "-")
      .replace(/"/g, "'")
      .replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, "");
    parts.push('error="invalid_token"', `error_description="${description}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

/** The reason word out of a `requireAgent` refusal; `token_unknown` for a refusal that named none. */
function refusalReasonOf(error: ServiceError): AgentTokenRefusal {
  const reason = error.details?.reason;
  return reason === "token_missing" || reason === "token_expired" ? reason : "token_unknown";
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

  const unauthorized = (
    reason: AgentTokenRefusal | "session_mismatch",
    message: string,
  ): Response => {
    const headers = new Headers({ "content-type": "application/json" });
    if (deps.resourceMetadataUrl) {
      headers.set(
        "www-authenticate",
        wwwAuthenticateChallenge(deps.resourceMetadataUrl, reason, message),
      );
    }
    return new Response(JSON.stringify({ error: "unauthorized", reason, message }), {
      status: 401,
      headers,
    });
  };

  app.all("/", async (c) => {
    const request = c.req.raw;
    const token = bearerTokenFrom(request.headers);
    let scope: AgentScope;
    try {
      scope = await requireAgent(ctx, token, deps.agent);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "UNAUTHORIZED") {
        return unauthorized(refusalReasonOf(error), error.message);
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
