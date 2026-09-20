import { randomUUID } from "node:crypto";

import {
  type AgentScope,
  type AgentTokenRefusal,
  bearerTokenFrom,
  MCP_ACCESS_TOKEN_PREFIX,
  requireAgent,
  ServiceError,
} from "@graft/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
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
 * **A session this process no longer holds is re-opened in place for a chat product's client**
 * (GRA-129; ADR 0018 as amended 2026-09-20). The specification's answer to an unknown session id is
 * 404 and the client re-initialises, which Hermes, OpenClaw and ChatGPT do; Claude.ai's card frame
 * does not — it keeps the id it had before a deploy ended the process, is refused, and draws
 * "Unable to reach Graft" where the card goes (GRA-124). So a request carrying an access token
 * (`grfta_`, the token a product holds after an OAuth consent) with a session id nobody here
 * opened, or with no session id and no `initialize`, gets a fresh session under that id — or a
 * new one, carried on the response — primed by a synthetic `initialize` declaring no client
 * capabilities: the card gate's client half then falls back to the registered redirect URI, which
 * is how those products are vouched for anyway (`card-client.ts`), and an elicitation is never
 * offered, which no chat product has. A static-token agent keeps the specification's 404 and 400:
 * a harness re-initialises, and its declared capabilities matter. Nothing is given away — the
 * token is checked before the session is looked up, and the re-opened session is bound to that
 * agent as any is.
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

/** The `clientInfo` a re-opened session's synthetic `initialize` carries, so a trace says what it was. */
const REOPENED_CLIENT = { name: "graft-reopened-session", version: "0" } as const;

/**
 * Whether a session-less request is the `initialize` a fresh session starts with, read from a
 * clone so the transport still gets the body; anything unparseable is left to the transport's own
 * 400.
 */
async function carriesInitialize(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some(isInitializeRequest);
  } catch {
    return true;
  }
}

/** The protocol version a re-opened session negotiates: the client's header when it is one we speak, else the latest. */
function protocolVersionFor(request: Request): string {
  const header = request.headers.get("mcp-protocol-version");
  return header && SUPPORTED_PROTOCOL_VERSIONS.includes(header) ? header : LATEST_PROTOCOL_VERSION;
}

function syntheticInitialize(request: Request): Request {
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: protocolVersionFor(request),
        capabilities: {},
        clientInfo: REOPENED_CLIENT,
      },
    }),
  });
}

/** The same request with the session id a re-opened session was given, for the transport's own check. */
function withSessionId(request: Request, sessionId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("mcp-session-id", sessionId);
  return new Request(request, { headers });
}

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

    const generateSessionId = options.sessionIdGenerator ?? randomUUID;
    /** A session and its transport, registered under the id the transport settles on. */
    const open = async (sessionId?: string): Promise<LiveSession> => {
      const session = createAgentSession(deps, scope, notifier);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: sessionId === undefined ? generateSessionId : () => sessionId,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, session });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      await session.server.connect(transport);
      // `connect` installed its own `transport.onclose`, which calls this; the session's own
      // onclose detaches it from the notifier, and this removes it from the map on the way.
      const detach = session.server.onclose;
      session.server.onclose = () => {
        detach?.();
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      return { transport, session };
    };
    /** A session opened under `sessionId` and primed as if its client had initialised it (the header's paragraph on re-opening). */
    const reopen = async (sessionId: string): Promise<LiveSession> => {
      const live = await open(sessionId);
      const primed = await live.transport.handleRequest(syntheticInitialize(request));
      // The transport marked itself initialised before answering; the answer itself is nobody's.
      await primed.body?.cancel();
      return live;
    };
    const reopens = token?.startsWith(MCP_ACCESS_TOKEN_PREFIX) === true;

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const live = sessions.get(sessionId);
      if (live) {
        if (live.session.scope.agentId !== scope.agentId) {
          return unauthorized("session_mismatch", "This session was opened by another agent");
        }
        return live.transport.handleRequest(request);
      }
      if (!reopens) return jsonRpcError(404, -32001, "Session not found");
      const reopened = await reopen(sessionId);
      return reopened.transport.handleRequest(request);
    }

    if (request.method !== "POST") {
      return jsonRpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required");
    }

    if (reopens && !(await carriesInitialize(request))) {
      // A chat product's client asking without a session: a session is opened for it and the
      // answer carries the id, so a client that adopts it continues.
      const id = generateSessionId();
      const reopened = await reopen(id);
      return reopened.transport.handleRequest(withSessionId(request, id));
    }

    // No session yet: this must be an `initialize`. The transport says so if it is not, in which
    // case nothing below registers a session and the pair is closed once the answer is written.
    const { transport, session } = await open();
    const response = await transport.handleRequest(request);
    if (transport.sessionId === undefined) {
      // Not an `initialize` after all — the transport answered 400 and no session exists to keep.
      await session.close();
    }
    return response;
  });

  return app;
}
