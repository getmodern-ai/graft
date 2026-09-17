import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addConnectionToAgentScope,
  answerPendingAction,
  type ConnectionProvider,
  keyringProvider,
  registerConnectionWithCredential,
  revokeConnection,
  setConnectionCredential,
  toProxyConnection,
} from "@graft/core";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CONNECTION_ASK_KIND,
  type ConnectionProposalPayload,
  CREDENTIAL_ASK_KIND,
  describeSchemes,
  normaliseProposal,
  readConnectionAnswer,
  readConnectionProposal,
} from "./connection-request";
import type { McpDeps } from "./deps";
import { HANDOFF_TOKEN_PARAM, verifyHandoff } from "./handoff";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { executeToolName } from "./tool-names";

/**
 * GRA-28 as a harness observes it, on `approval.test.ts`'s fixture shape: the SDK's client over the
 * in-memory pair, the real services over in-memory fakes, the fake sandbox, a fake vendor behind
 * the real proxy — here resolving connections from the store and sharing its vault with the
 * connection service, so a connection the "console" creates mid-test is one the proxy can decrypt.
 * What the console does is played by the same core calls the server's submit route makes
 * (`apps/server/src/api.ts`); the HTTP half is `apps/server/src/connection-handoff.test.ts`.
 */

const PERSON = "person_1";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TOKEN_A = "grft_connection_token_a_00000000000000000000000000";
const TOKEN_B = "grft_connection_token_b_00000000000000000000000000";
const CONSOLE_URL = "http://console.graft.test";
const SECRET = "graft-connection-test-handoff-secret-long-enough-32";
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };

const PROPOSAL = {
  vendor: "acme",
  displayName: "Acme Orders",
  primaryHost: "https://API.acme.example/v2/",
  hosts: ["Files.acme.example"],
  scheme: "api_key_header",
  schemeConfig: { headerName: "x-acme-key" },
  docsUrl: "https://developer.acme.example/auth",
};

/** One module reading `/items` through `ctx.fetch` — what an execute call runs against the new connection. */
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
let deps: McpDeps;

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

  store.addAgent({ id: AGENT_A, personId: PERSON, token: TOKEN_A, name: "laptop Hermes" });
  store.addAgent({ id: AGENT_B, personId: PERSON, token: TOKEN_B, name: "server OpenClaw" });

  const fake = createFakeDeps(store);
  deps = {
    ...fake,
    // The real vault's encrypt half, so the proxy behind the fake vendor decrypts what the service wrote.
    connection: {
      ...fake.connection,
      vault: { encrypt: (f, scope) => vendor.vault.encrypt(f, scope) },
    },
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: async (input) => ({
      entry: input.entry,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    }),
    runnerFiles,
    skills: loadSkills,
    readWebPage: async ({ url }) => ({ ok: false, url, error: "no network in this suite" }),
    listChangedWindowMs: 50,
    handoff: { consoleUrl: CONSOLE_URL, secret: SECRET, waitMs: 0, ttlMs: 60_000, pollMs: 20 },
    oauthRedirectUri: "http://graft.test/api/oauth/callback",
  };
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

afterEach(() => {
  deps.handoff.waitMs = 0;
  deps.handoff.ttlMs = 60_000;
});

async function connect(token: string) {
  const notifier = createToolListChangedNotifier({ windowMs: 50 });
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(
    // The SDK's schema for the notification; only the count is read.
    (await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema,
    async () => {
      listChanged += 1;
    },
  );
  await client.connect(clientTransport);
  return {
    client,
    listChanged: () => listChanged,
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

const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

const ctx = () => ({ db: deps.db });
const principal = { personId: PERSON };

/** What the console's submit route does for a `connection` ask: create, add to the agent's scope, record. */
async function submitConnection(actionId: string, credential: Record<string, string>) {
  const action = store.pendingActions.get(actionId);
  if (!action) throw new Error(`no action ${actionId}`);
  const payload = action.payload as unknown as ConnectionProposalPayload;
  const connection = await registerConnectionWithCredential(
    ctx(),
    principal,
    {
      vendor: payload.vendor,
      displayName: payload.displayName,
      scheme: payload.scheme,
      schemeConfig: payload.schemeConfig,
      primaryHost: payload.primaryHost,
      hosts: payload.hosts,
      credential,
    },
    deps.connection,
  );
  await addConnectionToAgentScope(ctx(), principal, action.agentId, connection.id, deps.agent);
  await answerPendingAction(
    ctx(),
    principal,
    actionId,
    { connectionId: connection.id },
    deps.pendingAction,
  );
  return connection;
}

/** What the console's submit route does for a `credential` ask. */
async function submitCredential(actionId: string, credential: Record<string, string>) {
  const action = store.pendingActions.get(actionId);
  if (!action) throw new Error(`no action ${actionId}`);
  const connectionId = action.payload.connectionId as string;
  await setConnectionCredential(ctx(), principal, connectionId, credential, deps.connection);
  await answerPendingAction(ctx(), principal, actionId, { connectionId }, deps.pendingAction);
}

const actionsOf = (agentId: string, kind: string) =>
  [...store.pendingActions.values()].filter((row) => row.agentId === agentId && row.kind === kind);

/** The awaiting answer as the agent reads it, with the row it names. */
function awaiting(result: CallToolResult, error: "awaiting_connection" | "awaiting_credential") {
  expect(result.isError).toBe(true);
  const said = body(result);
  expect(said).toMatchObject({
    error,
    reason: error,
    pendingActionId: expect.any(String),
    url: expect.stringMatching(
      new RegExp(`^${CONSOLE_URL}/pending/[^?]+\\?${HANDOFF_TOKEN_PARAM}=`),
    ),
    expiresAt: expect.any(String),
    message: expect.stringContaining(said.url as string),
  });
  const action = store.pendingActions.get(said.pendingActionId as string);
  if (!action) throw new Error(`no pending action ${said.pendingActionId}`);
  return { answer: said, action };
}

describe("the proposal's rules, before any record exists", () => {
  it("normalises a proposal the way the connection service would store it", () => {
    const verdict = normaliseProposal(PROPOSAL);
    expect(verdict).toMatchObject({
      ok: true,
      payload: {
        vendor: "acme",
        displayName: "Acme Orders",
        scheme: "api_key_header",
        schemeConfig: { headerName: "x-acme-key" },
        primaryHost: "https://api.acme.example/v2",
        hosts: ["api.acme.example", "files.acme.example"],
        docsUrl: "https://developer.acme.example/auth",
        note: expect.stringContaining("agent's model"),
      },
    });
  });

  it("refuses a private, loopback, link-local or metadata host as host_not_public, naming the host", () => {
    for (const [primaryHost, hosts, host] of [
      ["https://10.0.0.5", [], "10.0.0.5"],
      ["https://127.0.0.1", [], "127.0.0.1"],
      ["https://[fe80::1]", [], "[fe80::1]"],
      ["https://169.254.169.254/latest", [], "169.254.169.254"],
      ["https://api.acme.example", ["metadata.google.internal"], "metadata.google.internal"],
    ] as const) {
      expect(normaliseProposal({ ...PROPOSAL, primaryHost, hosts: [...hosts] })).toMatchObject({
        ok: false,
        reason: "host_not_public",
        details: { host },
      });
    }
  });

  it("refuses a bad slug, an unknown scheme, a missing parameter and a non-https primary as input_invalid", () => {
    for (const [patch, field] of [
      [{ vendor: "Acme" }, "vendor"],
      [{ scheme: "magic" }, "scheme"],
      [{ schemeConfig: {} }, "schemeConfig"],
      [{ docsUrl: "not a url" }, "docsUrl"],
    ] as const) {
      expect(normaliseProposal({ ...PROPOSAL, ...patch })).toMatchObject({
        ok: false,
        reason: "input_invalid",
        details: { field },
      });
    }
    expect(
      normaliseProposal({ ...PROPOSAL, primaryHost: "http://api.acme.example" }),
    ).toMatchObject({
      ok: false,
      reason: "input_invalid",
    });
  });

  it("reads the tool's arguments by shape and says what is wrong", () => {
    expect(readConnectionProposal({ vendor: "acme", scheme: "bearer" })).toEqual({
      error: "vendor, primaryHost and scheme are required",
    });
    expect(readConnectionProposal({ ...PROPOSAL, hosts: "files.acme.example" })).toMatchObject({
      error: expect.stringContaining("hosts must be an array"),
    });
    expect(readConnectionProposal({ ...PROPOSAL, schemeConfig: "x" })).toMatchObject({
      error: expect.stringContaining("schemeConfig must be an object"),
    });
    expect(readConnectionProposal(PROPOSAL)).toEqual(PROPOSAL);
  });

  it("describes every scheme with its parameters and the fields the person enters, from the tables", () => {
    const text = describeSchemes();
    expect(text).toContain(
      "api_key_header (parameters: headerName, optional prefix; the person enters: apiKey)",
    );
    expect(text).toContain("basic (parameters: none; the person enters: username, password)");
    expect(text).toContain(
      "oauth2_client_credentials (parameters: tokenUrl, optional scopes, optional clientAuth; the person enters: clientId, clientSecret)",
    );
    // The client id is the person's to enter, not the agent's to propose (ADR 0005).
    expect(text).toContain(
      "oauth_authorization_code (parameters: authorizeUrl, tokenUrl, optional scopes, optional clientAuth; the person enters: clientId, clientSecret)",
    );
  });

  /** ADR 0005: the agent proposes the endpoints and scopes; the client id it cannot know. */
  it("accepts an authorization-code proposal without a client id, and refuses one without its endpoints", () => {
    const oauth = {
      ...PROPOSAL,
      vendor: "gmail",
      primaryHost: "https://gmail.googleapis.com",
      scheme: "oauth_authorization_code",
      schemeConfig: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
      },
    };
    expect(normaliseProposal(oauth)).toMatchObject({
      ok: true,
      payload: { scheme: "oauth_authorization_code", schemeConfig: oauth.schemeConfig },
    });
    expect(
      normaliseProposal({ ...oauth, schemeConfig: { tokenUrl: oauth.schemeConfig.tokenUrl } }),
    ).toMatchObject({
      ok: false,
      reason: "input_invalid",
      message: expect.stringContaining("authorizeUrl"),
      details: { field: "schemeConfig" },
    });
    expect(
      normaliseProposal({
        ...oauth,
        schemeConfig: { ...oauth.schemeConfig, authorizeUrl: "http://accounts.google.com/auth" },
      }),
    ).toMatchObject({ ok: false, reason: "input_invalid" });
  });

  it("reads an answer that names a connection, and nothing else", () => {
    expect(readConnectionAnswer({ connectionId: "conn_1" })).toEqual({ connectionId: "conn_1" });
    expect(readConnectionAnswer({ allow: true })).toBeNull();
    expect(readConnectionAnswer({ connectionId: "" })).toBeNull();
    expect(readConnectionAnswer(null)).toBeNull();
  });
});

describe("request_connection through a harness", () => {
  it("refuses a private host and a bad proposal with the reason, and records nothing", async () => {
    const a = await connect(TOKEN_A);
    try {
      const metadata = await a.call("request_connection", {
        ...PROPOSAL,
        primaryHost: "https://169.254.169.254",
      });
      expect(metadata.isError).toBe(true);
      expect(body(metadata)).toMatchObject({
        error: "refused",
        reason: "host_not_public",
        host: "169.254.169.254",
        message: expect.stringContaining("not a public host"),
      });
      const missing = await a.call("request_connection", { ...PROPOSAL, schemeConfig: {} });
      expect(body(missing)).toMatchObject({
        error: "refused",
        reason: "input_invalid",
        message: expect.stringContaining("headerName"),
      });
      expect(store.pendingActions.size).toBe(0);
      expect(store.connections.size).toBe(0);
    } finally {
      await a.close();
    }
  });

  it("answers a signed link and a durable proposal, the same link for the same proposal, and connected once the person has entered the secret — for this agent alone", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      const first = await a.call("request_connection", PROPOSAL);
      const { answer: said, action } = awaiting(first, "awaiting_connection");
      expect(action).toMatchObject({
        agentId: AGENT_A,
        kind: CONNECTION_ASK_KIND,
        connectionId: null,
        answeredAt: null,
        payload: {
          provider: "keyring",
          vendor: "acme",
          displayName: "Acme Orders",
          scheme: "api_key_header",
          schemeConfig: { headerName: "x-acme-key" },
          primaryHost: "https://api.acme.example/v2",
          hosts: ["api.acme.example", "files.acme.example"],
          docsUrl: "https://developer.acme.example/auth",
        },
      });
      expect(JSON.stringify(action.payload)).not.toContain("apiKey");
      expect(store.connections.size).toBe(0);
      const token = new URL(said.url as string).searchParams.get(HANDOFF_TOKEN_PARAM);
      expect(verifyHandoff({ token, subject: action, secret: SECRET, now: new Date() })).toEqual({
        ok: true,
      });

      // The same proposal, differently spelt, is the same ask; a different one is a second ask.
      const again = awaiting(
        await a.call("request_connection", {
          ...PROPOSAL,
          primaryHost: "https://api.acme.example/v2",
        }),
        "awaiting_connection",
      );
      expect(again.action.id).toBe(action.id);
      const other = awaiting(
        await a.call("request_connection", { ...PROPOSAL, displayName: "Acme Orders (staging)" }),
        "awaiting_connection",
      );
      expect(other.action.id).not.toBe(action.id);
      expect(actionsOf(AGENT_A, CONNECTION_ASK_KIND)).toHaveLength(2);

      // The person opens the link and enters the key; the console creates the connection.
      const before = await a.toolNames();
      const connection = await submitConnection(action.id, { apiKey: "sk_live_acme_1" });
      expect(connection.credentialSetAt).not.toBeNull();
      expect(JSON.stringify(connection)).not.toContain("sk_live_acme_1");

      const second = await a.call("request_connection", PROPOSAL);
      expect(second.isError).toBeFalsy();
      expect(body(second)).toEqual({
        status: "connected",
        connectionId: connection.id,
        executeTool: executeToolName(connection.id),
        message: expect.stringContaining("Connected"),
      });
      expect(JSON.stringify(body(second))).not.toContain("sk_live_acme_1");
      expect(store.pendingActions.get(action.id)?.consumedAt).not.toBeNull();

      // The requesting agent's list gained the execute tool; the other agent's did not (ADR 0007).
      await until(() => a.listChanged() > 0);
      expect(before).not.toContain(executeToolName(connection.id));
      expect(await a.toolNames()).toContain(executeToolName(connection.id));
      expect(await b.toolNames()).not.toContain(executeToolName(connection.id));
      expect([...(store.agentConnections.get(AGENT_B) ?? [])]).toEqual([]);

      // A third identical call finds the connection in scope and asks nobody.
      const third = await a.call("request_connection", PROPOSAL);
      expect(body(third)).toMatchObject({ status: "connected", connectionId: connection.id });
      expect(actionsOf(AGENT_A, CONNECTION_ASK_KIND)).toHaveLength(2);

      // The execute tool reaches the vendor through the proxy with the key injected, the token stripped.
      store.grantBuild(AGENT_A, connection.id);
      const run = await a.call(executeToolName(connection.id), { command: RUN_LIST_ITEMS });
      expect(run.isError, JSON.stringify(body(run))).toBeFalsy();
      expect(body(run)).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(String(body(run).output))).toEqual(VENDOR_BODY);
      const request = vendor.requests.at(-1);
      expect(request?.url).toBe("https://api.acme.example/v2/items");
      expect(request?.headers.get("x-acme-key")).toBe("sk_live_acme_1");
      expect(request?.headers.get("authorization")).toBeNull();
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("a decline in the console is a refusal that says so, and the next call asks afresh", async () => {
    const a = await connect(TOKEN_A);
    const proposal = {
      ...PROPOSAL,
      vendor: "beta",
      displayName: "Beta",
      primaryHost: "https://api.beta.example",
    };
    try {
      const { action } = awaiting(
        await a.call("request_connection", proposal),
        "awaiting_connection",
      );
      await answerPendingAction(ctx(), principal, action.id, { allow: false }, deps.pendingAction);
      const declined = await a.call("request_connection", proposal);
      expect(declined.isError).toBe(true);
      expect(body(declined)).toMatchObject({
        error: "refused",
        reason: "connection_declined",
        pendingActionId: action.id,
      });
      const fresh = awaiting(await a.call("request_connection", proposal), "awaiting_connection");
      expect(fresh.action.id).not.toBe(action.id);
    } finally {
      await a.close();
    }
  });

  it("an answer inside the wait resumes the call that is waiting", async () => {
    deps.handoff.waitMs = 5_000;
    const a = await connect(TOKEN_A);
    const proposal = {
      ...PROPOSAL,
      vendor: "gamma",
      displayName: "Gamma",
      primaryHost: "https://api.gamma.example",
    };
    try {
      const pending = a.call("request_connection", proposal);
      await until(() =>
        actionsOf(AGENT_A, CONNECTION_ASK_KIND).some((r) => r.payload.vendor === "gamma"),
      );
      const action = actionsOf(AGENT_A, CONNECTION_ASK_KIND).find(
        (r) => r.payload.vendor === "gamma",
      );
      if (!action) throw new Error("no action");
      const connection = await submitConnection(action.id, { apiKey: "k" });
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(body(result)).toMatchObject({ status: "connected", connectionId: connection.id });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("an ask that expires while the call waits is a refusal, and the next call asks afresh", async () => {
    deps.handoff.ttlMs = 30;
    deps.handoff.waitMs = 2_000;
    const a = await connect(TOKEN_A);
    const proposal = {
      ...PROPOSAL,
      vendor: "delta",
      displayName: "Delta",
      primaryHost: "https://api.delta.example",
    };
    try {
      const expired = await a.call("request_connection", proposal);
      expect(expired.isError).toBe(true);
      expect(body(expired)).toMatchObject({
        error: "refused",
        reason: "handoff_expired",
        pendingActionId: expect.any(String),
      });
      const spent = body(expired).pendingActionId as string;
      deps.handoff.ttlMs = 60_000;
      deps.handoff.waitMs = 0;
      const fresh = awaiting(await a.call("request_connection", proposal), "awaiting_connection");
      expect(fresh.action.id).not.toBe(spent);
    } finally {
      await a.close();
    }
  });
});

describe("request_credential through a harness", () => {
  it("refuses a connection outside the scope and one that does not exist", async () => {
    const foreign = store.addConnection({
      id: "conn_foreign",
      personId: PERSON,
      vendor: "foreign",
      primaryHost: "https://api.foreign.example",
    });
    const a = await connect(TOKEN_A);
    try {
      expect(body(await a.call("request_credential", { connectionId: foreign.id }))).toMatchObject({
        error: "refused",
        reason: "connection_not_in_scope",
      });
      store.agentConnections.get(AGENT_A)?.add("conn_missing");
      expect(
        body(await a.call("request_credential", { connectionId: "conn_missing" })),
      ).toMatchObject({
        error: "refused",
        reason: "connection_not_found",
      });
      store.agentConnections.get(AGENT_A)?.delete("conn_missing");
      expect(actionsOf(AGENT_A, CREDENTIAL_ASK_KIND)).toHaveLength(0);
    } finally {
      await a.close();
    }
  });

  it("asks with the connection stamped on the action, replaces the credential and touches no approval, and the execute call then reaches the vendor with the new key", async () => {
    // The connection GRA-28's first test created for agent A, with its approvals in place.
    const connection = [...store.connections.values()].find((row) => row.vendor === "acme");
    if (!connection) throw new Error("no acme connection");
    store.grantBuild(AGENT_A, connection.id);
    const approvalsBefore = JSON.stringify([...store.approvals.values()]);
    const buildsBefore = JSON.stringify([...store.buildApprovals.values()]);
    const a = await connect(TOKEN_A);
    try {
      const first = await a.call("request_credential", {
        connectionId: connection.id,
        reason: "The vendor answered 401 Unauthorized: key revoked",
      });
      const { action } = awaiting(first, "awaiting_credential");
      expect(action).toMatchObject({
        kind: CREDENTIAL_ASK_KIND,
        connectionId: connection.id,
        payload: {
          connectionId: connection.id,
          vendor: "acme",
          connectionName: "Acme Orders",
          scheme: "api_key_header",
          hosts: ["api.acme.example", "files.acme.example"],
          reason: "The vendor answered 401 Unauthorized: key revoked",
          revoked: false,
        },
      });
      // Asking again while it is open is the same ask.
      const again = awaiting(
        await a.call("request_credential", { connectionId: connection.id }),
        "awaiting_credential",
      );
      expect(again.action.id).toBe(action.id);

      await submitCredential(action.id, { apiKey: "sk_live_acme_2" });
      const second = await a.call("request_credential", { connectionId: connection.id });
      expect(second.isError).toBeFalsy();
      expect(body(second)).toMatchObject({
        status: "connected",
        connectionId: connection.id,
        executeTool: executeToolName(connection.id),
      });
      expect(JSON.stringify([...store.approvals.values()])).toBe(approvalsBefore);
      expect(JSON.stringify([...store.buildApprovals.values()])).toBe(buildsBefore);

      store.grantBuild(AGENT_A, connection.id);
      const run = await a.call(executeToolName(connection.id), { command: RUN_LIST_ITEMS });
      expect(run.isError, JSON.stringify(body(run))).toBeFalsy();
      expect(vendor.requests.at(-1)?.headers.get("x-acme-key")).toBe("sk_live_acme_2");
    } finally {
      await a.close();
    }
  }, 60_000);

  it("a revoke closes an open re-entry ask, and the next ask says the connection is revoked", async () => {
    const connection = [...store.connections.values()].find((row) => row.vendor === "acme");
    if (!connection) throw new Error("no acme connection");
    const a = await connect(TOKEN_A);
    try {
      const { action } = awaiting(
        await a.call("request_credential", { connectionId: connection.id }),
        "awaiting_credential",
      );
      const result = await revokeConnection(ctx(), principal, connection.id, deps.connection);
      expect(result?.pendingActionsExpired).toBe(1);
      const closed = store.pendingActions.get(action.id);
      expect(closed?.consumedAt).not.toBeNull();

      const afresh = awaiting(
        await a.call("request_credential", { connectionId: connection.id }),
        "awaiting_credential",
      );
      expect(afresh.action.id).not.toBe(action.id);
      expect(afresh.action.payload).toMatchObject({ revoked: true });

      // The re-entry is the reconnection (ADR 0007): revoked_at clears with the new ciphertext.
      await submitCredential(afresh.action.id, { apiKey: "sk_live_acme_3" });
      expect(store.connections.get(connection.id)?.revokedAt).toBeNull();
      expect(
        body(await a.call("request_credential", { connectionId: connection.id })),
      ).toMatchObject({
        status: "connected",
      });
    } finally {
      await a.close();
    }
  });
});

/**
 * The authorization-code shape of `request_connection` (ADR 0005), as far as the MCP side goes: the
 * awaiting answer carries the redirect URI the person pastes into the client they register and a
 * message that guides them, and a connection whose consent has not completed is not "already
 * connected". The consent itself is HTTP and lives in `apps/server/src/oauth.test.ts`.
 */
describe("request_connection with the OAuth shape", () => {
  const GMAIL = {
    vendor: "gmail",
    displayName: "Gmail",
    primaryHost: "https://gmail.googleapis.com",
    scheme: "oauth_authorization_code",
    schemeConfig: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    },
    docsUrl: "https://developers.google.com/gmail/api/auth/scopes",
  };

  it("answers the handoff link with the redirect URI and the guidance, and does not read a consent still pending as connected", async () => {
    const a = await connect(TOKEN_A);
    try {
      const first = body(await a.call("request_connection", GMAIL));
      expect(first).toMatchObject({
        error: "awaiting_connection",
        redirectUri: "http://graft.test/api/oauth/callback",
        pendingActionId: expect.any(String),
      });
      const message = String(first.message);
      expect(message).toContain("http://graft.test/api/oauth/callback");
      expect(message).toContain("developer console");
      expect(message).toContain("seven days");
      const action = store.pendingActions.get(first.pendingActionId as string);
      expect(action?.payload).toMatchObject({
        scheme: "oauth_authorization_code",
        schemeConfig: GMAIL.schemeConfig,
        hosts: ["gmail.googleapis.com"],
      });

      // The person entered the client id and secret; the consent has not run. Not connected yet.
      const connection = await registerConnectionWithCredential(
        { db: deps.db },
        { personId: PERSON },
        {
          vendor: "gmail",
          displayName: "Gmail",
          scheme: "oauth_authorization_code",
          schemeConfig: { ...GMAIL.schemeConfig, clientId: "client-id" },
          primaryHost: "https://gmail.googleapis.com",
          credential: { clientSecret: "client-secret" },
        },
        deps.connection,
      );
      await addConnectionToAgentScope(
        { db: deps.db },
        { personId: PERSON },
        AGENT_A,
        connection.id,
        deps.agent,
      );
      const again = body(await a.call("request_connection", GMAIL));
      expect(again).toMatchObject({
        error: "awaiting_connection",
        pendingActionId: first.pendingActionId,
      });

      // The callback answers the ask once the tokens are stored (apps/server); the call then connects.
      await answerPendingAction(
        { db: deps.db },
        { personId: PERSON },
        first.pendingActionId as string,
        { connectionId: connection.id },
        deps.pendingAction,
      );
      const third = await a.call("request_connection", GMAIL);
      expect(third.isError).toBeFalsy();
      expect(body(third)).toMatchObject({ status: "connected", connectionId: connection.id });
      expect(JSON.stringify(body(third))).not.toContain("client-secret");
    } finally {
      await a.close();
    }
  });

  it("a key-shaped proposal carries no redirect URI", async () => {
    const a = await connect(TOKEN_B);
    try {
      const said = body(
        await a.call("request_connection", {
          ...PROPOSAL,
          vendor: "beta",
          primaryHost: "https://api.beta.example",
          hosts: [],
        }),
      );
      expect(said).toMatchObject({ error: "awaiting_connection" });
      expect(said).not.toHaveProperty("redirectUri");
      expect(String(said.message)).not.toContain("developer console");
    } finally {
      await a.close();
    }
  });
});

/**
 * The proposal is routed to a provider (ADR 0019). With the keyring alone every answer above is
 * what it was before providers existed — those tests pin it. A provider that connects some other
 * way, covering the vendor first, is refused by name until its ticket gives it a flow; nothing is
 * asked of the person and nothing is recorded.
 */
describe("request_connection routes a proposal to the provider that covers it", () => {
  const broker: ConnectionProvider = {
    name: "broker",
    connect: { kind: "link" },
    covers: (vendor) => vendor === "acme",
    resolve: () => ({
      mode: "relay",
      relay: {
        plugin: {
          kind: "relay",
          scheme: "fake_relay",
          rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
          relay: () => undefined,
          headerNames: () => [],
        },
        obtain: async () => ({}),
      },
    }),
    revoke: async () => undefined,
  };
  const original = () => deps.connection;

  afterEach(() => {
    deps.connection = { ...deps.connection, providers: [keyringProvider] };
  });

  it("refuses a proposal a link provider covers, naming the provider, and records no ask", async () => {
    const before = original();
    deps.connection = { ...before, providers: [broker, keyringProvider] };
    const a = await connect(TOKEN_B);
    try {
      const asks = actionsOf(AGENT_B, CONNECTION_ASK_KIND).length;
      const said = await a.call("request_connection", PROPOSAL);
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({
        reason: "provider_not_supported",
        provider: "broker",
        connect: "link",
        message: expect.stringContaining("the broker provider"),
      });
      expect(actionsOf(AGENT_B, CONNECTION_ASK_KIND)).toHaveLength(asks);

      // A vendor the broker does not cover falls to the keyring and gets the form, as ever.
      const other = body(
        await a.call("request_connection", {
          ...PROPOSAL,
          vendor: "gamma",
          primaryHost: "https://api.gamma.example",
          hosts: [],
        }),
      );
      expect(other).toMatchObject({ error: "awaiting_connection" });
      const action = store.pendingActions.get(other.pendingActionId as string);
      expect(action?.payload).toMatchObject({ provider: "keyring", vendor: "gamma" });
    } finally {
      await a.close();
    }
  });

  it("request_credential refuses a connection a relay provider holds — there is nothing here to re-enter", async () => {
    const before = original();
    deps.connection = { ...before, providers: [broker, keyringProvider] };
    const row = store.addConnection({
      id: "conn_broker",
      personId: PERSON,
      vendor: "acme",
      displayName: "Acme via broker",
      primaryHost: "https://api.acme.example",
    });
    store.connections.set(row.id, { ...row, provider: "broker", providerRef: "acct_1" });
    store.agentConnections.get(AGENT_B)?.add(row.id);
    const a = await connect(TOKEN_B);
    try {
      const said = await a.call("request_credential", { connectionId: row.id });
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({
        reason: "credential_not_applicable",
        provider: "broker",
      });
      expect(actionsOf(AGENT_B, CREDENTIAL_ASK_KIND)).toHaveLength(0);
    } finally {
      await a.close();
      store.connections.delete(row.id);
      store.agentConnections.get(AGENT_B)?.delete(row.id);
    }
  });
});
