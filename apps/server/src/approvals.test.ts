import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createMcpDeps,
  createToolListChangedNotifier,
  HANDOFF_TOKEN_PARAM,
  openAgentSession,
  signHandoffToken,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore, type FakeStore } from "@graft/mcp/testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "@graft/mcp/testing/fake-vendor";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initLogger } from "evlog";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./app";
import { fakeModelKeyDeps } from "./testing/fake-model-key";

/**
 * The two doors over one store (GRA-23's acceptance criteria at the seam they meet): an agent's
 * MCP session asks, and the person answers over the JSON API the console calls — so what is
 * asserted is that a `POST /api/pending-actions/:id/answer` resumes a call that is waiting, that
 * the link the agent relayed is what `GET /api/pending-actions/:id?t=` accepts, and that relaxing
 * and revoking through the API change what the next MCP call does. The rule's own cases are
 * `@graft/mcp`'s `approval.test.ts`; the routes' wire shapes are `api.test.ts`.
 */

initLogger({ silent: true });

const PERSON = "person_1";
const AGENT = "agent_a";
const TOKEN = "grft_approvals_server_test_token_0000000000000000";
const CONN = "conn_demo";
const SESSION = { user: { id: PERSON } };
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };

const MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch("/items");
  return await res.json();
};
`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let app: ReturnType<typeof createServer>;
let mcp: ReturnType<typeof createMcpDeps>;

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: CONN,
        personId: PERSON,
        primaryHost: "https://api.demo.example",
        credential: { apiKey: "k" },
      },
    ],
  });
  sandbox = createFakeSandboxBackend();
  for (const name of ["create-item", "delete-item"]) {
    const dir = join(sandbox.toolboxRoot(PERSON), `tools/demo/${name}/v1`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), MODULE);
  }

  store = createFakeStore();
  store.addConnection({
    id: CONN,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example",
  });
  store.addAgent({
    id: AGENT,
    personId: PERSON,
    token: TOKEN,
    name: "laptop Hermes",
    connectionIds: [CONN],
  });
  for (const [id, name, destructive] of [
    ["tool_create", "create-item", false],
    ["tool_delete", "delete-item", true],
  ] as const) {
    store.addTool({
      id,
      personId: PERSON,
      vendor: "demo",
      name,
      description: `${name}, in the model's words.`,
      inputSchema: { type: "object" },
      readOnly: false,
      destructive,
      defaultConnectionId: CONN,
      path: `tools/demo/${name}/v1`,
    });
    store.promote(AGENT, id);
  }

  const fake = createFakeDeps(store);
  const handoff = {
    consoleUrl: "http://console.graft.test",
    secret: "graft-approvals-server-test-handoff-secret-32",
    waitMs: 0,
    ttlMs: 60_000,
    pollMs: 20,
  };
  mcp = createMcpDeps({
    ...fake,
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
        connection: fake.connection,
        workingSet: fake.workingSet,
        tool: fake.tool,
        ledger: fake.ledger,
        approval: fake.approval,
        pendingAction: fake.pendingAction,
        modelKey: fakeModelKeyDeps(),
      },
      corsOrigins: [],
      handoff,
    },
    mcp,
  });
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

async function connect(token = TOKEN) {
  const notifier = createToolListChangedNotifier();
  const session = await openAgentSession(mcp, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
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

const json = (value: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe("an ask over MCP, answered over HTTP", () => {
  it("the link the agent relays is what the API accepts, and answering after the call returned makes the next call proceed", async () => {
    const a = await connect();
    try {
      const first = await a.call("demo__create-item");
      expect(first.isError).toBe(true);
      const said = body(first);
      expect(said).toMatchObject({
        error: "awaiting_approval",
        pendingActionId: expect.any(String),
      });
      const url = new URL(said.url as string);
      expect(url.origin).toBe("http://console.graft.test");
      expect(url.pathname).toBe(`/pending/${said.pendingActionId}`);
      const token = url.searchParams.get(HANDOFF_TOKEN_PARAM);

      const listed = (await (await app.request("/api/pending-actions")).json()) as {
        pendingActions: Record<string, unknown>[];
      };
      expect(listed.pendingActions).toEqual([
        expect.objectContaining({
          id: said.pendingActionId,
          agent: { id: AGENT, name: "laptop Hermes" },
          kind: "tool",
          url: said.url,
        }),
      ]);

      const card = await app.request(`/api/pending-actions/${said.pendingActionId}?t=${token}`);
      expect(card.status).toBe(200);
      expect(await card.json()).toMatchObject({
        pendingAction: {
          payload: { toolName: "demo__create-item", connectionName: "Demo Orders" },
        },
      });
      const forged = await app.request(`/api/pending-actions/${said.pendingActionId}?t=${token}x`);
      expect(forged.status).toBe(403);

      const answered = await app.request(
        `/api/pending-actions/${said.pendingActionId}/answer`,
        json({ allow: true }),
      );
      expect(answered.status).toBe(200);
      expect(await answered.json()).toMatchObject({
        approval: { agentId: AGENT, toolId: "tool_create", decision: "allow" },
      });

      const second = await a.call("demo__create-item");
      expect(second.isError).toBeFalsy();
      expect(body(second)).toEqual(VENDOR_BODY);

      // The link is spent: the agent took the answer, so the card refuses it as reused.
      const reused = await app.request(`/api/pending-actions/${said.pendingActionId}?t=${token}`);
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({
        error: "CONFLICT",
        details: { reason: "consumed" },
      });
    } finally {
      await a.close();
    }
  }, 60_000);

  it("an answer over HTTP inside the wait resumes the call that is waiting, and the spent link then answers 409", async () => {
    mcp.handoff.waitMs = 5_000;
    const a = await connect();
    try {
      const pending = a.call("demo__delete-item");
      await until(() =>
        [...store.pendingActions.values()].some((r) => r.payload.toolId === "tool_delete"),
      );
      const action = [...store.pendingActions.values()].find(
        (r) => r.payload.toolId === "tool_delete",
      );
      if (!action) throw new Error("no action");
      const answered = await app.request(
        `/api/pending-actions/${action.id}/answer`,
        json({ allow: true }),
      );
      expect(answered.status).toBe(200);

      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);

      const listed = (await (await app.request("/api/pending-actions")).json()) as {
        pendingActions: { id: string }[];
      };
      expect(listed.pendingActions.map((r) => r.id)).not.toContain(action.id);
      const token = signHandoffToken(action, mcp.handoff.secret);
      const reused = await app.request(`/api/pending-actions/${action.id}?t=${token}`);
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ details: { reason: "consumed" } });
    } finally {
      mcp.handoff.waitMs = 0;
      await a.close();
    }
  }, 60_000);

  it("a destructive tool's yes holds; ask-every-call on through the API makes the next call ask; off again makes it hold; revoking makes it ask afresh", async () => {
    const a = await connect();
    try {
      // The yes recorded in the previous case holds — a destructive tool asks once, like a write.
      const holds = await a.call("demo__delete-item");
      expect(holds.isError).toBeFalsy();
      expect(body(holds)).toEqual(VENDOR_BODY);

      const on = await app.request(
        `/api/approvals/tool_delete/ask-every-call?agentId=${AGENT}`,
        json({ on: true }, "PUT"),
      );
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ approval: { askEveryCall: true } });

      const asks = await a.call("demo__delete-item");
      expect(body(asks)).toMatchObject({ error: "awaiting_approval" });
      const action = [...store.pendingActions.values()].find(
        (r) => r.payload.toolId === "tool_delete" && r.answeredAt === null,
      );
      if (!action) throw new Error("no open action");
      expect(action.payload.askEveryCall).toBe(true);

      // A yes with the setting still on is for this call: the next asks again.
      const answered = await app.request(
        `/api/pending-actions/${action.id}/answer`,
        json({ allow: true, askEveryCall: true }),
      );
      expect(answered.status).toBe(200);
      expect(body(await a.call("demo__delete-item"))).toEqual(VENDOR_BODY);
      expect(body(await a.call("demo__delete-item"))).toMatchObject({
        error: "awaiting_approval",
      });

      const off = await app.request(
        `/api/approvals/tool_delete/ask-every-call?agentId=${AGENT}`,
        json({ on: false }, "PUT"),
      );
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ approval: { askEveryCall: false } });
      // The open ask is consumed by the call that now passes by rule, or left; either way it passes.
      const silent = await a.call("demo__delete-item");
      expect(silent.isError).toBeFalsy();
      expect(body(silent)).toEqual(VENDOR_BODY);
      expect(body(await a.call("demo__delete-item"))).toEqual(VENDOR_BODY);

      const listed = (await (await app.request(`/api/approvals?agentId=${AGENT}`)).json()) as {
        approvals: { toolId: string }[];
      };
      expect(listed.approvals.map((r) => r.toolId).sort()).toEqual(["tool_create", "tool_delete"]);

      const revoked = await app.request(`/api/approvals/tool_create?agentId=${AGENT}`, {
        method: "DELETE",
      });
      expect(revoked.status).toBe(200);
      const fresh = await a.call("demo__create-item");
      expect(body(fresh)).toMatchObject({ error: "awaiting_approval" });
    } finally {
      await a.close();
    }
  }, 60_000);

  it("a per-call yes the agent has not taken is spent by a withdraw over the API, so the next call asks afresh instead of re-creating the allow", async () => {
    const a = await connect();
    try {
      const on = await app.request(
        `/api/approvals/tool_delete/ask-every-call?agentId=${AGENT}`,
        json({ on: true }, "PUT"),
      );
      expect(on.status).toBe(200);
      const asks = body(await a.call("demo__delete-item"));
      expect(asks).toMatchObject({ error: "awaiting_approval" });
      const actionId = asks.pendingActionId as string;
      const answered = await app.request(
        `/api/pending-actions/${actionId}/answer`,
        json({ allow: true, askEveryCall: true }),
      );
      expect(answered.status).toBe(200);
      // Answered and left for the agent — then withdrawn before the agent calls again.
      expect(store.pendingActions.get(actionId)?.consumedAt).toBeNull();
      const withdrawn = await app.request(`/api/approvals/tool_delete?agentId=${AGENT}`, {
        method: "DELETE",
      });
      expect(withdrawn.status).toBe(200);
      expect(store.pendingActions.get(actionId)?.consumedAt).toBeInstanceOf(Date);

      const afresh = body(await a.call("demo__delete-item"));
      expect(afresh).toMatchObject({ error: "awaiting_approval" });
      expect(afresh.pendingActionId).not.toBe(actionId);
      const listed = (await (await app.request(`/api/approvals?agentId=${AGENT}`)).json()) as {
        approvals: { toolId: string }[];
      };
      expect(listed.approvals.map((r) => r.toolId)).not.toContain("tool_delete");

      // The spent link says so.
      const action = store.pendingActions.get(actionId);
      if (!action) throw new Error("no action");
      const token = signHandoffToken(action, mcp.handoff.secret);
      const reused = await app.request(`/api/pending-actions/${actionId}?t=${token}`);
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ details: { reason: "consumed" } });
    } finally {
      await a.close();
    }
  }, 60_000);
});

describe("an answer after the connection was revoked (GRA-69)", () => {
  /**
   * The revoke's sweep closes the connection's open asks, but an ask inserted after the sweep ran is
   * still open; answering it must not write an approval that would stand once the connection is
   * reconnected (found by review on #83). The store is set revoked directly, which is exactly the
   * state that race leaves: a revoked row and an ask the sweep never saw.
   */
  it("is refused 409 connection_revoked, the ask is closed as the sweep would have closed it, and nothing is recorded", async () => {
    const TOKEN_R = "grft_approvals_server_test_token_r_00000000000000";
    store.addAgent({
      id: "agent_r",
      personId: PERSON,
      token: TOKEN_R,
      name: "racing Hermes",
      connectionIds: [CONN],
    });
    store.promote("agent_r", "tool_create");
    const live = store.connections.get(CONN);
    if (!live) throw new Error("fixture: the connection is missing");
    const c = await connect(TOKEN_R);
    try {
      const said = body(await c.call("demo__create-item", {}));
      expect(said).toMatchObject({ error: "awaiting_approval" });
      const actionId = said.pendingActionId as string;

      store.connections.set(CONN, { ...live, revokedAt: new Date() });
      const res = await app.request(
        `/api/pending-actions/${actionId}/answer`,
        json({ allow: true }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "CONFLICT",
        details: { reason: "connection_revoked", connectionId: CONN },
      });
      expect(store.approvals.get("agent_r tool_create")).toBeUndefined();
      const closed = store.pendingActions.get(actionId);
      expect(closed?.consumedAt).not.toBeNull();
      expect(closed?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

      // While revoked, the call is refused before any ask; reconnected, it asks afresh: nothing stood.
      expect(body(await c.call("demo__create-item", {}))).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
      });
      store.connections.set(CONN, live);
      expect(body(await c.call("demo__create-item", {}))).toMatchObject({
        error: "awaiting_approval",
      });
    } finally {
      store.connections.set(CONN, live);
      await c.close();
    }
  }, 30_000);
});
