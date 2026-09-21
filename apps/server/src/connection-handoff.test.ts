import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { toProxyConnection } from "@graft/core";
import {
  CONNECTION_ASK_KIND,
  CREDENTIAL_ASK_KIND,
  createMcpDeps,
  createToolListChangedNotifier,
  executeToolName,
  HANDOFF_TOKEN_PARAM,
  openAgentSession,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * GRA-28's acceptance criteria at the seam where the two doors meet (`approvals.test.ts`'s shape):
 * an agent's MCP session proposes a connection, the person submits the form over the JSON API the
 * console calls, and what is asserted is what each side then sees — the tool's `connected`, the
 * connection in the person's list with its hosts and `credentialSetAt` and no credential material,
 * the requesting agent's scope and not another's, the execute tool reaching the vendor through the
 * proxy with the key injected and the token stripped, a re-entry that leaves approvals in place,
 * and a tampered or expired link that opens nothing and creates nothing. The rule's own cases are
 * `@graft/mcp`'s `connection-request.test.ts`; the routes' wire shapes are `api.test.ts`.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TOKEN_A = "grft_connection_server_test_token_a_00000000000000";
const TOKEN_B = "grft_connection_server_test_token_b_00000000000000";
const SESSION = { user: { id: PERSON } };
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };

const PROPOSAL = {
  vendor: "acme",
  displayName: "Acme Orders",
  primaryHost: "https://api.acme.example/v2",
  hosts: ["files.acme.example"],
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-acme-key", prefix: "Key" },
  docsUrl: "https://developer.acme.example/auth",
};

const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch("/items");
  if (!res.ok) throw new Error(\`GET /items \${res.status}\`);
  return await res.json();
};
`;
const RUN_LIST_ITEMS = `echo '{}' | node /graft/runner.mjs ${sandboxPath("tools/acme/list-items/v1")}`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let app: ReturnType<typeof createServer>;
let mcp: ReturnType<typeof createMcpDeps>;

beforeAll(async () => {
  const keys = await generateTestKeys();
  store = createFakeStore();
  vendor = await startFakeVendor({
    keys,
    connections: [],
    resolve: async (id) => {
      const row = store.connections.get(id);
      return row ? toProxyConnection(row) : null;
    },
  });
  sandbox = createFakeSandboxBackend();
  const dir = join(sandbox.toolboxRoot(PERSON), "tools/acme/list-items/v1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), MODULE);

  store.addAgent({
    scopeMode: "listed",
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    name: "laptop Hermes",
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_B,
    personId: PERSON,
    token: TOKEN_B,
    name: "server OpenClaw",
  });

  const fake = createFakeDeps(store);
  // The real vault's encrypt half on the service side, the same vault's decrypt behind the proxy.
  const connection = {
    ...fake.connection,
    vault: {
      encrypt: (
        fields: Record<string, string>,
        scope: { personId: string; connectionId: string },
      ) => vendor.vault.encrypt(fields, scope),
    },
  };
  const handoff = {
    consoleUrl: "http://console.graft.test",
    secret: "graft-connection-server-test-handoff-secret-32",
    waitMs: 0,
    ttlMs: 60_000,
    pollMs: 20,
  };
  mcp = createMcpDeps({
    ...fake,
    connection,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    handoff,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
  });
  app = createServer({
    keys,
    vault: { decrypt: async () => ({}) },
    connections: { get: async () => null },
    followRedirects: false,
    api: {
      auth: {
        handler: async () => new Response("auth"),
        getSession: async () => SESSION,
      },
      deps: {
        db: fake.db,
        agent: fake.agent,
        connection,
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
      },
      corsOrigins: [],
      // The origin the console submits from, which the origin check reads (GRA-148).
      authUrl: CONSOLE_ORIGIN,
      handoff,
    },
    mcp,
  });
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

async function connect(token: string) {
  const notifier = createToolListChangedNotifier();
  const session = await openAgentSession(mcp, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    toolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await session.close();
      notifier.close();
    },
  };
}

function body(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

/**
 * The origin the console submits from: this server's own, since `app.request` builds a relative
 * path against it and the console is served same-origin (`console.ts`). A state-changing request
 * under `/api` has to name an origin this deployment serves the console on (GRA-148,
 * `origin-guard.ts`), so every helper below puts it on as a browser would.
 */
const CONSOLE_ORIGIN = "http://localhost";

const json = (value: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json", origin: CONSOLE_ORIGIN },
  body: JSON.stringify(value),
});

/** A mutation with no body, a revoke, from the console's origin. */
const from = (method: "POST" | "PUT" | "DELETE") => ({
  method,
  headers: { origin: CONSOLE_ORIGIN },
});

type ConnectionWire = {
  id: string;
  displayName: string;
  hosts: string[];
  primaryHost: string;
  credentialSetAt: string | null;
  revokedAt: string | null;
};

const listConnections = async () =>
  ((await (await app.request("/api/connections")).json()) as { connections: ConnectionWire[] })
    .connections;

const scopeOf = async (agentId: string) =>
  ((await (await app.request(`/api/agents/${agentId}`)).json()) as { connectionIds: string[] })
    .connectionIds;

describe("a connection proposed over MCP and entered over HTTP", () => {
  let connectionId = "";

  it("the agent gets a link and waits; the submit creates the connection with its credential, for this agent alone, and the tool then says connected", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      const first = await a.call("request_connection", PROPOSAL);
      expect(first.isError).toBe(false);
      const said = body(first);
      expect(said).toMatchObject({
        error: "awaiting_connection",
        pendingActionId: expect.any(String),
      });
      const actionId = said.pendingActionId as string;
      const url = new URL(said.url as string);
      expect(url.origin).toBe("http://console.graft.test");
      expect(url.pathname).toBe(`/pending/${actionId}`);
      const token = url.searchParams.get(HANDOFF_TOKEN_PARAM);

      // The console's list and the link both show the proposal, and nothing exists yet.
      const listed = (await (await app.request("/api/pending-actions")).json()) as {
        pendingActions: Record<string, unknown>[];
      };
      expect(listed.pendingActions).toEqual([
        expect.objectContaining({
          id: actionId,
          agent: { id: AGENT_A, name: "laptop Hermes" },
          kind: CONNECTION_ASK_KIND,
          url: said.url,
        }),
      ]);
      const card = await app.request(`/api/pending-actions/${actionId}?t=${token}`);
      expect(card.status).toBe(200);
      expect(await card.json()).toMatchObject({
        pendingAction: {
          payload: {
            vendor: "acme",
            displayName: "Acme Orders",
            primaryHost: "https://api.acme.example/v2",
            hosts: ["api.acme.example", "files.acme.example"],
            scheme: "api_key_header",
            schemeConfig: { headerName: "x-acme-key", prefix: "Key" },
            docsUrl: "https://developer.acme.example/auth",
          },
        },
      });
      // A tampered link opens nothing and creates nothing.
      const forged = await app.request(`/api/pending-actions/${actionId}?t=${token}x`);
      expect(forged.status).toBe(403);
      expect(await forged.json()).toMatchObject({ details: { reason: "tampered" } });
      expect(await listConnections()).toEqual([]);

      // The person edits the name, keeps the hosts, and enters the key.
      const submitted = await app.request(
        `/api/pending-actions/${actionId}/connection`,
        json({
          vendor: "acme",
          displayName: "Acme Orders (production)",
          scheme: "api_key_header",
          schemeConfig: { headerName: "x-acme-key", prefix: "Key" },
          primaryHost: "https://api.acme.example/v2",
          hosts: ["files.acme.example"],
          credential: { apiKey: "sk_live_acme_1" },
        }),
      );
      expect(submitted.status).toBe(201);
      const text = await submitted.text();
      expect(text).not.toContain("sk_live_acme_1");
      expect(text).not.toContain("iphertext");
      const { connection } = JSON.parse(text) as { connection: ConnectionWire };
      connectionId = connection.id;

      // The person's list carries the connection with its hosts and "credential set at".
      const connections = await listConnections();
      expect(connections).toEqual([
        expect.objectContaining({
          id: connectionId,
          displayName: "Acme Orders (production)",
          primaryHost: "https://api.acme.example/v2",
          hosts: ["api.acme.example", "files.acme.example"],
          credentialSetAt: expect.any(String),
          revokedAt: null,
        }),
      ]);
      expect(JSON.stringify(connections)).not.toContain("sk_live_acme_1");
      expect(JSON.stringify(connections)).not.toContain("iphertext");

      // The agent that asked has it in its scope; the other agent does not (ADR 0007).
      expect(await scopeOf(AGENT_A)).toEqual([connectionId]);
      expect(await scopeOf(AGENT_B)).toEqual([]);

      // The waiting tool takes the answer and says connected, and nothing of the secret.
      const second = await a.call("request_connection", PROPOSAL);
      expect(second.isError).toBeFalsy();
      expect(body(second)).toMatchObject({
        status: "connected",
        connectionId,
        executeTool: executeToolName(connectionId),
      });
      expect(JSON.stringify(body(second))).not.toContain("sk_live_acme_1");
      expect(await a.toolNames()).toContain(executeToolName(connectionId));
      expect(await b.toolNames()).not.toContain(executeToolName(connectionId));

      // The spent link, and a second submit of it, are refused.
      expect((await app.request(`/api/pending-actions/${actionId}?t=${token}`)).status).toBe(409);
      const again = await app.request(
        `/api/pending-actions/${actionId}/connection`,
        json({ ...PROPOSAL, credential: { apiKey: "sk_live_acme_1" } }),
      );
      expect(again.status).toBe(409);
      expect(await listConnections()).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("the execute tool for the new connection reaches the vendor through the proxy with the header injected and no token", async () => {
    store.grantBuild(AGENT_A, connectionId);
    const a = await connect(TOKEN_A);
    try {
      const run = await a.call(executeToolName(connectionId), { command: RUN_LIST_ITEMS });
      expect(run.isError, JSON.stringify(body(run))).toBeFalsy();
      expect(body(run)).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(String(body(run).output))).toEqual(VENDOR_BODY);
      const request = vendor.requests.at(-1);
      expect(request?.url).toBe("https://api.acme.example/v2/items");
      expect(request?.headers.get("x-acme-key")).toBe("Key sk_live_acme_1");
      expect(request?.headers.get("authorization")).toBeNull();
      expect(vendor.events.at(-1)).toMatchObject({ connectionId, agentId: AGENT_A });
    } finally {
      await a.close();
    }
  }, 60_000);

  it("request_credential replaces the credential through the API and leaves approvals in place; the next execute call carries the new key", async () => {
    // A standing approval on a tool of the vendor, and the build approval — both must survive.
    store.addTool({
      id: "tool_acme_list",
      personId: PERSON,
      vendor: "acme",
      name: "list-items",
      description: "Lists items",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: connectionId,
      path: "tools/acme/list-items/v1",
    });
    const approvalsBefore = (await (
      await app.request(`/api/approvals?agentId=${AGENT_A}`)
    ).json()) as {
      approvals: unknown[];
    };
    const buildsBefore = [...store.buildApprovals.values()];

    const a = await connect(TOKEN_A);
    try {
      const first = await a.call("request_credential", {
        connectionId,
        reason: "401 from the vendor: key rotated",
      });
      expect(body(first)).toMatchObject({
        error: "awaiting_credential",
        pendingActionId: expect.any(String),
      });
      const actionId = body(first).pendingActionId as string;
      const listed = (await (await app.request("/api/pending-actions")).json()) as {
        pendingActions: { id: string; kind: string; payload: Record<string, unknown> }[];
      };
      expect(listed.pendingActions.map((row) => [row.id, row.kind])).toEqual([
        [actionId, CREDENTIAL_ASK_KIND],
      ]);
      expect(listed.pendingActions[0]?.payload).toMatchObject({
        connectionId,
        connectionName: "Acme Orders (production)",
        reason: "401 from the vendor: key rotated",
        revoked: false,
      });

      const submitted = await app.request(
        `/api/pending-actions/${actionId}/credential`,
        json({ credential: { apiKey: "sk_live_acme_2" } }),
      );
      expect(submitted.status).toBe(200);
      expect(await submitted.text()).not.toContain("sk_live_acme_2");

      const approvalsAfter = (await (
        await app.request(`/api/approvals?agentId=${AGENT_A}`)
      ).json()) as {
        approvals: unknown[];
      };
      expect(approvalsAfter).toEqual(approvalsBefore);
      expect([...store.buildApprovals.values()]).toEqual(buildsBefore);

      const second = await a.call("request_credential", { connectionId });
      expect(second.isError).toBeFalsy();
      expect(body(second)).toMatchObject({ status: "connected", connectionId });

      const run = await a.call(executeToolName(connectionId), { command: RUN_LIST_ITEMS });
      expect(run.isError, JSON.stringify(body(run))).toBeFalsy();
      expect(vendor.requests.at(-1)?.headers.get("x-acme-key")).toBe("Key sk_live_acme_2");
    } finally {
      await a.close();
    }
  }, 60_000);

  it("an expired link answers the refusal page and its submit creates nothing", async () => {
    mcp.handoff.ttlMs = 30;
    const a = await connect(TOKEN_A);
    const proposal = {
      ...PROPOSAL,
      vendor: "beta",
      displayName: "Beta",
      primaryHost: "https://api.beta.example",
      hosts: [],
    };
    try {
      const first = await a.call("request_connection", proposal);
      const said = body(first);
      expect(said).toMatchObject({ error: "awaiting_connection" });
      const actionId = said.pendingActionId as string;
      const token = new URL(said.url as string).searchParams.get(HANDOFF_TOKEN_PARAM);
      await new Promise((r) => setTimeout(r, 60));

      const card = await app.request(`/api/pending-actions/${actionId}?t=${token}`);
      expect(card.status).toBe(410);
      expect(await card.json()).toMatchObject({ error: "GONE", details: { reason: "expired" } });
      const submitted = await app.request(
        `/api/pending-actions/${actionId}/connection`,
        json({ ...proposal, credential: { apiKey: "k" } }),
      );
      expect(submitted.status).toBe(410);
      expect((await listConnections()).map((row) => row.displayName)).toEqual([
        "Acme Orders (production)",
      ]);
      expect(await scopeOf(AGENT_A)).toEqual([connectionId]);
    } finally {
      mcp.handoff.ttlMs = 60_000;
      await a.close();
    }
  });

  it("revoke clears the credential, every approval and build approval for the connection, its open asks, and leaves the tool", async () => {
    const a = await connect(TOKEN_A);
    try {
      // An approval on the vendor's tool, a build approval, and an open re-entry ask — all to go.
      const open = body(await a.call("request_credential", { connectionId }));
      expect(open).toMatchObject({ error: "awaiting_credential" });
      store.approvals.set(`${AGENT_A} tool_acme_list`, {
        agentId: AGENT_A,
        toolId: "tool_acme_list",
        decision: "allow",
        decidedAt: new Date(),
        askEveryCall: false,
        owner: "person",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(store.buildApprovals.size).toBe(1);

      const revoked = await app.request(`/api/connections/${connectionId}/revoke`, from("POST"));
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        connection: { id: connectionId, credentialSetAt: null, revokedAt: expect.any(String) },
        approvalsDeleted: 1,
        buildApprovalsDeleted: 1,
        pendingActionsExpired: 1,
      });
      expect(store.approvals.size).toBe(0);
      expect(store.buildApprovals.size).toBe(0);
      expect(store.connections.get(connectionId)?.credentialCiphertext).toBeNull();

      // The authored tool stays published; the connection is listed, awaiting reconnection.
      const tools = (await (await app.request("/api/tools")).json()) as { tools: { id: string }[] };
      expect(tools.tools.map((tool) => tool.id)).toContain("tool_acme_list");
      const connections = await listConnections();
      expect(connections.find((row) => row.id === connectionId)).toMatchObject({
        credentialSetAt: null,
        revokedAt: expect.any(String),
      });

      // The re-entry is the reconnection: a fresh ask, and the person's submit clears revoked_at.
      const asked = body(await a.call("request_credential", { connectionId }));
      expect(asked).toMatchObject({ error: "awaiting_credential" });
      const submitted = await app.request(
        `/api/pending-actions/${asked.pendingActionId}/credential`,
        json({ credential: { apiKey: "sk_live_acme_3" } }),
      );
      expect(submitted.status).toBe(200);
      expect((await submitted.json()) as { connection: ConnectionWire }).toMatchObject({
        connection: { revokedAt: null, credentialSetAt: expect.any(String) },
      });
    } finally {
      await a.close();
    }
  }, 60_000);
});
