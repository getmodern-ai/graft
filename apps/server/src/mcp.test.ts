import type { McpDeps } from "@graft/mcp";
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

const sandboxes: FakeSandboxBackend[] = [];

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
});

function harness() {
  const store = createFakeStore();
  store.addAgent({ scopeMode: "listed", id: "agent_a", personId: "person_1", token: TOKEN_A });
  store.addAgent({ scopeMode: "listed", id: "agent_b", personId: "person_1", token: TOKEN_B });
  const sandbox = createFakeSandboxBackend();
  sandboxes.push(sandbox);
  const mcp: McpDeps = {
    ...createFakeDeps(store),
    sandbox,
    keys: null,
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
  return { app, store };
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
});
