import { hashAgentToken } from "@graft/core";
import type { McpDeps, TransportRefusalEvent } from "@graft/mcp";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initLogger } from "evlog";
import { afterAll, describe, expect, it } from "vitest";

import { createServer, MCP_MOUNT_PATH } from "./app";

/**
 * The MCP endpoint at the HTTP layer — the door GRA-19 puts before any handshake, asserted with a
 * real streamable-HTTP client whose `fetch` is the server's own `app.request`, so the whole
 * transport runs and nothing listens on a port. The tool semantics are `@graft/mcp`'s own suite;
 * this is the proof that a token is checked on every request and a session stays with its agent.
 */

initLogger({ silent: true });

const TOKEN_A = "grft_server_test_token_a_000000000000000000000";
const TOKEN_B = "grft_server_test_token_b_000000000000000000000";
/** Access tokens chat products hold for agents A and B after an OAuth consent (ADR 0018); the fake resolves them below. */
const TOKEN_A_OAUTH = "grfta_server_test_access_token_a_00000000000000";
const TOKEN_B_OAUTH = "grfta_server_test_access_token_b_00000000000000";

const sandboxes: FakeSandboxBackend[] = [];

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
});

function harness() {
  const refusals: TransportRefusalEvent[] = [];
  const store = createFakeStore();
  store.addAgent({ scopeMode: "listed", id: "agent_a", personId: "person_1", token: TOKEN_A });
  store.addAgent({ scopeMode: "listed", id: "agent_b", personId: "person_1", token: TOKEN_B });
  const sandbox = createFakeSandboxBackend();
  sandboxes.push(sandbox);
  const fake = createFakeDeps(store);
  const mcp: McpDeps = {
    ...fake,
    agent: {
      ...fake.agent,
      findAgentByMcpAccessTokenHash: async (_db, tokenHash) => {
        const agentId =
          tokenHash === hashAgentToken(TOKEN_A_OAUTH)
            ? "agent_a"
            : tokenHash === hashAgentToken(TOKEN_B_OAUTH)
              ? "agent_b"
              : null;
        return agentId
          ? {
              tokenId: `tok_${agentId}`,
              agentId,
              personId: "person_1",
              clientId: "client_claude",
              expiresAt: null,
            }
          : null;
      },
    },
    sandbox,
    keys: null,
    onTransportRefusal: (event) => {
      refusals.push(event);
    },
    proxyPublicUrl: "http://localhost:3000/api/proxy",
    resourceMetadataUrl: "http://graft.test/.well-known/oauth-protected-resource/mcp",
    checkModule: async () => ({
      entry: null,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    }),
    runnerFiles: async () => [],
    skills: async () => [],
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-server-test-handoff-secret-long-enough-32",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
  const app = createServer({
    keys: null,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    mcp,
  });
  return { app, store, refusals };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0.0.0" },
  },
});

const post = (headers: Record<string, string>, body = INITIALIZE) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  },
  body,
});

describe("the MCP endpoint", () => {
  it("refuses a request with no token before any handshake, and one with an unknown token", async () => {
    const { app } = harness();
    const missing = await app.request(MCP_MOUNT_PATH, post({}));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: "unauthorized", reason: "token_missing" });
    expect(missing.headers.get("mcp-session-id")).toBeNull();
    // ADR 0018: the 401 names the protected resource metadata (RFC 9728 §5.1), and RFC 6750 §3.1
    // wants no `error` on a challenge to a request that presented no token.
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://graft.test/.well-known/oauth-protected-resource/mcp"',
    );

    const unknown = await app.request(
      MCP_MOUNT_PATH,
      post({ authorization: "Bearer grft_nobody" }),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "unauthorized", reason: "token_unknown" });
    expect(unknown.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://graft.test/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );

    const revoked = await app.request(MCP_MOUNT_PATH, post({ authorization: `Bearer ${TOKEN_B}` }));
    expect(revoked.status).toBe(200);
  });

  it("initializes a real streamable-HTTP client with a valid token, lists the meta-tools, and binds the session to that agent", async () => {
    const { app, store } = harness();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://graft.test${MCP_MOUNT_PATH}`),
      {
        fetch: async (url, init) => app.request(url, init),
        requestInit: { headers: { authorization: `Bearer ${TOKEN_A}` } },
      },
    );
    const client = new Client({ name: "harness", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("find_tool");
      expect(tools.map((tool) => tool.name)).toContain("run_tool");

      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      // Another agent's token on this session is refused, whatever the session id says.
      const hijack = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_B}`, "mcp-session-id": sessionId ?? "" }, listTools),
      );
      expect(hijack.status).toBe(401);
      expect(await hijack.json()).toMatchObject({ reason: "session_mismatch" });

      // A revoked agent's own session stops answering at once.
      const agent = store.agents.get("agent_a");
      if (agent) store.agents.set("agent_a", { ...agent, revokedAt: new Date() });
      const afterRevoke = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": sessionId ?? "" }, listTools),
      );
      expect(afterRevoke.status).toBe(401);
      if (agent) store.agents.set("agent_a", agent);

      // A session id nobody opened is not found; a non-initialize with no session id is a bad request.
      const unknownSession = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": "nope" }, listTools),
      );
      expect(unknownSession.status).toBe(404);
      const noSession = await app.request(MCP_MOUNT_PATH, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN_A}`, accept: "text/event-stream" },
      });
      expect(noSession.status).toBe(400);
    } finally {
      await client.close();
    }
  });

  /**
   * GRA-129 (ADR 0018 as amended 2026-09-20): a chat product's client keeps its session id across a
   * deploy and its card frame draws a banner on the 404, so for an access token the session is
   * re-opened under the id it presents; a static-token harness keeps the specification's answers.
   */
  describe("a session the process no longer holds", () => {
    const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const readText = async (response: Response) => {
      const text = await response.text();
      const data = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      return JSON.parse(data[data.length - 1] ?? text) as {
        result?: { tools?: { name: string }[] };
      };
    };

    it("is re-opened in place for an access token: the request is answered under the same id, and the id keeps working", async () => {
      const { app } = harness();
      const stale = "session-from-before-the-deploy";
      const first = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A_OAUTH}`, "mcp-session-id": stale }, listTools),
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("mcp-session-id")).toBe(stale);
      const tools = (await readText(first)).result?.tools?.map((tool) => tool.name) ?? [];
      expect(tools).toContain("find_tool");
      // A chat product's agent, so the list carries no authoring tool (GRA-125).
      expect(tools).not.toContain("write_module");

      const second = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A_OAUTH}`, "mcp-session-id": stale }, listTools),
      );
      expect(second.status).toBe(200);

      // The re-opened session is bound to agent A: another agent's token against it is refused.
      const hijack = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_B}`, "mcp-session-id": stale }, listTools),
      );
      expect(hijack.status).toBe(401);
      expect(await hijack.json()).toMatchObject({ reason: "session_mismatch" });
    });

    it("re-opens once for concurrent requests under one stale id, and the session survives them", async () => {
      const { app } = harness();
      const stale = "one-stale-id-two-requests";
      const request = () =>
        app.request(
          MCP_MOUNT_PATH,
          post({ authorization: `Bearer ${TOKEN_A_OAUTH}`, "mcp-session-id": stale }, listTools),
        );
      const [first, second] = await Promise.all([request(), request()]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.headers.get("mcp-session-id")).toBe(stale);
      expect(second.headers.get("mcp-session-id")).toBe(stale);
      // A third request finds the one session both were answered from.
      const third = await request();
      expect(third.status).toBe(200);
      expect((await readText(third)).result?.tools?.map((tool) => tool.name)).toContain(
        "find_tool",
      );
    });

    /** Greptile on #102: two agents presenting one unknown id at once must not share a session. */
    it("keeps the agent boundary when two agents present one unknown id at once: one is answered, the other refused", async () => {
      const { app } = harness();
      const stale = "one-stale-id-two-agents";
      const as = (token: string) =>
        app.request(
          MCP_MOUNT_PATH,
          post({ authorization: `Bearer ${token}`, "mcp-session-id": stale }, listTools),
        );
      const [a, b] = await Promise.all([as(TOKEN_A_OAUTH), as(TOKEN_B_OAUTH)]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
      const refused = a.status === 401 ? a : b;
      expect(await refused.json()).toMatchObject({ reason: "session_mismatch" });
      // The session stays with the agent that got it; the other is refused again, not re-opened over it.
      const winner = a.status === 200 ? TOKEN_A_OAUTH : TOKEN_B_OAUTH;
      const loser = winner === TOKEN_A_OAUTH ? TOKEN_B_OAUTH : TOKEN_A_OAUTH;
      expect((await as(winner)).status).toBe(200);
      expect((await as(loser)).status).toBe(401);
    });

    it("answers a session-less request that is not an initialize, carrying the id it opened", async () => {
      const { app } = harness();
      const response = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A_OAUTH}` }, listTools),
      );
      expect(response.status).toBe(200);
      const id = response.headers.get("mcp-session-id");
      expect(id).toEqual(expect.any(String));
      const again = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A_OAUTH}`, "mcp-session-id": id ?? "" }, listTools),
      );
      expect(again.status).toBe(200);
    });

    it("stays the specification's 404 and 400 for a static-token agent, which re-initialises", async () => {
      const { app } = harness();
      const unknown = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": "nope" }, listTools),
      );
      expect(unknown.status).toBe(404);
      const noSession = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}` }, listTools),
      );
      expect(noSession.status).toBe(400);
    });

    it("still initialises a fresh session for an access token as before", async () => {
      const { app } = harness();
      const response = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A_OAUTH}` }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toEqual(expect.any(String));
    });
  });

  /** GRA-131: every refused request names its reason to the hook, the door's and the transport's alike. */
  describe("a refused request reaches onTransportRefusal", () => {
    const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    it("tells the hook the door's reason word for a 401, and Graft's own 404 and 400", async () => {
      const { app, refusals } = harness();
      await app.request(MCP_MOUNT_PATH, post({}));
      await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": "nope" }, listTools),
      );
      await app.request(MCP_MOUNT_PATH, {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN_A}`, accept: "text/event-stream" },
      });
      expect(refusals).toEqual([
        expect.objectContaining({
          status: 401,
          message: "token_missing",
          method: "POST",
          hasSessionHeader: false,
        }),
        expect.objectContaining({
          status: 404,
          code: -32001,
          message: "Session not found",
          sessionId: "nope",
        }),
        expect.objectContaining({
          status: 400,
          code: -32000,
          method: "GET",
          hasSessionHeader: false,
        }),
      ]);
    });

    it("tells the hook the SDK's sentence for a request the transport refuses, and nothing for one it answers", async () => {
      const { app, refusals } = harness();
      const opened = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}` }),
      );
      const sessionId = opened.headers.get("mcp-session-id") ?? "";
      const listed = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": sessionId }, listTools),
      );
      expect(listed.status).toBe(200);
      expect(refusals).toEqual([]);
      // An `initialize` under a live session is the SDK's own 400.
      const again = await app.request(
        MCP_MOUNT_PATH,
        post({ authorization: `Bearer ${TOKEN_A}`, "mcp-session-id": sessionId }),
      );
      expect(again.status).toBe(400);
      expect(refusals).toEqual([
        expect.objectContaining({
          status: 400,
          code: -32600,
          message: "Invalid Request: Server already initialized",
          method: "POST",
          hasSessionHeader: true,
        }),
      ]);
      // The client still got the SDK's body, untouched by the read.
      expect(await again.json()).toMatchObject({ error: { code: -32600 } });
    });
  });
});
