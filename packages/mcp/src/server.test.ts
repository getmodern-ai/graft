import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModuleCheck } from "@graft/check";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
  publishToolVersion,
} from "@graft/publish";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McpDeps } from "./deps";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { authoredToolName, executeToolName } from "./tool-names";
import { META_TOOL_NAMES } from "./tools";
import { readWebPage } from "./web-page";

/**
 * The MCP server driven by an in-memory MCP client — GRA-1's primary seam, and the suite every
 * later ticket extends. An agent connects as a harness would (the SDK's `Client` over
 * `InMemoryTransport`), and what is asserted is what a harness observes: the tool list, a
 * notification received, a result or a refusal, a ledger row written. The services are the real
 * ones over in-memory fakes; the sandbox is the fake backing; the vendor is a fake behind the real
 * proxy on a loopback port, because the runner is a child process making real HTTP calls. No
 * database, no Docker, nothing leaves the machine.
 */

const PERSON = "person_1";
const OTHER_PERSON = "person_2";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const AGENT_REVOKED = "agent_revoked";
const TOKEN_A = "grft_token_for_agent_a_0000000000000000000000";
const TOKEN_B = "grft_token_for_agent_b_0000000000000000000000";
const TOKEN_REVOKED = "grft_token_revoked_000000000000000000000000000";
const CONN_DEMO = "conn_demo";
const CONN_OTHER = "conn_other";
const API_KEY = "sk_live_the_real_vendor_key";
const LIST_ITEMS = authoredToolName("demo", "list-items");
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };

const LIST_ITEMS_SCHEMA = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1 } },
  additionalProperties: false,
};

/** A module as GRA-18's publish would leave it in the toolbox: one call through `ctx.fetch`. */
const LIST_ITEMS_MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch(\`/items?limit=\${input.limit ?? 5}\`);
  if (!res.ok) throw new Error(\`GET /items \${res.status}: \${await res.text()}\`);
  return await res.json();
};
`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let checked: Parameters<ModuleCheck>[0][];

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: CONN_DEMO,
        personId: PERSON,
        primaryHost: "https://api.demo.example/v2",
        credential: { apiKey: API_KEY },
      },
    ],
  });
  sandbox = createFakeSandboxBackend();

  // The person's toolbox on disk — what a publish writes and every sandbox of theirs mounts.
  for (const path of ["tools/demo/list-items/v1", "tools/other/ping/v1"]) {
    const dir = join(sandbox.toolboxRoot(PERSON), path);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), LIST_ITEMS_MODULE);
  }

  store = createFakeStore();
  store.addConnection({
    id: CONN_DEMO,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example/v2",
  });
  // The person's, but in neither agent's scope.
  store.addConnection({
    id: CONN_OTHER,
    personId: PERSON,
    vendor: "other",
    primaryHost: "https://api.other.example",
  });
  store.addConnection({
    id: "conn_theirs",
    personId: OTHER_PERSON,
    vendor: "demo",
    primaryHost: "https://api.demo.example/v2",
  });
  store.addAgent({ id: AGENT_A, personId: PERSON, token: TOKEN_A, connectionIds: [CONN_DEMO] });
  store.addAgent({ id: AGENT_B, personId: PERSON, token: TOKEN_B, connectionIds: [CONN_DEMO] });
  const revoked = store.addAgent({ id: AGENT_REVOKED, personId: PERSON, token: TOKEN_REVOKED });
  store.agents.set(AGENT_REVOKED, { ...revoked, revokedAt: new Date() });

  store.addTool({
    id: "tool_list_items",
    personId: PERSON,
    vendor: "demo",
    name: "list-items",
    description: "List items from Demo Orders.",
    inputSchema: LIST_ITEMS_SCHEMA,
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/list-items/v1",
  });
  store.addTool({
    id: "tool_other_ping",
    personId: PERSON,
    vendor: "other",
    name: "ping",
    description: "Ping the other vendor.",
    inputSchema: { type: "object" },
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_OTHER,
    path: "tools/other/ping/v1",
  });
  store.addTool({
    id: "tool_theirs",
    personId: OTHER_PERSON,
    vendor: "demo",
    name: "their-tool",
    description: "Another person's tool, which no search here may find.",
    inputSchema: { type: "object" },
    readOnly: true,
    destructive: false,
    defaultConnectionId: "conn_theirs",
    path: "tools/demo/their-tool/v1",
  });
  // Promoted for agent A alone; agent B holds the same toolbox with an empty working set.
  store.promote(AGENT_A, "tool_list_items");
  // Agent A may run code against Demo (the build approval, ADR 0008); the asks themselves are
  // `approval.test.ts`'s subject, and this suite is about everything that happens once they pass.
  store.grantBuild(AGENT_A, CONN_DEMO);

  checked = [];
  const fakeCheck: ModuleCheck = async (input) => {
    checked.push(input);
    return {
      entry: input.entry,
      refusals: [],
      advice: [],
      annotations: { readOnly: true, destructive: false },
    };
  };

  // The real store over the fake sandbox's own toolbox directory, so what the publish writes is what a
  // run mounts (`@graft/toolbox`'s README), and the real publish over the fake check and no registry.
  const fake = createFakeDeps(store);
  const toolbox = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
  const publish = createPublishDeps({
    db: fake.db,
    store: toolbox,
    mirror: createNoopToolboxMirror(),
    sandbox,
    metadata: createFakeMetadataSource({}),
    policy: DEFAULT_PACKAGE_POLICY,
    tool: fake.tool,
    check: fakeCheck,
  });

  deps = {
    ...fake,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: fakeCheck,
    runnerFiles,
    skills: loadSkills,
    // The real reader over a network that refuses to be used: every refusal below happens before it.
    readWebPage: (args) =>
      readWebPage(args, {
        resolve: async () => {
          throw new Error("no network in this suite");
        },
        pinTo: () => ({ dispatcher: undefined, close: async () => {} }),
        fetch: async () => {
          throw new Error("no network in this suite");
        },
      }),
    listChangedWindowMs: 300,
    toolbox,
    publishTool: (args) => publishToolVersion(publish, args),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-mcp-test-handoff-secret-that-is-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
}, 30_000);

afterAll(async () => {
  await sandbox.close();
  await vendor.close();
});

/** A harness: the SDK's client over the in-memory pair, counting `tools/list_changed`. */
async function connect(token: string, windowMs = 300) {
  const notifier = createToolListChangedNotifier({ windowMs });
  const session = await openAgentSession(deps, token, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  const notifications: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notifications.push(Date.now());
  });
  await client.connect(clientTransport);
  return {
    client,
    notifications,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
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

const until = async (predicate: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe("the door", () => {
  it("refuses no token, an unknown token and a revoked token before any handshake", async () => {
    const notifier = createToolListChangedNotifier();
    for (const token of [null, undefined, "", "grft_nobody", TOKEN_REVOKED]) {
      await expect(openAgentSession(deps, token, notifier)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
  });
});

describe("the tool list", () => {
  it("is the meta-tools, the execute tool of each connection in scope, and the agent's promoted tools with their stored schemas and annotations", async () => {
    const a = await connect(TOKEN_A);
    try {
      expect(a.client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
      const { tools } = await a.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        ...META_TOOL_NAMES,
        executeToolName(CONN_DEMO),
        LIST_ITEMS,
      ]);
      const listItems = tools.find((tool) => tool.name === LIST_ITEMS);
      expect(listItems).toMatchObject({
        description: "List items from Demo Orders.",
        inputSchema: LIST_ITEMS_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      const execute = tools.find((tool) => tool.name === executeToolName(CONN_DEMO));
      expect(execute?.description).toContain("Demo Orders");
    } finally {
      await a.close();
    }
  });

  it("differs per agent over one toolbox: another agent's token lists no promoted tool", async () => {
    const b = await connect(TOKEN_B);
    try {
      expect(await b.names()).toEqual([...META_TOOL_NAMES, executeToolName(CONN_DEMO)]);
    } finally {
      await b.close();
    }
  });

  it("treats a first-class name that is not promoted for this agent as unknown", async () => {
    const b = await connect(TOKEN_B);
    try {
      await expect(b.call(LIST_ITEMS, {})).rejects.toThrow(/Unknown tool/);
      await expect(b.call("demo__no-such-tool", {})).rejects.toThrow(/Unknown tool/);
    } finally {
      await b.close();
    }
  });
});

describe("a first-class call", () => {
  it("reaches the fake vendor through the real proxy with the credential injected and never the token, returns the vendor's body, writes one ledger row and moves last_used_at", async () => {
    const a = await connect(TOKEN_A);
    const ledgerBefore = store.usage.length;
    const requestsBefore = vendor.requests.length;
    try {
      const result = await a.call(LIST_ITEMS, { limit: 2 });
      expect(result.isError).toBeFalsy();
      expect(body(result)).toEqual(VENDOR_BODY);

      expect(vendor.requests).toHaveLength(requestsBefore + 1);
      const sent = vendor.requests.at(-1);
      expect(sent?.url).toBe("https://api.demo.example/v2/items?limit=2");
      expect(sent?.headers.get("x-demo-key")).toBe(API_KEY);
      expect(sent?.headers.get("authorization")).toBeNull();
      expect(sent?.headers.get("x-graft-token")).toBeNull();
      for (const [, value] of sent?.headers ?? []) expect(value).not.toMatch(/^eyJ/);
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "forwarded",
        connectionId: CONN_DEMO,
        personId: PERSON,
        agentId: AGENT_A,
        tool: LIST_ITEMS,
        dryRun: false,
      });

      expect(store.usage).toHaveLength(ledgerBefore + 1);
      expect(store.usage.at(-1)).toMatchObject({
        agentId: AGENT_A,
        toolId: "tool_list_items",
        versionId: "tool_list_items_v1",
        toolName: LIST_ITEMS,
        outcome: "ok",
        dryRun: false,
      });
      expect(store.workingSet.get(`${AGENT_A} tool_list_items`)?.lastUsedAt).toBeInstanceOf(Date);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("validates the input against the stored schema before anything runs", async () => {
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      const result = await a.call(LIST_ITEMS, { limit: "two" });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(vendor.requests).toHaveLength(requestsBefore);
      expect(store.usage.at(-1)).toMatchObject({ toolName: LIST_ITEMS, outcome: "refused" });
    } finally {
      await a.close();
    }
  });
});

describe("promote and demote", () => {
  it("change the list and the client receives tools/list_changed", async () => {
    const b = await connect(TOKEN_B);
    try {
      const promoted = body(await b.call("promote", { vendor: "demo", name: "list-items" }));
      expect(promoted).toEqual({
        tool: LIST_ITEMS,
        promoted: true,
        changed: true,
        workingSetSize: 1,
      });
      await until(() => b.notifications.length >= 1);
      expect(b.notifications).toHaveLength(1);
      expect(await b.names()).toContain(LIST_ITEMS);

      // Now promoted for B, the first-class name works for B too — the same module, the same path.
      expect(body(await b.call(LIST_ITEMS, {}))).toEqual(VENDOR_BODY);

      const again = body(await b.call("promote", { vendor: "demo", name: "list-items" }));
      expect(again).toMatchObject({ changed: false, workingSetSize: 1 });

      const demoted = body(await b.call("demote", { vendor: "demo", name: "list-items" }));
      expect(demoted).toEqual({
        tool: LIST_ITEMS,
        promoted: false,
        changed: true,
        workingSetSize: 0,
      });
      expect(await b.names()).not.toContain(LIST_ITEMS);
      await until(() => b.notifications.length >= 2, 1_500);
      expect(b.notifications).toHaveLength(2);
      expect(store.changes.filter((c) => c.agentId === AGENT_B).map((c) => c.change)).toEqual([
        "promote",
        "demote",
      ]);
      expect(store.changes.every((c) => c.agentId !== AGENT_B || c.cause === "agent")).toBe(true);
    } finally {
      await b.close();
    }
  }, 30_000);

  it("refuse a tool that is not in the toolbox — another person's included — as not found", async () => {
    const b = await connect(TOKEN_B);
    try {
      for (const key of [
        { vendor: "demo", name: "their-tool" },
        { vendor: "nobody", name: "nothing" },
      ]) {
        const result = await b.call("promote", key);
        expect(result.isError).toBe(true);
        expect(body(result)).toMatchObject({ error: "refused", reason: "tool_not_found" });
      }
    } finally {
      await b.close();
    }
  });

  it("coalesce: ten changes within a second produce one notification, and at most one more after the window", async () => {
    const b = await connect(TOKEN_B, 500);
    try {
      for (let i = 0; i < 5; i += 1) {
        await b.call("promote", { vendor: "demo", name: "list-items" });
        await b.call("demote", { vendor: "demo", name: "list-items" });
      }
      await new Promise((r) => setTimeout(r, 100));
      expect(b.notifications).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 700));
      expect(b.notifications.length).toBeLessThanOrEqual(2);
      expect(await b.names()).not.toContain(LIST_ITEMS);
    } finally {
      await b.close();
    }
  }, 30_000);
});

describe("find_tool", () => {
  it("returns a demoted tool with what promote needs, and never another person's", async () => {
    const b = await connect(TOKEN_B);
    try {
      const found = body(await b.call("find_tool", { query: "ITEMS" }));
      expect(found.tools).toEqual([
        {
          vendor: "demo",
          name: "list-items",
          tool: LIST_ITEMS,
          description: "List items from Demo Orders.",
          promoted: false,
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ]);
      const everything = body(await b.call("find_tool", { query: "" }));
      expect(everything).toMatchObject({ error: "refused", reason: "input_invalid" });
      const theirs = body(await b.call("find_tool", { query: "their" }));
      expect(theirs.tools).toEqual([]);
      const byVendor = body(await b.call("find_tool", { query: "other" }));
      expect((byVendor.tools as { name: string }[]).map((t) => t.name)).toEqual(["ping"]);
    } finally {
      await b.close();
    }
  });

  it("says a tool is promoted for the agent that holds it", async () => {
    const a = await connect(TOKEN_A);
    try {
      const found = body(await a.call("find_tool", { query: "list-items" }));
      expect(found.tools).toMatchObject([{ promoted: true }]);
    } finally {
      await a.close();
    }
  });
});

describe("run_tool", () => {
  it("refuses input that fails the stored schema, and otherwise runs the same module the first-class tool runs", async () => {
    const b = await connect(TOKEN_B);
    const requestsBefore = vendor.requests.length;
    try {
      const refused = await b.call("run_tool", {
        vendor: "demo",
        name: "list-items",
        input: { limit: 0 },
      });
      expect(refused.isError).toBe(true);
      expect(body(refused)).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(body(refused).message).toContain("limit");
      expect(vendor.requests).toHaveLength(requestsBefore);

      const ran = await b.call("run_tool", {
        vendor: "demo",
        name: "list-items",
        input: { limit: 1 },
      });
      expect(ran.isError).toBeFalsy();
      expect(body(ran)).toEqual(VENDOR_BODY);
      expect(vendor.requests.at(-1)?.url).toBe("https://api.demo.example/v2/items?limit=1");
      expect(store.usage.at(-1)).toMatchObject({
        agentId: AGENT_B,
        toolId: "tool_list_items",
        outcome: "ok",
      });
    } finally {
      await b.close();
    }
  }, 30_000);

  it("refuses a tool whose connection is outside the agent's scope, with the reason, before any token exists", async () => {
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      const result = await a.call("run_tool", { vendor: "other", name: "ping" });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        error: "refused",
        reason: "connection_not_in_scope",
      });
      expect(body(result).message).toContain(CONN_OTHER);
      expect(vendor.requests).toHaveLength(requestsBefore);
      expect(store.usage.at(-1)).toMatchObject({
        toolId: "tool_other_ping",
        outcome: "refused",
      });
    } finally {
      await a.close();
    }
  });

  it("refuses a tool that is not in the toolbox", async () => {
    const a = await connect(TOKEN_A);
    try {
      const result = await a.call("run_tool", { vendor: "demo", name: "their-tool" });
      expect(body(result)).toMatchObject({ error: "refused", reason: "tool_not_found" });
    } finally {
      await a.close();
    }
  });

  it("dry-runs: the read reaches the vendor and the answer is the runner's report, recorded on the version", async () => {
    const a = await connect(TOKEN_A);
    try {
      const result = await a.call("run_tool", {
        vendor: "demo",
        name: "list-items",
        dryRun: true,
      });
      expect(result.isError).toBeFalsy();
      const report = body(result).dryRun as Record<string, unknown>;
      expect(report).toMatchObject({ dryRun: true, passed: true });
      expect(report.reads).toEqual([{ method: "GET", path: "/items?limit=5", status: 200 }]);
      expect(vendor.events.at(-1)).toMatchObject({ dryRun: true, dryRunOutcome: "forwarded" });
      expect(store.versions.get("tool_list_items_v1")?.dryRunOutcome).toMatchObject({
        passed: true,
      });
      expect(store.usage.at(-1)).toMatchObject({ outcome: "ok", dryRun: true });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("starts detached and wait_for_process collects the runner's result", async () => {
    const a = await connect(TOKEN_A);
    try {
      const started = body(
        await a.call("run_tool", { vendor: "demo", name: "list-items", detached: true }),
      );
      expect(started).toMatchObject({ status: "running" });
      const processName = started.processName as string;
      expect(processName).toMatch(/^tool-/);

      const waited = body(await a.call("wait_for_process", { processName, maxWaitSeconds: 10 }));
      expect(waited).toMatchObject({ status: "completed", exitCode: 0, result: VENDOR_BODY });
      expect(store.usage.at(-1)).toMatchObject({ toolId: "tool_list_items", outcome: "ok" });
    } finally {
      await a.close();
    }
  }, 30_000);
});

describe("the advanced set", () => {
  it("write_file lands under the drafts directory, read_file reads it back, and run_command runs with no token", async () => {
    const a = await connect(TOKEN_A);
    try {
      const written = body(
        await a.call("write_file", {
          path: "probe/env.mjs",
          content: "console.log(JSON.stringify(process.env));",
        }),
      );
      expect(written).toEqual({ path: `/tools/.drafts/${AGENT_A}/probe/env.mjs`, bytes: 41 });
      const read = body(await a.call("read_file", { path: "probe/env.mjs" }));
      expect(read).toMatchObject({ content: "console.log(JSON.stringify(process.env));" });

      const ran = body(
        await a.call("run_command", { command: "node /tools/.drafts/agent_a/probe/env.mjs" }),
      );
      expect(ran.exitCode).toBe(0);
      const env = JSON.parse(ran.output as string) as Record<string, string>;
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
      expect(env.GRAFT_TOKEN).toBeUndefined();
      expect(env.GRAFT_PROXY_URL).toBeUndefined();

      const escaped = await a.call("write_file", { path: "../outside.txt", content: "x" });
      expect(body(escaped)).toMatchObject({ error: "refused", reason: "input_invalid" });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("execute__<connection> runs a command whose ctx-less process holds GRAFT_TOKEN and reaches the fake vendor through the proxy", async () => {
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      await a.call("write_file", {
        path: "probe/vendor.mjs",
        content: [
          "const res = await fetch(process.env.GRAFT_PROXY_URL + '/c/' + process.env.GRAFT_CONNECTION + '/ping',",
          "  { headers: { authorization: 'Bearer ' + process.env.GRAFT_TOKEN } });",
          "console.log(res.status + ' ' + await res.text());",
        ].join("\n"),
      });
      const ran = body(
        await a.call(executeToolName(CONN_DEMO), {
          command: `node /tools/.drafts/${AGENT_A}/probe/vendor.mjs`,
        }),
      );
      expect(ran.exitCode).toBe(0);
      expect(ran.output).toContain(`200 ${JSON.stringify(VENDOR_BODY)}`);
      expect(vendor.requests).toHaveLength(requestsBefore + 1);
      expect(vendor.requests.at(-1)?.url).toBe("https://api.demo.example/v2/ping");
      expect(vendor.requests.at(-1)?.headers.get("x-demo-key")).toBe(API_KEY);
      expect(vendor.events.at(-1)).toMatchObject({ tool: "execute", agentId: AGENT_A });
      expect(store.usage.at(-1)).toMatchObject({
        toolName: executeToolName(CONN_DEMO),
        toolId: null,
        outcome: "ok",
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("execute for a connection outside the scope is refused", async () => {
    const a = await connect(TOKEN_A);
    try {
      const result = await a.call(executeToolName(CONN_OTHER), { command: "echo hi" });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ error: "refused", reason: "connection_not_in_scope" });
    } finally {
      await a.close();
    }
  });

  it("read_web_page refuses a private host, a loopback name and a plain-http URL before touching the network", async () => {
    const a = await connect(TOKEN_A);
    try {
      for (const url of [
        "https://10.0.0.1/docs",
        "https://169.254.169.254/latest/meta-data/",
        "https://localhost/docs",
        "https://intranet/docs",
        "https://[::1]/docs",
        "http://docs.vendor.example/api",
      ]) {
        const result = await a.call("read_web_page", { url });
        expect(result.isError, url).toBe(true);
        expect(body(result)).toMatchObject({ ok: false, url });
      }
    } finally {
      await a.close();
    }
  });

  it("check_tool reads the draft from the sandbox and hands it to the check with the schema", async () => {
    const a = await connect(TOKEN_A);
    try {
      await a.call("write_file", {
        path: "orders/index.ts",
        content: "export default async () => 1;",
      });
      await a.call("write_file", { path: "orders/lines.ts", content: "export type Line = {};" });
      const result = body(
        await a.call("check_tool", { path: "orders", inputSchema: { type: "object" } }),
      );
      expect(result).toMatchObject({
        ok: true,
        entry: "index.ts",
        annotations: { readOnly: true, destructive: false },
      });
      expect(checked.at(-1)).toMatchObject({
        entry: "index.ts",
        inputSchema: { type: "object" },
        files: [
          { path: "index.ts", content: "export default async () => 1;" },
          { path: "lines.ts", content: "export type Line = {};" },
        ],
      });

      const missing = await a.call("check_tool", { path: "nowhere" });
      expect(missing.isError).toBe(true);
      expect(body(missing).error).toContain("does not exist");
    } finally {
      await a.close();
    }
  }, 30_000);

  it("read_tool_source returns the current version's files", async () => {
    const a = await connect(TOKEN_A);
    try {
      const result = body(await a.call("read_tool_source", { vendor: "demo", name: "list-items" }));
      expect(result).toMatchObject({
        tool: LIST_ITEMS,
        version: 1,
        path: "tools/demo/list-items/v1",
        files: [{ path: "index.ts", content: LIST_ITEMS_MODULE }],
      });
    } finally {
      await a.close();
    }
  });

  it("the stubs answer not_available_yet with their ticket", async () => {
    const a = await connect(TOKEN_A);
    try {
      for (const [name, args, ticket] of [
        ["acquire", { connectionId: CONN_DEMO, goal: "list orders" }, "GRA-29"],
        ["acquire_status", { jobId: "job_1" }, "GRA-29"],
        [
          "request_connection",
          { vendor: "x", primaryHost: "https://x.example", scheme: "bearer" },
          "GRA-28",
        ],
        ["request_credential", { connectionId: CONN_DEMO }, "GRA-28"],
      ] as const) {
        const result = await a.call(name, { ...args });
        expect(result.isError, name).toBe(true);
        expect(body(result)).toMatchObject({ error: "not_available_yet", ticket });
      }
    } finally {
      await a.close();
    }
  });
});

describe("publish_tool", () => {
  it("publishes a draft from the toolbox as a promoted version, notifies, dry-runs it, and the tool then runs first-class", async () => {
    const a = await connect(TOKEN_A);
    try {
      await a.call("write_file", { path: "greet/index.ts", content: LIST_ITEMS_MODULE });
      const result = await a.call("publish_tool", {
        vendor: "demo",
        name: "greet",
        description: "Greets whoever asks, by listing Demo items.",
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
        path: "greet",
        testInput: { limit: 3 },
      });
      expect(result.isError).toBeFalsy();
      const published = body(result);
      expect(published).toMatchObject({
        ok: true,
        tool: "demo__greet",
        version: 1,
        path: "tools/demo/greet/v1",
        promoted: true,
        annotations: { readOnlyHint: true, destructiveHint: false },
        dependencies: [],
      });
      expect(published.dryRun).toMatchObject({ dryRun: { passed: true } });
      expect(vendor.requests.at(-1)?.url).toBe("https://api.demo.example/v2/items?limit=3");

      // The row is in the toolbox and the working set has it; the files are where the sandbox mounts them.
      const tool = [...store.tools.values()].find((row) => row.name === "greet");
      expect(tool).toMatchObject({
        vendor: "demo",
        defaultConnectionId: CONN_DEMO,
        readOnly: true,
      });
      expect(store.isPromoted(AGENT_A, tool?.id ?? "")).toBe(true);
      expect(store.changes.at(-1)).toMatchObject({ change: "promote", cause: "publish" });
      await until(() => a.notifications.length >= 1);
      expect(await a.names()).toContain("demo__greet");

      expect(body(await a.call("demo__greet", { limit: 1 }))).toEqual(VENDOR_BODY);
      expect(
        body(await a.call("read_tool_source", { vendor: "demo", name: "greet" })),
      ).toMatchObject({
        version: 1,
        files: [{ path: "index.ts", content: LIST_ITEMS_MODULE }],
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("refuses a module outside the toolbox, a vendor with no connection in scope, and a bad definition, before writing anything", async () => {
    const a = await connect(TOKEN_A);
    try {
      const outside = await a.call("publish_tool", {
        vendor: "demo",
        name: "x",
        description: "d",
        inputSchema: { type: "object" },
        path: "/workspace/x",
      });
      expect(body(outside)).toMatchObject({ error: "refused", reason: "input_invalid" });
      const unconnected = await a.call("publish_tool", {
        vendor: "nobody",
        name: "x",
        description: "d",
        inputSchema: { type: "object" },
        path: "greet",
      });
      expect(body(unconnected)).toMatchObject({
        error: "refused",
        reason: "connection_not_in_scope",
      });
      const badName = await a.call("publish_tool", {
        vendor: "demo",
        name: "Not Kebab",
        description: "d",
        inputSchema: { type: "object" },
        path: "greet",
      });
      expect(body(badName)).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect([...store.tools.values()].some((row) => row.name === "x")).toBe(false);
    } finally {
      await a.close();
    }
  });
});
