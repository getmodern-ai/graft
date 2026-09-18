import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addConnectionToAgentScope,
  answerPendingAction,
  type ConnectionProvider,
  connectThroughProvider,
  createGatewayProvider,
  grantBuildApproval,
  keyringProvider,
  registerConnectionWithCredential,
  revokeConnection,
  setConnectionCredential,
  toProxyConnection,
} from "@graft/core";
import type { ConnectionRow } from "@graft/db/repo/connection";
import { createScriptedModel } from "@graft/model";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { sandboxPath } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BUILD_APPROVAL_ON_THE_PAGE,
  CONNECTION_ASK_KIND,
  CONNECTION_EXISTS,
  type ConnectionProposalPayload,
  CREDENTIAL_ASK_KIND,
  coversProposal,
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
      // Through the deployment's providers, so a gateway row made mid-test relays (ADR 0019).
      return row ? toProxyConnection(row, deps.connection.providers) : null;
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

/**
 * What the console's submit route does for a `connection` ask: create, add to the agent's scope,
 * grant the build approval when the person left the control on (GRA-75), record.
 */
async function submitConnection(
  actionId: string,
  credential: Record<string, string>,
  choices: { approveBuild?: boolean } = {},
) {
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
  if (choices.approveBuild) {
    await grantBuildApproval(
      ctx(),
      { personId: PERSON, agentId: action.agentId },
      connection.id,
      deps.approval,
    );
  }
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
    expect(text).toContain("none (parameters: none; the person enters: nothing)");
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
        provider: "keyring",
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

/**
 * GRA-75 (ADR 0008, amendment of 2026-09-18): the person may grant the build approval on the
 * connection page, and the agent's first `acquire` then starts without a handoff; left off, the
 * ask is exactly what it was. A scripted model with no steps stands in for a configured one — the
 * door is what is under test, and no runner is attached, so the job stays queued.
 */
describe("the connection confirmation and the build approval (GRA-75)", () => {
  it("the awaiting answer says the page offers the build approval, so the agent promises no second link", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = awaiting(
        await a.call("request_connection", {
          ...PROPOSAL,
          vendor: "buildco",
          displayName: "Buildco",
          primaryHost: "https://api.buildco.example",
        }),
        "awaiting_connection",
      );
      expect(said.answer.message).toContain(BUILD_APPROVAL_ON_THE_PAGE);
      expect(BUILD_APPROVAL_ON_THE_PAGE).toContain("without a second link");
    } finally {
      await a.close();
    }
  });

  it("propose, confirm with the approval on, and acquire answers a jobId at once; confirmed with it off, acquire still asks", async () => {
    deps.model = createScriptedModel([]);
    const a = await connect(TOKEN_A);
    try {
      const ticked = {
        ...PROPOSAL,
        vendor: "ticked",
        displayName: "Ticked",
        primaryHost: "https://api.ticked.example",
        hosts: [],
      };
      const first = awaiting(await a.call("request_connection", ticked), "awaiting_connection");
      const connection = await submitConnection(
        first.action.id,
        { apiKey: "k1" },
        {
          approveBuild: true,
        },
      );
      expect(body(await a.call("request_connection", ticked))).toMatchObject({
        status: "connected",
        connectionId: connection.id,
      });
      const started = await a.call("acquire", { connectionId: connection.id, goal: "List things" });
      expect(started.isError).toBeFalsy();
      expect(body(started)).toMatchObject({ jobId: expect.any(String), status: "queued" });
      expect(actionsOf(AGENT_A, "build")).toEqual([]);

      const plain = {
        ...ticked,
        vendor: "plain",
        displayName: "Plain",
        primaryHost: "https://api.plain.example",
      };
      const second = awaiting(await a.call("request_connection", plain), "awaiting_connection");
      const other = await submitConnection(second.action.id, { apiKey: "k2" });
      expect(body(await a.call("request_connection", plain))).toMatchObject({
        status: "connected",
      });
      const asked = await a.call("acquire", { connectionId: other.id, goal: "List things" });
      expect(asked.isError).toBe(true);
      expect(body(asked)).toMatchObject({
        error: "awaiting_approval",
        pendingActionId: expect.any(String),
      });
      expect(actionsOf(AGENT_A, "build")).toHaveLength(1);
    } finally {
      deps.model = null;
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
        provider: "keyring",
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
 * A proposal is routed to the first provider that covers it (ADR 0019). A provider that connects
 * with a **link** (GRA-59) takes the same ask with the link's payload and no form: the person
 * presses one button, the provider's page runs the sign-in, and the server's return route makes
 * the connection and answers the ask — played here by the same core calls
 * (`apps/server/src/provider-link.ts` is the HTTP half). A provider with no person step (GRA-58) is
 * still refused by name until its ticket gives it a flow.
 */
describe("request_connection routes a proposal to the provider that covers it", () => {
  const fakeRelay = {
    kind: "relay" as const,
    scheme: "pipedream_connect_proxy",
    rules: { prefix: null, passThrough: [], refuse: [], refusePrefixes: [] },
    relay: () => undefined,
    headerNames: () => [],
  };
  const started: string[] = [];
  const broker: ConnectionProvider = {
    name: "broker",
    connect: {
      kind: "link",
      scheme: "pipedream_connect_proxy",
      target: (vendor) => (vendor === "acme" ? "acme_app" : null),
      start: async (input) => {
        started.push(input.returnTo.success);
        return {
          url: "https://broker.example/link?token=ctok_1",
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      complete: async () => ({ ok: true, ref: "acct_1", label: "ops@acme.example" }),
    },
    covers: (vendor) => vendor === "acme",
    resolve: (row) => ({
      mode: "relay",
      relay: { plugin: fakeRelay, obtain: async () => ({ accountId: row.providerRef ?? "" }) },
    }),
    revoke: async () => undefined,
  };

  /**
   * GRA-28's acme row — agent A's, under the keyring — is set aside for this suite: with it present,
   * agent B's proposal for acme is `connection_exists` (GRA-76, the last suite here), and this
   * suite is about where a proposal is routed.
   */
  const setAside = new Map<string, ConnectionRow>();
  beforeEach(() => {
    for (const [id, row] of store.connections) {
      if (row.vendor === "acme" && row.provider === "keyring") {
        setAside.set(id, row);
        store.connections.delete(id);
      }
    }
  });

  afterEach(() => {
    for (const [id, row] of setAside) store.connections.set(id, row);
    setAside.clear();
    deps.connection = { ...deps.connection, providers: [keyringProvider] };
    started.length = 0;
  });

  /** What the server's return route does once the provider confirmed the account (`provider-link.ts`). */
  async function completeLink(actionId: string) {
    const action = store.pendingActions.get(actionId);
    if (!action) throw new Error(`no action ${actionId}`);
    const payload = action.payload as unknown as ConnectionProposalPayload;
    const connection = await connectThroughProvider(
      ctx(),
      principal,
      {
        provider: broker,
        vendor: payload.vendor,
        displayName: payload.displayName,
        primaryHost: payload.primaryHost,
        hosts: payload.hosts,
        ref: "acct_1",
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

  it("a proposal a link provider covers is an ask with the link's payload and the provider named in the answer — no form, no redirect URI — and the return connects it for this agent", async () => {
    deps.connection = { ...deps.connection, providers: [broker, keyringProvider] };
    const a = await connect(TOKEN_B);
    try {
      const first = await a.call("request_connection", PROPOSAL);
      const { answer, action } = awaiting(first, "awaiting_connection");
      expect(answer.provider).toBe("broker");
      expect(answer.redirectUri).toBeUndefined();
      expect(answer.message).toContain("through broker");
      expect(answer.message).toContain("one click");
      expect(answer.message).not.toContain("client");
      expect(action.payload).toMatchObject({
        provider: "broker",
        providerConnect: "link",
        providerTarget: "acme_app",
        note: expect.stringContaining("relayed to every host listed"),
        vendor: "acme",
        displayName: "Acme Orders",
        primaryHost: "https://api.acme.example/v2",
        hosts: ["api.acme.example", "files.acme.example"],
      });
      // The same proposal is the same ask; nothing is minted here — the console's button mints.
      const again = awaiting(await a.call("request_connection", PROPOSAL), "awaiting_connection");
      expect(again.action.id).toBe(action.id);
      expect(started).toEqual([]);

      const connection = await completeLink(action.id);
      expect(connection).toMatchObject({
        provider: "broker",
        vendor: "acme",
        scheme: "pipedream_connect_proxy",
        credentialSetAt: null,
        revokedAt: null,
      });
      expect(store.connections.get(connection.id)?.providerRef).toBe("acct_1");
      expect(store.connections.get(connection.id)?.credentialCiphertext).toBeNull();

      const done = await a.call("request_connection", PROPOSAL);
      expect(done.isError).toBeFalsy();
      expect(body(done)).toMatchObject({
        status: "connected",
        connectionId: connection.id,
        executeTool: executeToolName(connection.id),
      });
      expect(await a.toolNames()).toContain(executeToolName(connection.id));
      // Connected by existing: a later call finds it usable and asks nobody.
      const asks = actionsOf(AGENT_B, CONNECTION_ASK_KIND).length;
      expect(body(await a.call("request_connection", PROPOSAL))).toMatchObject({
        status: "connected",
        connectionId: connection.id,
      });
      expect(actionsOf(AGENT_B, CONNECTION_ASK_KIND)).toHaveLength(asks);

      // A vendor the broker does not cover falls to the keyring and gets the form, as ever. (Not
      // gamma: an earlier suite connected gamma for agent A, and a proposal for a row another
      // agent holds is `connection_exists` since GRA-76.)
      const other = body(
        await a.call("request_connection", {
          ...PROPOSAL,
          vendor: "theta",
          primaryHost: "https://api.theta.example",
          hosts: [],
        }),
      );
      expect(other).toMatchObject({ error: "awaiting_connection" });
      const formAsk = store.pendingActions.get(other.pendingActionId as string);
      expect(formAsk?.payload).toMatchObject({
        provider: "keyring",
        providerConnect: "form",
        providerTarget: null,
        vendor: "theta",
      });
    } finally {
      await a.close();
      for (const [id, row] of store.connections) {
        if (row.provider === "broker") {
          store.connections.delete(id);
          store.agentConnections.get(AGENT_B)?.delete(id);
        }
      }
    }
  });

  it("refuses a proposal naming a relay scheme — a provider's, never the agent's to propose", async () => {
    const a = await connect(TOKEN_B);
    try {
      const said = await a.call("request_connection", {
        ...PROPOSAL,
        scheme: "pipedream_connect_proxy",
      });
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({ reason: "input_invalid", field: "scheme" });
      expect(describeSchemes()).not.toContain("pipedream_connect_proxy");
    } finally {
      await a.close();
    }
  });

  it("a none connection is connected as soon as the person confirms it, with nothing entered (GRA-66)", async () => {
    const proposal = {
      vendor: "open-meteo",
      displayName: "Open-Meteo",
      primaryHost: "https://api.open-meteo.example/v1",
      scheme: "none",
      docsUrl: "https://open-meteo.example/docs",
    };
    const credentialAsksBefore = actionsOf(AGENT_A, CREDENTIAL_ASK_KIND).length;
    const a = await connect(TOKEN_A);
    try {
      const first = await a.call("request_connection", proposal);
      const { answer, action } = awaiting(first, "awaiting_connection");
      expect(action.payload).toMatchObject({ scheme: "none", schemeConfig: {} });
      // The message says what the person does — checks the hosts, confirms — and names no
      // credential or secret, since there is none to enter (GRA-91); the build sentence stays.
      const message = String(answer.message);
      expect(message).toContain("confirm the connection to Open-Meteo (open-meteo)");
      expect(message).toContain("takes no credential, so nothing is entered");
      expect(message).toContain("check the hosts and confirm it");
      expect(message).toContain(BUILD_APPROVAL_ON_THE_PAGE);
      expect(message).not.toContain("enter the credential");
      expect(message).not.toContain("secret");

      // The console's form shows no secret input; the submit carries an empty credential.
      const connection = await submitConnection(action.id, {});
      expect(connection.credentialSetAt).toBeNull();
      expect(connection.scheme).toBe("none");

      const second = await a.call("request_connection", proposal);
      expect(second.isError).toBeFalsy();
      expect(body(second)).toMatchObject({ status: "connected", connectionId: connection.id });

      // Nothing to re-enter, and the call says so rather than opening an ask.
      const said = await a.call("request_credential", { connectionId: connection.id });
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({ reason: "credential_not_applicable" });
      expect((body(said) as { message: string }).message).toContain("none scheme");
      expect(actionsOf(AGENT_A, CREDENTIAL_ASK_KIND)).toHaveLength(credentialAsksBefore);
    } finally {
      await a.close();
    }
  });

  it("request_credential refuses a connection a relay provider holds — there is nothing here to re-enter", async () => {
    deps.connection = { ...deps.connection, providers: [broker, keyringProvider] };
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

  it("a revoked row of a link provider takes a new ask: the link's return reconnects it in place (GRA-76)", async () => {
    deps.connection = { ...deps.connection, providers: [broker, keyringProvider] };
    const row = store.addConnection({
      id: "conn_broker_revoked",
      personId: PERSON,
      vendor: "acme",
      displayName: "Acme via broker",
      primaryHost: "https://api.acme.example/v2",
      hosts: ["files.acme.example"],
    });
    store.connections.set(row.id, {
      ...row,
      provider: "broker",
      providerRef: null,
      credentialSetAt: null,
      revokedAt: new Date(),
    });
    store.agentConnections.get(AGENT_B)?.add(row.id);
    const a = await connect(TOKEN_B);
    try {
      const { action } = awaiting(
        await a.call("request_connection", PROPOSAL),
        "awaiting_connection",
      );
      expect(action.payload).toMatchObject({ provider: "broker", providerConnect: "link" });
    } finally {
      await a.close();
      store.connections.delete(row.id);
      store.agentConnections.get(AGENT_B)?.delete(row.id);
      for (const [id, pending] of store.pendingActions) {
        if (pending.agentId === AGENT_B && pending.kind === CONNECTION_ASK_KIND) {
          store.pendingActions.delete(id);
        }
      }
    }
  });
});

/**
 * The gateway provider's connect (ADR 0019, GRA-58): a vendor the deployment's API gateway covers
 * connects with no person step — the row made, the agent's scope grown, `connected` answered, no ask
 * — and an execute call then relays through the gateway with the identity header and the vendor URL
 * in the path. The two refusals that keep the person's decisions theirs, and the fall-through to the
 * keyring for a vendor the gateway does not cover, are here too. The fake vendor's injected fetch
 * records what left the proxy, so the gateway is never actually reached in this suite; the relay's
 * own wire is `@graft/proxy`'s `gateway-relay.test.ts`.
 */
describe("request_connection through the gateway provider (GRA-58)", () => {
  const GATEWAY_URL = "https://gateway.corp.example/graft";
  const IDENTITY = "deployment-identity-secret-value";
  const gateway = createGatewayProvider({
    hosts: ["api.unleashed.example", "files.unleashed.example"],
    upstreamUrl: GATEWAY_URL,
    headerName: "X-Deployment-Token",
    headerValue: IDENTITY,
  });
  const COVERED = {
    vendor: "unleashed",
    displayName: "Acme Unleashed",
    primaryHost: "https://api.unleashed.example",
    hosts: ["files.unleashed.example"],
    scheme: "api_key_header",
    schemeConfig: { headerName: "api-auth-id" },
    docsUrl: "https://apidocs.unleashed.example/",
  };
  const made: string[] = [];

  beforeEach(() => {
    deps.connection = { ...deps.connection, providers: [gateway, keyringProvider] };
  });

  afterEach(() => {
    deps.connection = { ...deps.connection, providers: [keyringProvider] };
    for (const id of made) {
      store.connections.delete(id);
      for (const scope of store.agentConnections.values()) scope.delete(id);
    }
    made.length = 0;
  });

  const rowsFor = (vendor: string) =>
    [...store.connections.values()].filter((row) => row.vendor === vendor);

  it("connects a covered vendor with no person step — the row under the gateway with no credential, in this agent's scope alone, no ask — and relays the execute call through the gateway", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      const asksBefore = store.pendingActions.size;
      const said = await a.call("request_connection", COVERED);
      expect(said.isError, JSON.stringify(body(said))).toBeFalsy();
      const answer = body(said);
      expect(answer).toMatchObject({
        status: "connected",
        provider: "gateway",
        connectionId: expect.any(String),
        message: expect.stringContaining("no person step"),
      });
      const id = answer.connectionId as string;
      made.push(id);
      expect(store.pendingActions.size).toBe(asksBefore);

      const row = store.connections.get(id);
      expect(row).toMatchObject({
        provider: "gateway",
        providerRef: null,
        scheme: "gateway",
        schemeConfig: {},
        vendor: "unleashed",
        displayName: "Acme Unleashed",
        primaryHost: "https://api.unleashed.example",
        hosts: ["api.unleashed.example", "files.unleashed.example"],
        credentialCiphertext: null,
        credentialSetAt: null,
        revokedAt: null,
      });
      expect(store.agentConnections.get(AGENT_A)?.has(id)).toBe(true);
      expect(store.agentConnections.get(AGENT_B)?.has(id)).toBe(false);
      await until(() => a.listChanged() > 0);
      expect(await a.toolNames()).toContain(executeToolName(id));
      expect(await b.toolNames()).not.toContain(executeToolName(id));

      // The execute call reaches the proxy, which relays: the gateway's URL with the vendor URL in
      // the path, the identity header attached, the capability token nowhere.
      store.grantBuild(AGENT_A, id);
      const run = await a.call(executeToolName(id), { command: RUN_LIST_ITEMS });
      expect(run.isError, JSON.stringify(body(run))).toBeFalsy();
      expect(JSON.parse(String(body(run).output))).toEqual(VENDOR_BODY);
      const request = vendor.requests.at(-1);
      expect(request?.url).toBe(`${GATEWAY_URL}/api.unleashed.example/items`);
      expect(request?.headers.get("x-deployment-token")).toBe(IDENTITY);
      expect(request?.headers.get("authorization")).toBeNull();
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "forwarded",
        relay: "gateway",
        host: "api.unleashed.example",
        path: "/items",
        connectionId: id,
      });

      // Asked again, the same agent finds it in scope and asks nobody.
      const again = body(await a.call("request_connection", COVERED));
      expect(again).toMatchObject({ status: "connected", connectionId: id, provider: "gateway" });
      expect(again.message).toContain("already connected");
      expect(rowsFor("unleashed")).toHaveLength(1);

      // A later proposal naming one more covered host widens the same row rather than answering
      // with one that cannot reach it (Greptile on #45); one the gateway does not cover is the
      // keyring's, as ever, and the row is untouched.
      deps.connection = {
        ...deps.connection,
        providers: [
          createGatewayProvider({
            hosts: ["api.unleashed.example", "files.unleashed.example", "cdn.unleashed.example"],
            upstreamUrl: GATEWAY_URL,
            headerName: "X-Deployment-Token",
            headerValue: IDENTITY,
          }),
          keyringProvider,
        ],
      };
      // A session opened before the providers changed reads the list it was opened with; a fresh one
      // sees the wider coverage, as a harness reconnecting after a redeploy would.
      const c = await connect(TOKEN_A);
      const wider = body(
        await c.call("request_connection", {
          ...COVERED,
          hosts: ["files.unleashed.example", "CDN.unleashed.example"],
        }),
      );
      await c.close();
      expect(wider).toMatchObject({ status: "connected", connectionId: id, provider: "gateway" });
      expect(wider.message).toContain("now also reaches");
      expect(store.connections.get(id)?.hosts).toEqual([
        "api.unleashed.example",
        "files.unleashed.example",
        "cdn.unleashed.example",
      ]);
      expect(rowsFor("unleashed")).toHaveLength(1);
      expect(store.pendingActions.size).toBe(asksBefore);
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("refuses to grow another agent's scope by itself, and to undo a revoke: both name the console step", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      const id = body(await a.call("request_connection", COVERED)).connectionId as string;
      made.push(id);

      // Agent B: the person has not given it this connection; the scope picker is theirs.
      const other = await b.call("request_connection", COVERED);
      expect(other.isError).toBe(true);
      expect(body(other)).toMatchObject({
        reason: "connection_not_in_scope",
        connectionId: id,
        provider: "gateway",
        message: expect.stringContaining("under Scope"),
      });
      expect(store.agentConnections.get(AGENT_B)?.has(id)).toBe(false);
      expect(rowsFor("unleashed")).toHaveLength(1);

      // The person revokes it; the agent that had it cannot connect it back.
      await revokeConnection(ctx(), principal, id, deps.connection);
      const revoked = await a.call("request_connection", COVERED);
      expect(revoked.isError).toBe(true);
      expect(body(revoked)).toMatchObject({
        reason: "connection_revoked",
        connectionId: id,
        message: expect.stringContaining("Reconnect"),
      });
      expect(rowsFor("unleashed")).toHaveLength(1);
      expect(store.connections.get(id)?.revokedAt).not.toBeNull();
      // And the proxy resolves the revoked row to nothing it can relay through.
      expect(
        toProxyConnection(store.connections.get(id) as never, deps.connection.providers).relay,
      ).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("a vendor the gateway does not cover — or covers only in part — takes the keyring's form, as ever", async () => {
    const a = await connect(TOKEN_A);
    try {
      const uncovered = body(
        await a.call("request_connection", {
          ...COVERED,
          vendor: "zeta",
          primaryHost: "https://api.zeta.example",
          hosts: [],
        }),
      );
      expect(uncovered).toMatchObject({ error: "awaiting_connection" });
      expect(store.pendingActions.get(uncovered.pendingActionId as string)?.payload).toMatchObject({
        provider: "keyring",
        vendor: "zeta",
      });

      // One host outside the gateway's routes and the whole proposal is the keyring's.
      const partly = body(
        await a.call("request_connection", {
          ...COVERED,
          hosts: ["files.unleashed.example", "cdn.other.example"],
        }),
      );
      expect(partly).toMatchObject({ error: "awaiting_connection" });
      expect(store.pendingActions.get(partly.pendingActionId as string)?.payload).toMatchObject({
        provider: "keyring",
        vendor: "unleashed",
      });
      expect(rowsFor("unleashed")).toHaveLength(0);
    } finally {
      await a.close();
    }
  });

  it("a relay scheme is never one an agent may propose", async () => {
    const a = await connect(TOKEN_A);
    try {
      const said = await a.call("request_connection", { ...COVERED, scheme: "gateway" });
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({
        reason: "input_invalid",
        message: expect.stringContaining("Unknown scheme"),
      });
      expect(rowsFor("unleashed")).toHaveLength(0);
    } finally {
      await a.close();
    }
  });
});

/**
 * A build approval stays with the connection row (ADR 0008 as amended 2026-09-18; GRA-76), so a
 * proposal for a vendor and hosts the person already has is answered with that row and the step
 * that keeps it, never a second ask. One row in four states, through the harness — live with its
 * credential, live without it, revoked, and live but another agent's — and the host rule: a row
 * reaching more than proposed covers it, one reaching less does not. Every refusal here is
 * `connection_exists` with the row named, and records nothing.
 */
describe("request_connection finds the connection the person already has (GRA-76)", () => {
  const DELTA = {
    vendor: "delta",
    displayName: "Delta Books",
    primaryHost: "https://api.delta.example/v1",
    hosts: ["files.delta.example"],
    scheme: "api_key_header",
    schemeConfig: { headerName: "x-delta-key" },
  };
  const made: string[] = [];

  /** A keyring row for Delta as the console would have made it, with the given columns changed. */
  function deltaRow(id: string, changes: Partial<ConnectionRow> = {}): ConnectionRow {
    const base = store.addConnection({
      id,
      personId: PERSON,
      vendor: "delta",
      displayName: "Delta Books",
      primaryHost: "https://api.delta.example/v1",
      hosts: ["files.delta.example"],
      schemeConfig: { headerName: "x-delta-key" },
    });
    const row = { ...base, ...changes };
    store.connections.set(id, row);
    made.push(id);
    return row;
  }

  afterEach(() => {
    for (const id of made) {
      store.connections.delete(id);
      for (const scope of store.agentConnections.values()) scope.delete(id);
    }
    made.length = 0;
    for (const [id, pending] of store.pendingActions) {
      if (pending.kind === CONNECTION_ASK_KIND && pending.payload.vendor === "delta") {
        store.pendingActions.delete(id);
      }
    }
  });

  const asksFor = (vendor: string) =>
    [...store.pendingActions.values()].filter(
      (row) => row.kind === CONNECTION_ASK_KIND && row.payload.vendor === vendor,
    );

  it("matches hosts as the proxy does: the proposal's set within the row's, lower-case, the primary's hostname among them", () => {
    const row = {
      vendor: "delta",
      primaryHost: "https://api.delta.example/v1",
      hosts: ["api.delta.example", "Files.Delta.example"],
    };
    const proposal = (primaryHost: string, hosts: string[]) => ({
      vendor: "delta",
      primaryHost,
      hosts,
    });
    expect(
      coversProposal(row, proposal("https://api.delta.example/v1", ["files.delta.example"])),
    ).toBe(true);
    // A narrower proposal, a different path, a port: the same hostnames, so covered.
    expect(coversProposal(row, proposal("https://api.delta.example/v2", []))).toBe(true);
    expect(
      coversProposal(row, proposal("https://API.delta.example:443", ["FILES.delta.example"])),
    ).toBe(true);
    // A wider one is not, and neither is another vendor at the same hosts.
    expect(
      coversProposal(row, proposal("https://api.delta.example/v1", ["cdn.delta.example"])),
    ).toBe(false);
    expect(
      coversProposal({ ...row, vendor: "epsilon" }, proposal("https://api.delta.example/v1", [])),
    ).toBe(false);
  });

  it("a live row with its credential, in scope, answers connected — for a narrower proposal too — and a wider proposal is a new ask", async () => {
    const row = deltaRow("conn_delta_live");
    store.agentConnections.get(AGENT_A)?.add(row.id);
    const a = await connect(TOKEN_A);
    try {
      expect(body(await a.call("request_connection", DELTA))).toMatchObject({
        status: "connected",
        connectionId: row.id,
        message: expect.stringContaining("already connected"),
      });
      expect(
        body(
          await a.call("request_connection", {
            ...DELTA,
            primaryHost: "https://api.delta.example/v2",
            hosts: [],
          }),
        ),
      ).toMatchObject({ status: "connected", connectionId: row.id });
      expect(asksFor("delta")).toHaveLength(0);

      // A host the row does not reach: the row does not cover it, and the ask is for the wider row.
      const wider = await a.call("request_connection", {
        ...DELTA,
        hosts: ["files.delta.example", "cdn.delta.example"],
      });
      awaiting(wider, "awaiting_connection");
      expect(asksFor("delta")).toHaveLength(1);
    } finally {
      await a.close();
    }
  });

  it("a live row whose credential is missing, in scope, is connection_exists pointing at request_credential — which then asks", async () => {
    const row = deltaRow("conn_delta_bare", { credentialSetAt: null });
    store.agentConnections.get(AGENT_A)?.add(row.id);
    const a = await connect(TOKEN_A);
    try {
      const said = await a.call("request_connection", DELTA);
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({
        error: "refused",
        reason: CONNECTION_EXISTS,
        connectionId: row.id,
        provider: "keyring",
        revoked: false,
        inScope: true,
      });
      const message = String(body(said).message);
      expect(message).toContain(`request_credential { connectionId: "${row.id}" }`);
      expect(message).toContain("no scope and no approvals");
      expect(message).not.toContain("Reconnect");
      expect(asksFor("delta")).toHaveLength(0);

      // The path it names works: the re-entry ask, on this row.
      const { action } = awaiting(
        await a.call("request_credential", { connectionId: row.id }),
        "awaiting_credential",
      );
      expect(action.connectionId).toBe(row.id);
      store.pendingActions.delete(action.id);
    } finally {
      await a.close();
    }
  });

  it("a revoked row is connection_exists pointing at the console's Reconnect — and at request_credential when it is in scope", async () => {
    const row = deltaRow("conn_delta_revoked", { credentialSetAt: null, revokedAt: new Date() });
    store.agentConnections.get(AGENT_A)?.add(row.id);
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      const mine = body(await a.call("request_connection", DELTA));
      expect(mine).toMatchObject({
        reason: CONNECTION_EXISTS,
        connectionId: row.id,
        revoked: true,
        inScope: true,
      });
      expect(String(mine.message)).toContain("Reconnect");
      expect(String(mine.message)).toContain(`request_credential { connectionId: "${row.id}" }`);

      // Another agent: the same row, the console's Reconnect and the scope picker, no request_credential.
      const theirs = body(await b.call("request_connection", DELTA));
      expect(theirs).toMatchObject({
        reason: CONNECTION_EXISTS,
        connectionId: row.id,
        revoked: true,
        inScope: false,
      });
      expect(String(theirs.message)).toContain("Reconnect");
      expect(String(theirs.message)).toContain("under Scope");
      expect(String(theirs.message)).not.toContain("request_credential");
      expect(asksFor("delta")).toHaveLength(0);
      expect(store.connections.get(row.id)?.revokedAt).not.toBeNull();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a live usable row this agent was not given is connection_exists pointing at the scope picker, and grows no scope", async () => {
    const row = deltaRow("conn_delta_theirs");
    store.agentConnections.get(AGENT_A)?.add(row.id);
    const b = await connect(TOKEN_B);
    try {
      const said = await b.call("request_connection", DELTA);
      expect(said.isError).toBe(true);
      expect(body(said)).toMatchObject({
        reason: CONNECTION_EXISTS,
        connectionId: row.id,
        revoked: false,
        inScope: false,
      });
      expect(String(body(said).message)).toContain("under Scope");
      expect(String(body(said).message)).toContain("not proposed here");
      expect(store.agentConnections.get(AGENT_B)?.has(row.id)).toBe(false);
      expect(asksFor("delta")).toHaveLength(0);
      expect(await b.toolNames()).not.toContain(executeToolName(row.id));
    } finally {
      await b.close();
    }
  });

  it("prefers the live row to the revoked one, and this agent's to another's, when several cover the proposal", async () => {
    const revoked = deltaRow("conn_delta_old", { revokedAt: new Date() });
    const live = deltaRow("conn_delta_new", { credentialSetAt: null });
    store.agentConnections.get(AGENT_A)?.add(revoked.id);
    store.agentConnections.get(AGENT_A)?.add(live.id);
    const a = await connect(TOKEN_A);
    try {
      expect(body(await a.call("request_connection", DELTA))).toMatchObject({
        reason: CONNECTION_EXISTS,
        connectionId: live.id,
        revoked: false,
      });
    } finally {
      await a.close();
    }
  });
});
