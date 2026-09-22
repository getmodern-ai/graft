import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { ModuleCheck } from "@graft/check";
import { setConnectionCredential } from "@graft/core";
import type { BlobRow } from "@graft/db/repo/blob";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
  publishToolVersion,
} from "@graft/publish";
import {
  loadRunnerSource,
  loadSkills,
  RUNNER_DIR,
  RUNNER_FILE,
  readRunnerEnvelope,
  runnerFiles,
} from "@graft/runner";
import { createFakeSandboxBackend, type FakeSandboxBackend } from "@graft/sandbox";
import {
  createFilesystemBlobStore,
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
} from "@graft/toolbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NO_ELICITATION } from "./approval";
import { BLOB_RESULT_FACT, type BlobWrittenEvent } from "./blobs";
import type { McpDeps, ToolCallEvent } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier, type ToolListChangedNotifier } from "./notifier";
import { revokeConnectionAndNotify } from "./revoke";
import { runAuthoredTool } from "./run";
import { seededRunnerPath } from "./sandbox";
import { openAgentSession } from "./session";
import { type BlobSweptEvent, runSweep } from "./sweep";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { authoredToolName, executeToolName } from "./tool-names";
import { AUTHORING_TOOLS } from "./tools/authoring";

const AUTHORING_NAMES = new Set(AUTHORING_TOOLS.map((tool) => tool.definition.name));

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

/**
 * A module that moves the vendor's answer into a blob rather than through the model (GRA-186; ADR
 * 0023): the bytes go to `ctx.blob.write`, the result carries the ref and a count, and nothing of
 * the body.
 */
/** A module whose result wears the server's own keys, and writes one blob (Greptile on #144). */
const DECOY_MODULE = `export default async (_input, ctx) => {
  await ctx.blob.write(new TextEncoder().encode("decoy"), { contentType: "text/plain" });
  return { result: "x", truncated: true, blobs: ["y"] };
};
`;

/** A module whose result wears the wide event's counter keys, and writes nothing (Greptile on #144). */
const DECOY_COUNTS_MODULE = `export default async () => ({ blobs: ["vendor data"], blobsDropped: 3 });
`;

const SAVE_REPORT = authoredToolName("demo", "save-report");
const SAVE_REPORT_MODULE = `export default async (input, ctx) => {
  const res = await ctx.fetch(\`/items?limit=\${input.limit ?? 5}\`);
  if (!res.ok) throw new Error(\`GET /items \${res.status}: \${await res.text()}\`);
  const body = await res.text();
  const file = await ctx.blob.write(new TextEncoder().encode(body), { contentType: "application/json", name: "items.json" });
  return { file, count: JSON.parse(body).items.length, stat: await ctx.blob.stat(file) };
};
`;

/**
 * The consuming half (GRA-187; ADR 0023): the ref one tool answered arrives in this tool's input,
 * `ctx.blob.read` answers a `Blob`, and it goes to the vendor in a multipart body. The result
 * names the ref, the size and the type, never a byte. The schema names where a ref may sit, a
 * list and an object among them, so the door's walk over nested input is exercised.
 */
const UPLOAD_FILE = authoredToolName("demo", "upload-file");
const UPLOAD_FILE_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    name: { type: "string" },
    channel: { type: "string" },
    attachments: { type: "array", items: { type: "string" } },
    meta: { type: "object" },
  },
  required: ["file"],
  additionalProperties: false,
};
const UPLOAD_FILE_MODULE = `export default async (input, ctx) => {
  const file = await ctx.blob.read(input.file);
  const form = new FormData();
  form.append("channel", input.channel ?? "general");
  form.append("file", file, input.name ?? "upload.bin");
  const res = await ctx.fetch("/files/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(\`POST /files/upload \${res.status}: \${await res.text()}\`);
  return { uploaded: input.file, status: res.status, bytes: file.size, contentType: file.type };
};
`;

/**
 * A module that writes two 1 MiB blobs in one run and catches the second's refusal (GRA-187, after
 * Greptile on #145): under a budget of 1.5 MiB the first commits and the second is `blob_quota`.
 */
const WRITE_TWO = authoredToolName("demo", "write-two");
const WRITE_TWO_MODULE = `export default async (_input, ctx) => {
  const bytes = new Uint8Array(1024 * 1024).fill(2);
  const first = await ctx.blob.write(bytes, { contentType: "application/octet-stream", name: "one.bin" });
  try {
    return { first, second: await ctx.blob.write(bytes, { contentType: "application/octet-stream", name: "two.bin" }) };
  } catch (error) {
    return { first, second: { code: error.code ?? null, message: error.message } };
  }
};
`;

/** A module that writes a blob and then throws (GRA-187, after Greptile on #148): the row must still land. */
const WRITE_THEN_THROW = authoredToolName("demo", "write-then-throw");
const WRITE_THEN_THROW_MODULE = `export default async (_input, ctx) => {
  const file = await ctx.blob.write(new TextEncoder().encode("kept before the fall"), { contentType: "text/plain", name: "kept.txt" });
  throw new Error(\`fell over after writing \${file}\`);
};
`;

let sandbox: FakeSandboxBackend;
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let checked: Parameters<ModuleCheck>[0][];
const blobEvents: BlobWrittenEvent[] = [];
const toolEvents: ToolCallEvent[] = [];

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
      // Two live Rebind accounts, for the tool that follows one once its own row is revoked (GRA-122).
      {
        id: "conn_rebind_live",
        personId: PERSON,
        primaryHost: "https://api.rebind.example",
        credential: { apiKey: "rebind-live-key" },
      },
      {
        id: "conn_rebind_second",
        personId: PERSON,
        primaryHost: "https://api.rebind.example",
        credential: { apiKey: "rebind-second-key" },
      },
    ],
  });
  sandbox = createFakeSandboxBackend();

  // The person's toolbox on disk — what a publish writes and every sandbox of theirs mounts.
  for (const path of [
    "tools/demo/list-items/v1",
    "tools/other/ping/v1",
    "tools/rebind/count-things/v1",
  ]) {
    const dir = join(sandbox.toolboxRoot(PERSON), path);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.ts"), LIST_ITEMS_MODULE);
  }
  const saveReport = join(sandbox.toolboxRoot(PERSON), "tools/demo/save-report/v1");
  await mkdir(saveReport, { recursive: true });
  await writeFile(join(saveReport, "index.ts"), SAVE_REPORT_MODULE);
  const decoy = join(sandbox.toolboxRoot(PERSON), "tools/demo/decoy/v1");
  await mkdir(decoy, { recursive: true });
  await writeFile(join(decoy, "index.ts"), DECOY_MODULE);
  const decoyCounts = join(sandbox.toolboxRoot(PERSON), "tools/demo/decoy-counts/v1");
  await mkdir(decoyCounts, { recursive: true });
  await writeFile(join(decoyCounts, "index.ts"), DECOY_COUNTS_MODULE);
  const uploadFile = join(sandbox.toolboxRoot(PERSON), "tools/demo/upload-file/v1");
  await mkdir(uploadFile, { recursive: true });
  await writeFile(join(uploadFile, "index.ts"), UPLOAD_FILE_MODULE);
  const writeTwo = join(sandbox.toolboxRoot(PERSON), "tools/demo/write-two/v1");
  await mkdir(writeTwo, { recursive: true });
  await writeFile(join(writeTwo, "index.ts"), WRITE_TWO_MODULE);
  const writeThenThrow = join(sandbox.toolboxRoot(PERSON), "tools/demo/write-then-throw/v1");
  await mkdir(writeThenThrow, { recursive: true });
  await writeFile(join(writeThenThrow, "index.ts"), WRITE_THEN_THROW_MODULE);

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
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    connectionIds: [CONN_DEMO],
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_B,
    personId: PERSON,
    token: TOKEN_B,
    connectionIds: [CONN_DEMO],
  });
  const revoked = store.addAgent({
    scopeMode: "listed",
    id: AGENT_REVOKED,
    personId: PERSON,
    token: TOKEN_REVOKED,
  });
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
    id: "tool_save_report",
    personId: PERSON,
    vendor: "demo",
    name: "save-report",
    // Worded clear of the words the find_tool tests search for.
    description: "Keep what the vendor answered as a file.",
    inputSchema: LIST_ITEMS_SCHEMA,
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/save-report/v1",
  });
  // In the toolbox and not promoted: reached through run_tool.
  store.addTool({
    id: "tool_decoy",
    personId: PERSON,
    vendor: "demo",
    name: "decoy",
    description: "Answers a result shaped like the server's own, and writes a blob.",
    inputSchema: { type: "object" },
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/decoy/v1",
  });
  store.addTool({
    id: "tool_decoy_counts",
    personId: PERSON,
    vendor: "demo",
    name: "decoy-counts",
    description: "Answers a result wearing the wide event's counter keys, and writes nothing.",
    inputSchema: { type: "object" },
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/decoy-counts/v1",
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
  store.promote(AGENT_A, "tool_save_report");
  store.addTool({
    id: "tool_upload_file",
    personId: PERSON,
    vendor: "demo",
    name: "upload-file",
    // Worded clear of the words the find_tool tests search for.
    description: "Send a kept file upstream as an upload.",
    inputSchema: UPLOAD_FILE_SCHEMA,
    // A write, as a vendor upload is: it asks once like any write (ADR 0008), and the yes is
    // recorded below so this suite is about the run and not the ask.
    readOnly: false,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/upload-file/v1",
  });
  store.promote(AGENT_A, "tool_upload_file");
  store.addTool({
    id: "tool_write_two",
    personId: PERSON,
    vendor: "demo",
    name: "write-two",
    // Worded clear of the words the find_tool tests search for.
    description: "Keeps two copies of a fixed page.",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/write-two/v1",
  });
  store.promote(AGENT_A, "tool_write_two");
  store.addTool({
    id: "tool_write_then_throw",
    personId: PERSON,
    vendor: "demo",
    name: "write-then-throw",
    // Worded clear of the words the find_tool tests search for.
    description: "Keeps a page and then falls over.",
    inputSchema: { type: "object", additionalProperties: false },
    readOnly: true,
    destructive: false,
    defaultConnectionId: CONN_DEMO,
    path: "tools/demo/write-then-throw/v1",
  });
  store.promote(AGENT_A, "tool_write_then_throw");
  // Agent A may run code against Demo (the build approval, ADR 0008); the asks themselves are
  // `approval.test.ts`'s subject, and this suite is about everything that happens once they pass.
  store.grantBuild(AGENT_A, CONN_DEMO);
  store.approvals.set(`${AGENT_A} tool_upload_file`, {
    agentId: AGENT_A,
    toolId: "tool_upload_file",
    decision: "allow",
    decidedAt: new Date(),
    askEveryCall: false,
    owner: "person",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

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
    // The registry the door's budget grants live on (GRA-187); the sweep's use of it is `sweep.test.ts`.
    inFlight: createInFlightRegistry(),
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
    onBlobWritten: (event) => blobEvents.push(event),
    onToolCall: (event) => toolEvents.push(event),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-mcp-test-handoff-secret-that-is-long-enough",
      waitMs: 0,
      ttlMs: 60_000,
    },
  };
}, 30_000);

afterAll(async () => {
  deps.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

/**
 * A harness: the SDK's client over the in-memory pair, counting `tools/list_changed`. Two harnesses
 * handed one `shared` notifier stand for two agents of one process, which is how a change announced
 * to one agent is shown not to reach the other.
 */
async function connect(token: string, windowMs = 300, shared?: ToolListChangedNotifier) {
  const notifier = shared ?? createToolListChangedNotifier({ windowMs });
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
    notifier,
    notifications,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await session.close();
      if (!shared) notifier.close();
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
        SAVE_REPORT,
        UPLOAD_FILE,
        WRITE_TWO,
        WRITE_THEN_THROW,
      ]);
      const listItems = tools.find((tool) => tool.name === LIST_ITEMS);
      expect(listItems).toMatchObject({
        // The row's prose, then the blob fact every authored tool carries (GRA-190; `tools.ts`).
        description: `List items from Demo Orders. ${BLOB_RESULT_FACT}`,
        inputSchema: LIST_ITEMS_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      const execute = tools.find((tool) => tool.name === executeToolName(CONN_DEMO));
      expect(execute?.description).toContain("Demo Orders");
      // Both can answer the tool ask on a first write, so both name the card's resource under
      // its key and ChatGPT's alias (GRA-116): a host renders a card only for a tool that does.
      for (const tool of [listItems, execute]) {
        expect(tool?._meta, tool?.name).toEqual({
          ui: { resourceUri: "ui://graft/ask" },
          "openai/outputTemplate": "ui://graft/ask",
        });
      }
    } finally {
      await a.close();
    }
  });

  /** ADR 0007 as amended 2026-09-19: an agent on `all` lists every live connection of the person's, and nobody else's. */
  it("for an agent on all connections carries the execute tool of every connection the person has, another person's excluded, with no list row behind it", async () => {
    const AGENT_OPEN = "agent_open";
    const TOKEN_OPEN = "grft_token_for_agent_open_00000000000000000000";
    store.addAgent({ scopeMode: "all", id: AGENT_OPEN, personId: PERSON, token: TOKEN_OPEN });
    const open = await connect(TOKEN_OPEN);
    try {
      expect(await open.names()).toEqual([
        ...META_TOOL_NAMES,
        executeToolName(CONN_DEMO),
        executeToolName(CONN_OTHER),
      ]);
      expect(store.agentConnections.get(AGENT_OPEN)?.size ?? 0).toBe(0);
    } finally {
      await open.close();
      store.agents.delete(AGENT_OPEN);
      store.agentConnections.delete(AGENT_OPEN);
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

/**
 * A tool that writes a blob (GRA-186; ADR 0023): the ref is in the result where the module put it,
 * the ledger rides beside it as `blobs` in the text block and in `structuredContent`, the bytes are
 * on the agent's blobs mount and nowhere in the answer, and the server holds one row per blob.
 */
describe("a tool that writes a blob", () => {
  const REF = /^blob:\/\/[0-9a-f-]{36}$/;

  it("returns the ref in the result and the ledger beside it, writes the bytes under the agent's mount alone, and one blob row for the person and agent", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    const eventsBefore = blobEvents.length;
    const before = Date.now();
    try {
      const result = await a.call(SAVE_REPORT, { limit: 1 });
      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      const answer = body(result) as {
        result: { file: string; count: number; stat: Record<string, unknown> };
        blobs: Record<string, unknown>[];
      };
      expect(answer.result.file).toMatch(REF);
      expect(answer.result.count).toBe(1);
      const id = answer.result.file.slice("blob://".length);
      // The vendor's body went into the blob, not the answer: not a byte of it is on the wire.
      expect(text).not.toContain("Widget");
      expect(text).not.toContain(JSON.stringify(VENDOR_BODY));

      // The bytes, under this agent's directory beside the toolboxes and under /blobs in its
      // sandbox, and nowhere under /tools (ADR 0023: the scope is the mount).
      const dir = join(sandbox.blobsRoot(AGENT_A), id);
      expect((await readdir(dir)).sort()).toEqual(["data", "meta.json"]);
      const data = await readFile(join(dir, "data"), "utf8");
      expect(JSON.parse(data)).toEqual(VENDOR_BODY);
      expect(await readdir(sandbox.blobsRoot(AGENT_A))).not.toContain(`${id}.tmp`);
      expect(await readdir(join(sandbox.sandboxRoot(`agent-${AGENT_A}`), "blobs"))).toContain(id);
      await expect(stat(join(sandbox.toolboxRoot(PERSON), ".blobs"))).rejects.toThrow();
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
      expect(meta).toMatchObject({
        bytes: data.length,
        contentType: "application/json",
        name: "items.json",
        agentId: AGENT_A,
        toolVersion: "tool_save_report_v1",
      });

      // The ledger beside the result, in the text block and in structuredContent alike, with an
      // expiry 24 hours out; stat inside the module read the same sidecar.
      const line = {
        ref: answer.result.file,
        bytes: data.length,
        contentType: "application/json",
        name: "items.json",
        expiresAt: meta.expiresAt,
      };
      expect(answer.blobs).toEqual([line]);
      expect(result.structuredContent).toEqual({ result: answer.result, blobs: [line] });
      expect(answer.result.stat).toEqual({
        bytes: data.length,
        contentType: "application/json",
        name: "items.json",
        expiresAt: meta.expiresAt,
      });
      const expiresAt = Date.parse(meta.expiresAt);
      expect(expiresAt - Date.parse(meta.writtenAt)).toBe(24 * 60 * 60 * 1000);
      expect(expiresAt).toBeGreaterThan(before + 23 * 60 * 60 * 1000);

      // One row, the person's and the agent's, keyed by the id inside the ref, and one event.
      expect(store.blobs).toHaveLength(blobsBefore + 1);
      expect(store.blobs.at(-1)).toMatchObject({
        id,
        personId: PERSON,
        agentId: AGENT_A,
        versionId: "tool_save_report_v1",
        bytes: data.length,
        contentType: "application/json",
        name: "items.json",
        removedAt: null,
      });
      expect(store.blobs.at(-1)?.expiresAt.toISOString()).toBe(meta.expiresAt);
      expect(blobEvents.slice(eventsBefore)).toEqual([
        {
          agentId: AGENT_A,
          personId: PERSON,
          versionId: "tool_save_report_v1",
          bytes: data.length,
          contentType: "application/json",
        },
      ]);
      // The run is still one ledger line, as before.
      expect(store.usage.at(-1)).toMatchObject({ toolId: "tool_save_report", outcome: "ok" });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("a tool that writes no blob answers exactly what it did before, with no blobs key", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const result = await a.call(LIST_ITEMS, { limit: 2 });
      expect(body(result)).toEqual(VENDOR_BODY);
      expect(result.structuredContent).toEqual(VENDOR_BODY);
      expect(store.blobs).toHaveLength(blobsBefore);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("a detached run's blobs come back from wait_for_process with their rows written then, and no version", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const started = body(
        await a.call("run_tool", { vendor: "demo", name: "save-report", detached: true }),
      );
      expect(started).toMatchObject({ status: "running" });
      // The start knows nothing of a blob yet: the row lands when the poll reads the envelope.
      expect(store.blobs).toHaveLength(blobsBefore);

      const processName = started.processName as string;
      const waited = body(await a.call("wait_for_process", { processName, maxWaitSeconds: 10 }));
      expect(waited).toMatchObject({ status: "completed", exitCode: 0 });
      const file = (waited.result as { file: string }).file;
      expect(file).toMatch(REF);
      expect(waited.blobs).toEqual([
        {
          ref: file,
          bytes: expect.any(Number),
          contentType: "application/json",
          name: "items.json",
          expiresAt: expect.any(String),
        },
      ]);
      expect(store.blobs).toHaveLength(blobsBefore + 1);
      expect(store.blobs.at(-1)).toMatchObject({
        id: file.slice("blob://".length),
        personId: PERSON,
        agentId: AGENT_A,
        versionId: null,
      });
      // Polled again, the same finished process writes no second row and fires no second event:
      // the insert is idempotent on the id (`repo/blob.ts`), and the fake mirrors it.
      const eventsAfterFirst = blobEvents.length;
      const again = body(await a.call("wait_for_process", { processName, maxWaitSeconds: 1 }));
      expect(again).toMatchObject({
        status: "completed",
        blobs: [expect.objectContaining({ ref: file })],
      });
      expect(store.blobs).toHaveLength(blobsBefore + 1);
      expect(blobEvents).toHaveLength(eventsAfterFirst);
    } finally {
      await a.close();
    }
  }, 30_000);

  /** Whether the server cut a result is the server's word, never read off a key the module chose. */
  it("keeps a module's own result, truncated and blobs keys inside its result, under the real ledger", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const result = await a.call("run_tool", { vendor: "demo", name: "decoy" });
      expect(result.isError).toBeFalsy();
      const answer = body(result) as { result: unknown; blobs: Record<string, unknown>[] };
      expect(answer.result).toEqual({ result: "x", truncated: true, blobs: ["y"] });
      expect(answer.blobs).toHaveLength(1);
      expect(answer.blobs[0]?.ref).toMatch(REF);
      expect(answer.blobs[0]?.bytes).toBe(5);
      expect(store.blobs).toHaveLength(blobsBefore + 1);
    } finally {
      await a.close();
    }
  }, 30_000);

  /** The wide event's counts come from the parsed ledger, never from the answer's keys (Greptile on #144). */
  it("counts zero written and zero dropped for a module whose result wears the counter keys, and fires no blob_written", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    const eventsBefore = blobEvents.length;
    try {
      const result = await a.call("run_tool", { vendor: "demo", name: "decoy-counts" });
      expect(result.isError).toBeFalsy();
      // The answer is the module's, keys and all: nothing was written, so nothing was wrapped.
      expect(body(result)).toEqual({ blobs: ["vendor data"], blobsDropped: 3 });
      const event = toolEvents.at(-1);
      expect(event).toMatchObject({ tool: "run_tool", outcome: "ok" });
      expect(event?.detail).toEqual({
        tool: authoredToolName("demo", "decoy-counts"),
        blobs: 0,
        blobsDropped: 0,
      });
      expect(store.blobs).toHaveLength(blobsBefore);
      expect(blobEvents).toHaveLength(eventsBefore);

      // And a run that did write is counted from its ledger, once.
      await a.call(SAVE_REPORT, { limit: 1 });
      expect(toolEvents.at(-1)?.detail).toEqual({ blobs: 1, blobsDropped: 0 });
    } finally {
      await a.close();
    }
  }, 30_000);

  /** The synchronous execute path reads the same envelope off the command's stdout (Greptile on #144). */
  it("records the blobs a runner invoked through execute__<connection> wrote, with no version, and names them beside the output", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    const eventsBefore = blobEvents.length;
    try {
      const ran = body(
        await a.call(executeToolName(CONN_DEMO), {
          command: `echo '{"limit":1}' | node "$GRAFT_RUNNER" /tools/tools/demo/save-report/v1`,
        }),
      );
      expect(ran.exitCode).toBe(0);
      const envelope = readRunnerEnvelope(String(ran.output));
      if (!envelope) throw new Error("the command's output carries no envelope");
      const file = (envelope.result as { file: string }).file;
      expect(file).toMatch(REF);
      expect(ran.blobs).toEqual([
        {
          ref: file,
          bytes: expect.any(Number),
          contentType: "application/json",
          name: "items.json",
          expiresAt: expect.any(String),
        },
      ]);
      expect(store.blobs).toHaveLength(blobsBefore + 1);
      expect(store.blobs.at(-1)).toMatchObject({
        id: file.slice("blob://".length),
        personId: PERSON,
        agentId: AGENT_A,
        versionId: null,
      });
      expect(blobEvents.slice(eventsBefore)).toEqual([
        expect.objectContaining({ agentId: AGENT_A, versionId: null }),
      ]);
    } finally {
      await a.close();
    }
  }, 30_000);
});

/**
 * The loop closed (GRA-187; ADR 0023): the ref one tool answered is the next tool's input, the
 * vendor receives the bytes in a multipart body, and neither result carries a byte. Then the door:
 * a ref that cannot be read is refused before a sandbox is touched, and so is every run of an
 * agent at the quota. "Before a sandbox is touched" is asserted on the fake backing's process list
 * for the agent's sandbox, which a run would grow by one.
 */
describe("a second tool reads the blob, and the door refuses a dead ref (GRA-187)", () => {
  const SANDBOX_A = `agent-${AGENT_A}`;
  const DEAD_REF = "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21";
  const GIB = 1024 * 1024 * 1024;

  /** A row as the fake store holds it, for the door's cases that need one the runner never wrote. */
  const row = (id: string, agentId: string, overrides: Partial<BlobRow> = {}): BlobRow => ({
    id,
    personId: PERSON,
    agentId,
    versionId: null,
    bytes: 1024,
    contentType: "application/octet-stream",
    name: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    removedAt: null,
    owner: "person",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const withRows = async (rows: BlobRow[], run: () => Promise<void>) => {
    store.blobs.push(...rows);
    try {
      await run();
    } finally {
      for (const added of rows) {
        const at = store.blobs.indexOf(added);
        if (at !== -1) store.blobs.splice(at, 1);
      }
    }
  };
  /**
   * Agent B holds no approval, so a run of B's that passes the door reaches the gate and leaves an
   * ask open (`waitMs: 0`): that ask is the evidence the door let it through, and it is taken away
   * again so a later test's count of open asks starts where it did.
   */
  const askedPastTheDoor = async (run: () => Promise<CallToolResult>) => {
    const before = new Set(store.pendingActions.keys());
    try {
      const result = await run();
      expect(body(result)).toMatchObject({ error: "awaiting_approval" });
    } finally {
      for (const id of store.pendingActions.keys()) {
        if (!before.has(id)) store.pendingActions.delete(id);
      }
    }
  };
  /** The refusal the door answers, checked whole: the shape, the flag, the ledger row, and no exec. */
  const expectRefusedAtDoor = (
    result: CallToolResult,
    execsBefore: number,
    expected: Record<string, unknown>,
  ) => {
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({ error: "refused", ...expected });
    expect(result.structuredContent).toEqual({ error: "refused", ...expected });
    expect(sandbox.processNames(SANDBOX_A)).toHaveLength(execsBefore);
    expect(store.usage.at(-1)).toMatchObject({ outcome: "refused" });
  };

  it("tool A writes a blob, tool B reads its ref from the input and the vendor receives the exact bytes as a multipart part, and no result carries a byte", async () => {
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      const wrote = await a.call(SAVE_REPORT, { limit: 1 });
      expect(wrote.isError).toBeFalsy();
      const ref = (body(wrote) as { result: { file: string } }).result.file;
      const id = ref.slice("blob://".length);
      const data = await readFile(join(sandbox.blobsRoot(AGENT_A), id, "data"));
      expect(JSON.parse(data.toString("utf8"))).toEqual(VENDOR_BODY);

      const read = await a.call(UPLOAD_FILE, { file: ref, name: "items.json", channel: "ops" });
      expect(read.isError).toBeFalsy();
      const answer = body(read);
      expect(answer).toEqual({
        uploaded: ref,
        status: 200,
        bytes: data.length,
        contentType: "application/json",
      });
      // The consuming tool wrote no blob, so its answer is the module's alone: no `blobs` key.
      expect(read.structuredContent).toEqual(answer);
      for (const result of [wrote, read]) {
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain("Widget");
        expect(text).toContain(ref);
      }

      // The vendor saw one POST with a multipart body whose file part is the blob, byte for byte.
      const sent = vendor.requests.slice(requestsBefore).at(-1);
      expect(sent?.method).toBe("POST");
      expect(sent?.url).toBe("https://api.demo.example/v2/files/upload");
      const contentType = sent?.headers.get("content-type") ?? "";
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      const form = await new Response(sent?.body, {
        headers: { "content-type": contentType },
      }).formData();
      expect(form.get("channel")).toBe("ops");
      const part = form.get("file");
      expect(part).toBeInstanceOf(File);
      const file = part as File;
      expect(file.name).toBe("items.json");
      expect(file.type).toBe("application/json");
      expect(Buffer.from(await file.arrayBuffer()).equals(data)).toBe(true);
      expect(store.usage.at(-1)).toMatchObject({ toolId: "tool_upload_file", outcome: "ok" });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("refuses blob_not_found for a made-up ref and for another agent's real ref with one sentence, a ref nested in an array or an object included, before any exec", async () => {
    const a = await connect(TOKEN_A);
    const b = await connect(TOKEN_B);
    try {
      // A real blob of agent B's: the row is there, and agent A is told what it is told of nothing.
      const theirs = row("b0b0b0b0-0000-4000-8000-000000000001", AGENT_B);
      await withRows([theirs], async () => {
        const live = row("a1a1a1a1-0000-4000-8000-000000000001", AGENT_A);
        await withRows([live], async () => {
          const execs = sandbox.processNames(SANDBOX_A).length;
          const madeUp = await a.call(UPLOAD_FILE, { file: DEAD_REF });
          expectRefusedAtDoor(madeUp, execs, {
            reason: "blob_not_found",
            ref: DEAD_REF,
            message: `${DEAD_REF} names no blob this agent holds. Run the tool that produced it again and pass the ref it answers.`,
          });
          const another = await a.call(UPLOAD_FILE, { file: `blob://${theirs.id}` });
          expectRefusedAtDoor(another, execs, {
            reason: "blob_not_found",
            ref: `blob://${theirs.id}`,
            message: `blob://${theirs.id} names no blob this agent holds. Run the tool that produced it again and pass the ref it answers.`,
          });
          expect((body(another).message as string).replace(theirs.id, "<id>")).toBe(
            (body(madeUp).message as string).replace(DEAD_REF.slice("blob://".length), "<id>"),
          );
          // A live ref where the schema says, a dead one deeper: the walk finds it in a list...
          const inList = await a.call(UPLOAD_FILE, {
            file: `blob://${live.id}`,
            attachments: [`blob://${live.id}`, DEAD_REF],
          });
          expectRefusedAtDoor(inList, execs, {
            reason: "blob_not_found",
            ref: DEAD_REF,
            message: expect.stringContaining(DEAD_REF),
          });
          // ...and inside an object under a key no schema names.
          const inObject = await a.call(UPLOAD_FILE, {
            file: `blob://${live.id}`,
            meta: { source: { previous: DEAD_REF } },
          });
          expectRefusedAtDoor(inObject, execs, {
            reason: "blob_not_found",
            ref: DEAD_REF,
            message: expect.stringContaining(DEAD_REF),
          });
          // Agent B, whose row it is, is not refused at the door for its own ref: the same call
          // passes it and reaches the approval gate, which asks (ADR 0008) since B holds no yes.
          await askedPastTheDoor(() =>
            b.call("run_tool", {
              vendor: "demo",
              name: "upload-file",
              input: { file: `blob://${theirs.id}` },
            }),
          );
        });
      });
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);

  it("refuses blob_expired for a row past its expiry and for a removed one, naming the TTL, before any exec", async () => {
    const a = await connect(TOKEN_A);
    try {
      const expired = row("e1e1e1e1-0000-4000-8000-000000000001", AGENT_A, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const removed = row("e1e1e1e1-0000-4000-8000-000000000002", AGENT_A, {
        removedAt: new Date(),
      });
      await withRows([expired, removed], async () => {
        const execs = sandbox.processNames(SANDBOX_A).length;
        for (const dead of [expired, removed]) {
          const ref = `blob://${dead.id}`;
          const result = await a.call(UPLOAD_FILE, { file: ref });
          expectRefusedAtDoor(result, execs, {
            reason: "blob_expired",
            ref,
            message: `${ref} has expired: a blob lives 24 hours from its write, and this one's time has passed. Run the tool that produced it again and pass the new ref.`,
          });
        }
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("hands the run what it may still commit: with 1.5 MiB left of the quota a tool writing two 1 MiB blobs commits one, gets blob_quota on the second, and one row lands", async () => {
    const a = await connect(TOKEN_A);
    try {
      const already = store.blobs
        .filter((b) => b.agentId === AGENT_A && b.removedAt === null && b.expiresAt > new Date())
        .reduce((total, b) => total + b.bytes, 0);
      const filler = row("d0d0d0d0-0000-4000-8000-000000000001", AGENT_A, {
        bytes: GIB - 1.5 * 1024 * 1024 - already,
      });
      await withRows([filler], async () => {
        const blobsBefore = store.blobs.length;
        const dirsBefore = (await readdir(sandbox.blobsRoot(AGENT_A))).length;
        const result = await a.call(WRITE_TWO, {});
        expect(result.isError).toBeFalsy();
        const answer = body(result) as {
          result: { first: string; second: { code: string; message: string } };
          blobs: { ref: string; bytes: number }[];
        };
        expect(answer.result.first).toMatch(/^blob:\/\//);
        expect(answer.result.second).toEqual({
          code: "blob_quota",
          message:
            "blob_quota: the blob would carry this run past the 0.5 MiB left of its budget: the agent's live blobs are at the 1024 MiB quota. A blob expires 24 hours after its write and stops counting then; write less, or run again once one has.",
        });
        // The ledger, the rows and the disk all hold the first blob and nothing of the second.
        expect(answer.blobs).toEqual([
          expect.objectContaining({ ref: answer.result.first, bytes: 1024 * 1024 }),
        ]);
        expect(store.blobs).toHaveLength(blobsBefore + 1);
        expect(store.blobs.at(-1)).toMatchObject({
          id: answer.result.first.slice("blob://".length),
          agentId: AGENT_A,
          bytes: 1024 * 1024,
        });
        const entries = await readdir(sandbox.blobsRoot(AGENT_A));
        expect(entries).toHaveLength(dirsBefore + 1);
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(store.usage.at(-1)).toMatchObject({ toolId: "tool_write_two", outcome: "ok" });
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("a module that writes and then throws still gets its row and its blob_written event, and the failure names the ref", async () => {
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    const eventsBefore = blobEvents.length;
    try {
      const result = await a.call(WRITE_THEN_THROW, {});
      expect(result.isError).toBe(true);
      const answer = body(result) as {
        error: string;
        exitCode: number;
        stderrTail: string;
        blobs: { ref: string; bytes: number; name: string }[];
      };
      expect(answer.error).toMatch(/^The tool failed \(exit code 1\)/);
      expect(answer.stderrTail).toContain("fell over after writing blob://");
      expect(answer.blobs).toEqual([
        expect.objectContaining({ bytes: 20, contentType: "text/plain", name: "kept.txt" }),
      ]);
      const id = answer.blobs[0]?.ref.slice("blob://".length) ?? "";
      expect(await readFile(join(sandbox.blobsRoot(AGENT_A), id, "data"), "utf8")).toBe(
        "kept before the fall",
      );
      expect(store.blobs).toHaveLength(blobsBefore + 1);
      expect(store.blobs.at(-1)).toMatchObject({ id, agentId: AGENT_A, bytes: 20 });
      expect(blobEvents.slice(eventsBefore)).toEqual([
        expect.objectContaining({ agentId: AGENT_A, bytes: 20, contentType: "text/plain" }),
      ]);
      expect(store.usage.at(-1)).toMatchObject({
        toolId: "tool_write_then_throw",
        outcome: "error",
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("two overlapping runs share the remainder: a detached run holds its grant until its poll settles it, and a run admitted meanwhile is handed what is left", async () => {
    const a = await connect(TOKEN_A);
    try {
      const already = store.blobs
        .filter((b) => b.agentId === AGENT_A && b.removedAt === null && b.expiresAt > new Date())
        .reduce((total, b) => total + b.bytes, 0);
      // 2.5 MiB left of the quota. The detached write-two run is handed all of it and commits 2 MiB.
      const filler = row("f0f0f0f0-0000-4000-8000-000000000001", AGENT_A, {
        bytes: GIB - 2.5 * 1024 * 1024 - already,
      });
      await withRows([filler], async () => {
        const started = body(
          await a.call("run_tool", { vendor: "demo", name: "write-two", detached: true }),
        );
        expect(started).toMatchObject({ status: "running" });
        const processName = started.processName as string;
        expect(deps.inFlight?.outstandingBudget(AGENT_A)).toBe(2.5 * 1024 * 1024);

        // Admitted while the first is outstanding: nothing left, so its first write is refused.
        const meanwhile = body(await a.call(WRITE_TWO, {})) as {
          result?: { second: { code: string } };
          refused?: string;
        };
        // write-two's first write is uncaught, so the run fails at it and the failure says so.
        expect(meanwhile).toMatchObject({
          error: expect.stringMatching(/^The tool failed \(exit code 1\)/),
          stderrTail: expect.stringContaining(
            "blob_quota: the blob would carry this run past the 0 MiB left",
          ),
        });

        const waited = body(await a.call("wait_for_process", { processName, maxWaitSeconds: 10 }));
        expect(waited).toMatchObject({ status: "completed", exitCode: 0 });
        expect((waited.result as { second: unknown }).second).toMatch(/^blob:\/\//);
        expect(deps.inFlight?.outstandingBudget(AGENT_A)).toBe(0);

        // Settled: the grant is back, and the live rows now hold the 2 MiB it committed, so the next
        // run is handed 0.5 MiB and its first 1 MiB write is refused naming that.
        const after = body(await a.call(WRITE_TWO, {}));
        expect(after).toMatchObject({
          stderrTail: expect.stringContaining("past the 0.5 MiB left of its budget"),
        });
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  it("refuses blob_quota for an agent whose live rows sum to the cap, with or without a ref in the input, and counts neither an expired nor a removed row", async () => {
    const a = await connect(TOKEN_A);
    try {
      // The blobs earlier tests wrote for agent A are live too and count; the rows added here bring
      // the live sum to one byte under the quota.
      const already = store.blobs
        .filter((b) => b.agentId === AGENT_A && b.removedAt === null && b.expiresAt > new Date())
        .reduce((total, b) => total + b.bytes, 0);
      const live = [
        row("c0c0c0c0-0000-4000-8000-000000000001", AGENT_A, { bytes: GIB / 2 }),
        row("c0c0c0c0-0000-4000-8000-000000000002", AGENT_A, { bytes: GIB / 2 - 1 - already }),
      ];
      const dead = [
        row("c0c0c0c0-0000-4000-8000-000000000003", AGENT_A, {
          bytes: GIB,
          expiresAt: new Date(Date.now() - 1000),
        }),
        row("c0c0c0c0-0000-4000-8000-000000000004", AGENT_A, { bytes: GIB, removedAt: new Date() }),
      ];
      // One byte under the quota, with a gibibyte of expired and removed rows beside: the run goes.
      await withRows([...live, ...dead], async () => {
        const under = await a.call(LIST_ITEMS, { limit: 1 });
        expect(under.isError).toBeFalsy();
        expect(body(under)).toEqual(VENDOR_BODY);
      });
      // At the quota: every run of this agent is refused, a ref in the input or not, and the number
      // is the live sum. Another agent is not at it.
      const topUp = row("c0c0c0c0-0000-4000-8000-000000000005", AGENT_A, { bytes: 1 });
      await withRows([...live, ...dead, topUp], async () => {
        const execs = sandbox.processNames(SANDBOX_A).length;
        const refusal = {
          reason: "blob_quota",
          bytes: GIB,
          quota: GIB,
          message:
            "This agent's live blobs come to 1024 MiB, at or over the 1024 MiB quota, so no tool can run for it until some expire: any tool may write a blob. A blob lives 24 hours from its write and stops counting once it has expired, the oldest first. Run the tool again once one has.",
        };
        expectRefusedAtDoor(await a.call(LIST_ITEMS, { limit: 1 }), execs, refusal);
        expectRefusedAtDoor(
          await a.call(UPLOAD_FILE, { file: `blob://${live[0]?.id}` }),
          execs,
          refusal,
        );
        const dry = await a.call("run_tool", {
          vendor: "demo",
          name: "list-items",
          input: { limit: 1 },
          dryRun: true,
        });
        expectRefusedAtDoor(dry, execs, refusal);
        expect(store.usage.at(-1)).toMatchObject({ dryRun: true, outcome: "refused" });

        const b = await connect(TOKEN_B);
        try {
          // A read asks nothing (ADR 0008), so B's run goes all the way to the vendor.
          const theirs = await b.call("run_tool", { vendor: "demo", name: "list-items" });
          expect(body(theirs)).toEqual(VENDOR_BODY);
        } finally {
          await b.close();
        }
      });
    } finally {
      await a.close();
    }
  }, 30_000);

  /**
   * The sweep's blob pass over what a real run wrote (GRA-189; ADR 0023, "the sweep deletes"): the
   * filesystem blob store over the fake sandbox's own toolbox root, which is the tree `/blobs` is a
   * link into, and a clock a day on. The door's `blob_expired` reading of the row is GRA-187's.
   */
  it("a sweep with the clock past the TTL removes the blob's directory from the agent's /blobs and keeps the row with removed_at", async () => {
    const a = await connect(TOKEN_A);
    const swept: BlobSweptEvent[] = [];
    try {
      const answer = body(await a.call(SAVE_REPORT, { limit: 1 })) as {
        result: { file: string };
      };
      const id = answer.result.file.slice("blob://".length);
      const row = () => store.blobs.find((blob) => blob.id === id);
      expect(row()?.removedAt).toBeNull();
      const hostDir = join(sandbox.blobsRoot(AGENT_A), id);
      const mountDir = join(sandbox.sandboxRoot(`agent-${AGENT_A}`), "blobs", id);
      expect((await readdir(mountDir)).sort()).toEqual(["data", "meta.json"]);

      const blobStore = createFilesystemBlobStore({ root: join(sandbox.root, "toolboxes") });
      const sweeping: McpDeps = { ...deps, blobStore, onBlobSwept: (event) => swept.push(event) };

      // Inside the TTL: kept, and nothing on disk moves.
      const early = await runSweep({ db: deps.db }, sweeping, new Date());
      expect(early.blobs.actions.filter((action) => action.agentId === AGENT_A)).toEqual([]);
      expect(await blobStore.exists(AGENT_A, id)).toBe(true);

      // A day and an hour on: removed through the store, the row marked, one event with the bytes.
      const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const report = await runSweep({ db: deps.db }, sweeping, later);
      expect(report.failed).toEqual([]);
      expect(report.blobs.actions).toContainEqual({
        agentId: AGENT_A,
        action: "remove",
        blobId: id,
        bytes: row()?.bytes,
        mark: true,
      });
      await expect(stat(hostDir)).rejects.toThrow();
      await expect(stat(mountDir)).rejects.toThrow();
      expect(await blobStore.exists(AGENT_A, id)).toBe(false);
      // Marked at the service's clock (the fake store's, real time here), as `created_at` is.
      expect(row()).toMatchObject({ id, agentId: AGENT_A, removedAt: expect.any(Date) });
      expect(swept).toContainEqual({
        agentId: AGENT_A,
        personId: PERSON,
        blobId: id,
        bytes: row()?.bytes,
        cause: "expired",
      });
      // The toolbox beside the blobs is untouched: nothing under tools/ is ever in a plan.
      expect(
        await stat(join(sandbox.toolboxRoot(PERSON), "tools/demo/save-report/v1/index.ts")),
      ).toBeTruthy();
    } finally {
      await a.close();
    }
  }, 30_000);
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

describe("a revoked connection (GRA-69)", () => {
  const CONN_REVOCABLE = "conn_revocable";
  const TOOL_COUNT_THINGS = "tool_count_things";
  const COUNT_THINGS = authoredToolName("revocable", "count-things");
  const EXECUTE_REVOCABLE = executeToolName(CONN_REVOCABLE);
  const principal = { personId: PERSON };

  /**
   * What a harness observes across the whole arc: the execute tool and the promoted tool bound to
   * the connection leave agent A's list on the revoke, with the demotion recorded as `revoke`
   * (ADR 0009 as amended 2026-09-18); A hears `tools/list_changed` and B, whose scope never named the
   * connection, hears nothing and lists the same; a snapshot client naming either tool anyway is told
   * `connection_revoked` rather than asked for an approval; the tool is still findable and promotable;
   * and the credential re-entered brings the execute tool back with no further step.
   */
  it("leaves the agent's list with its promoted tools demoted by cause revoke, announces the change to that agent alone, refuses a call that names it anyway, and the execute tool returns on reconnection", async () => {
    store.addConnection({
      id: CONN_REVOCABLE,
      personId: PERSON,
      vendor: "revocable",
      displayName: "Revocable",
      primaryHost: "https://api.revocable.example",
    });
    store.agentConnections.get(AGENT_A)?.add(CONN_REVOCABLE);
    store.addTool({
      id: TOOL_COUNT_THINGS,
      personId: PERSON,
      vendor: "revocable",
      name: "count-things",
      description: "Counts things at Revocable.",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: CONN_REVOCABLE,
      path: "tools/revocable/count-things/v1",
    });
    store.promote(AGENT_A, TOOL_COUNT_THINGS);

    const notifier = createToolListChangedNotifier({ windowMs: 300 });
    const a = await connect(TOKEN_A, 300, notifier);
    const b = await connect(TOKEN_B, 300, notifier);
    try {
      const before = await a.names();
      expect(before).toEqual(
        expect.arrayContaining([EXECUTE_REVOCABLE, COUNT_THINGS, executeToolName(CONN_DEMO)]),
      );
      const bBefore = await b.names();
      expect(bBefore).not.toContain(EXECUTE_REVOCABLE);

      const ctx = { db: deps.db };
      const result = await revokeConnectionAndNotify(
        ctx,
        principal,
        CONN_REVOCABLE,
        deps,
        notifier,
      );
      expect(result).toMatchObject({
        demoted: [{ agentId: AGENT_A, toolId: TOOL_COUNT_THINGS }],
        affectedAgentIds: [AGENT_A],
      });

      await until(() => a.notifications.length >= 1);
      expect(a.notifications).toHaveLength(1);
      expect(b.notifications).toHaveLength(0);

      const after = await a.names();
      expect(after).not.toContain(EXECUTE_REVOCABLE);
      expect(after).not.toContain(COUNT_THINGS);
      // Every other row is where it was: the other connection's execute tool and A's other promotion.
      expect(after).toEqual(
        before.filter((name) => ![EXECUTE_REVOCABLE, COUNT_THINGS].includes(name)),
      );
      expect(await b.names()).toEqual(bBefore);
      expect(store.changes.filter((c) => c.toolId === TOOL_COUNT_THINGS)).toMatchObject([
        { agentId: AGENT_A, change: "demote", cause: "revoke" },
      ]);

      // A client that snapshotted its list may still name either tool: the answer is the
      // connection's state, in `request_connection`'s words, and no approval is asked for.
      const exec = await a.call(EXECUTE_REVOCABLE, { command: "echo hi" });
      expect(exec.isError).toBe(true);
      expect(body(exec)).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
        connectionId: CONN_REVOCABLE,
      });
      const run = await a.call("run_tool", {
        vendor: "revocable",
        name: "count-things",
        input: {},
      });
      expect(run.isError).toBe(true);
      expect(body(run)).toMatchObject({ error: "refused", reason: "connection_revoked" });
      expect(store.pendingActions.size).toBe(0);

      // Nothing was deleted (ADR 0009): find_tool finds it, promote brings it back, list and all.
      const found = body(await a.call("find_tool", { query: "revocable" }));
      expect(found.tools).toMatchObject([{ tool: COUNT_THINGS, promoted: false }]);
      const promoted = body(await a.call("promote", { vendor: "revocable", name: "count-things" }));
      expect(promoted).toMatchObject({ promoted: true, changed: true });
      const brought = await a.names();
      expect(brought).toContain(COUNT_THINGS);
      expect(brought).not.toContain(EXECUTE_REVOCABLE);

      // Reconnection is the credential re-entered: the repo clears `revoked_at` (GRA-76), and the
      // execute tool is back on the next list with no other state to move.
      await setConnectionCredential(
        ctx,
        principal,
        CONN_REVOCABLE,
        { apiKey: "k" },
        deps.connection,
      );
      expect(await a.names()).toContain(EXECUTE_REVOCABLE);
    } finally {
      await a.close();
      await b.close();
      notifier.close();
    }
  }, 30_000);
});

describe("a tool whose connection was revoked follows the vendor's one live connection (GRA-122)", () => {
  const OLD = "conn_rebind_old";
  const LIVE = "conn_rebind_live";
  const SECOND = "conn_rebind_second";
  const TOOL = "tool_count_rebind";
  const call = { vendor: "rebind", name: "count-things", input: {} };

  /**
   * The live case: Gmail revoked and connected again under a new row, every Gmail tool still bound
   * to the old one. With no live row the refusal names the reconnect; with exactly one live row of
   * the vendor in the agent's scope the run goes there and the tool is rebound; with two the
   * refusal names both and rebinds nothing; a caller that names the connection is never followed.
   */
  it("runs against the one live connection and rebinds the tool to it; with none or several the refusal names the step; a named connection is never followed", async () => {
    const old = store.addConnection({
      id: OLD,
      personId: PERSON,
      vendor: "rebind",
      displayName: "Rebind (old)",
      primaryHost: "https://api.rebind.example",
    });
    store.connections.set(OLD, { ...old, revokedAt: new Date(), credentialSetAt: null });
    const { tool: bound } = store.addTool({
      id: TOOL,
      personId: PERSON,
      vendor: "rebind",
      name: "count-things",
      description: "Counts things at Rebind.",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: OLD,
      path: "tools/rebind/count-things/v1",
    });
    const scopeOfA = store.agentConnections.get(AGENT_A);
    scopeOfA?.add(OLD);
    const a = await connect(TOKEN_A);
    try {
      // No live row of the vendor: the refusal as GRA-69 left it, naming the console's reconnect.
      const none = await a.call("run_tool", call);
      expect(none.isError).toBe(true);
      expect(body(none)).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
        connectionId: OLD,
      });
      expect(body(none).message).toContain("reconnect it in the console");
      expect(body(none)).not.toHaveProperty("alternatives");
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(OLD);

      // A live row of the vendor the agent was never given is not followed either.
      store.addConnection({
        id: LIVE,
        personId: PERSON,
        vendor: "rebind",
        displayName: "Rebind (live)",
        primaryHost: "https://api.rebind.example",
      });
      const outOfScope = await a.call("run_tool", call);
      expect(body(outOfScope)).toMatchObject({ reason: "connection_revoked", connectionId: OLD });
      expect(body(outOfScope)).not.toHaveProperty("alternatives");

      // Exactly one live row of the vendor in scope: the run goes there, and the tool follows.
      scopeOfA?.add(LIVE);
      const requestsBefore = vendor.requests.length;
      const ran = await a.call("run_tool", call);
      expect(ran.isError, JSON.stringify(ran.content)).not.toBe(true);
      expect(body(ran)).toEqual(VENDOR_BODY);
      expect(vendor.requests.slice(requestsBefore).at(-1)?.headers.get("x-demo-key")).toBe(
        "rebind-live-key",
      );
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(LIVE);
      expect(store.usage.at(-1)).toMatchObject({ toolId: TOOL, outcome: "ok" });

      // Two live rows in scope: nothing is chosen, and the refusal names both.
      store.tools.set(TOOL, { ...bound, defaultConnectionId: OLD });
      store.addConnection({
        id: SECOND,
        personId: PERSON,
        vendor: "rebind",
        displayName: "Rebind (second)",
        primaryHost: "https://api.rebind.example",
      });
      scopeOfA?.add(SECOND);
      const several = await a.call("run_tool", call);
      expect(several.isError).toBe(true);
      expect(body(several)).toMatchObject({
        error: "refused",
        reason: "connection_revoked",
        connectionId: OLD,
        alternatives: [
          { connectionId: LIVE, displayName: "Rebind (live)" },
          { connectionId: SECOND, displayName: "Rebind (second)" },
        ],
      });
      expect(body(several).message).toContain("2 other live rebind connections");
      expect(body(several).message).toContain("Rebind (second)");
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(OLD);

      // A caller that names the connection said which: a revoked one is refused, alternatives or not.
      const named = await runAuthoredTool(
        deps,
        { personId: PERSON, agentId: AGENT_A },
        {
          ...call,
          connectionId: OLD,
          mode: { detached: false, timeoutSeconds: 30, dryRun: true },
          channel: NO_ELICITATION,
        },
      );
      expect(named.isError).toBe(true);
      expect(named.answer).toMatchObject({ reason: "connection_revoked", connectionId: OLD });
      expect(named.answer).not.toHaveProperty("alternatives");
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(OLD);

      // The second row out of the scope again: one live row, followed and rebound as before.
      scopeOfA?.delete(SECOND);
      const again = await a.call("run_tool", call);
      expect(again.isError).not.toBe(true);
      expect(body(again)).toEqual(VENDOR_BODY);
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(LIVE);
    } finally {
      for (const id of [OLD, LIVE, SECOND]) scopeOfA?.delete(id);
      await a.close();
    }
  }, 30_000);

  /**
   * Greptile on #98: the tool row is the person's and the scopes are per agent, so an agent whose
   * scope never held the row's live default — another agent's account — resolves to its own row of
   * the vendor each call, and the row's default, which that other agent uses, is not moved.
   */
  it("follows a live default outside this agent's scope to the agent's one live connection without rebinding, and with none or several answers connection_not_in_scope naming them", async () => {
    // The fixtures the previous case left: the tool, LIVE and SECOND live, none in A's scope.
    const tool = store.tools.get(TOOL);
    if (!tool) throw new Error("no rebind fixture");
    store.tools.set(TOOL, { ...tool, defaultConnectionId: SECOND });
    const scopeOfA = store.agentConnections.get(AGENT_A);
    const a = await connect(TOKEN_A);
    try {
      // No row of the vendor in A's scope: the refusal as it always was.
      const none = await a.call("run_tool", call);
      expect(none.isError).toBe(true);
      expect(body(none)).toMatchObject({ error: "refused", reason: "connection_not_in_scope" });
      expect(body(none).message).toContain("The person can add it in the console");
      expect(body(none)).not.toHaveProperty("alternatives");

      // One live row of the vendor in A's scope: A runs there; the row keeps the other agent's default.
      scopeOfA?.add(LIVE);
      const requestsBefore = vendor.requests.length;
      const ran = await a.call("run_tool", call);
      expect(ran.isError, JSON.stringify(ran.content)).not.toBe(true);
      expect(body(ran)).toEqual(VENDOR_BODY);
      expect(vendor.requests.slice(requestsBefore).at(-1)?.headers.get("x-demo-key")).toBe(
        "rebind-live-key",
      );
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(SECOND);

      // Two live rows in A's scope beside the default: named, and the choice is the person's.
      const THIRD = "conn_rebind_third";
      store.addConnection({
        id: THIRD,
        personId: PERSON,
        vendor: "rebind",
        displayName: "Rebind (third)",
        primaryHost: "https://api.rebind.example",
      });
      scopeOfA?.add(THIRD);
      const several = await a.call("run_tool", call);
      expect(several.isError).toBe(true);
      expect(body(several)).toMatchObject({
        error: "refused",
        reason: "connection_not_in_scope",
        alternatives: [
          { connectionId: LIVE, displayName: "Rebind (live)" },
          { connectionId: THIRD, displayName: "Rebind (third)" },
        ],
      });
      expect(body(several).message).toContain("2 live connections of the same vendor");
      expect(store.tools.get(TOOL)?.defaultConnectionId).toBe(SECOND);
      scopeOfA?.delete(THIRD);
    } finally {
      for (const id of [LIVE, SECOND]) scopeOfA?.delete(id);
      store.tools.set(TOOL, tool);
      await a.close();
    }
  }, 30_000);
});

/**
 * GRA-125 (ADR 0004 as amended 2026-09-20): a chat product's agent — one held over OAuth — lists
 * the meta-tools and its promoted tools alone; the authoring set and the execute__ tools are for an
 * agent driven by hand under a static token, and a call to one by a chat product's agent is refused
 * by name. find_tool carries the agent's connections, which is where such an agent learns the
 * connectionId acquire takes.
 */
describe("a chat product's agent", () => {
  const AGENT_CHAT = "agent_chat";
  const TOKEN_CHAT = "grft_token_for_agent_chat_00000000000000000000";

  it("lists neither the authoring set nor an execute tool, is refused by name when it calls one, and learns its connections from find_tool", async () => {
    store.addAgent({
      scopeMode: "all",
      id: AGENT_CHAT,
      personId: PERSON,
      token: TOKEN_CHAT,
      connectedVia: { clientId: "client_chat", clientName: "ChatGPT" },
    });
    const chat = await connect(TOKEN_CHAT);
    const a = await connect(TOKEN_A);
    try {
      const names = await chat.names();
      expect(names).toEqual([...META_TOOL_NAMES.filter((n) => !AUTHORING_NAMES.has(n))]);
      expect(names.some((n) => n.startsWith("execute__"))).toBe(false);
      // The static-token agent's list is what it was.
      expect(await a.names()).toContain(executeToolName(CONN_DEMO));
      expect(await a.names()).toContain("write_file");

      for (const [name, args] of [
        ["write_file", { path: "x.ts", content: "" }],
        [executeToolName(CONN_DEMO), { command: "true" }],
        ["read_web_page", { url: "https://docs.demo.example" }],
      ] as const) {
        const refused = body(await chat.call(name, args as Record<string, unknown>));
        expect(refused, name).toMatchObject({ error: "refused", reason: "advanced_tools_hidden" });
        expect(String(refused.message)).toContain("acquire");
      }

      const found = body(await chat.call("find_tool", { query: "nothing-like-this" }));
      expect(found.tools).toEqual([]);
      expect(found.connections).toEqual(
        expect.arrayContaining([
          { connectionId: CONN_DEMO, vendor: "demo", displayName: "Demo Orders" },
        ]),
      );
      expect(String(found.note)).toContain("connections");
    } finally {
      await chat.close();
      await a.close();
      store.agents.delete(AGENT_CHAT);
    }
  });
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
          inputSchema: LIST_ITEMS_SCHEMA,
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

  // Every word of the query, in any order, across the three fields (GRA-115); the rule itself is
  // `tools/find-tool.match.test.ts`, this is the same rule reached over the wire.
  it("matches every word of the query in any order, and reads a hyphenated name as words", async () => {
    const b = await connect(TOKEN_B);
    const names = (found: Record<string, unknown>) =>
      (found.tools as { name: string }[]).map((t) => t.name);
    try {
      // Out of order, and drawn from two fields: "orders" is in the description, "demo" the vendor.
      expect(names(body(await b.call("find_tool", { query: "orders demo" })))).toEqual([
        "list-items",
      ]);
      // The name "list-items" read as two words, in either order, and as the wire name.
      expect(names(body(await b.call("find_tool", { query: "items list" })))).toEqual([
        "list-items",
      ]);
      expect(names(body(await b.call("find_tool", { query: LIST_ITEMS })))).toEqual(["list-items"]);
      // A word absent from every field is a miss, however many others hit.
      expect(names(body(await b.call("find_tool", { query: "list items nowhere" })))).toEqual([]);
      // A query with no word of two or more characters is refused, never the whole toolbox.
      expect(body(await b.call("find_tool", { query: "x" }))).toMatchObject({
        error: "refused",
        reason: "input_invalid",
      });
    } finally {
      await b.close();
    }
  });
});

describe("a tool with no current version", () => {
  // What an acquire job that never passed its dry run leaves (GRA-77): the row, no pointer.
  beforeAll(async () => {
    await deps.tool.insertAuthoredTool(deps.db, {
      id: "tool_never_passed",
      personId: PERSON,
      vendor: "demo",
      name: "never-passed",
      description: "Lists items from Demo Orders, though no version of it has passed.",
      inputSchema: { type: "object" },
      readOnly: true,
      destructive: false,
      defaultConnectionId: CONN_DEMO,
    });
  });

  it("is omitted by find_tool, and refused by promote and run_tool as tool_has_no_version", async () => {
    const b = await connect(TOKEN_B);
    try {
      const found = body(await b.call("find_tool", { query: "never-passed" }));
      expect(found.tools).toEqual([]);
      // The description matches too, and the tool is still not among the hits.
      const byDescription = body(await b.call("find_tool", { query: "items from demo" }));
      expect((byDescription.tools as { name: string }[]).map((t) => t.name)).toEqual([
        "list-items",
      ]);

      const promoted = await b.call("promote", { vendor: "demo", name: "never-passed" });
      expect(promoted.isError).toBe(true);
      expect(body(promoted)).toMatchObject({ error: "refused", reason: "tool_has_no_version" });
      expect(store.isPromoted(AGENT_B, "tool_never_passed")).toBe(false);

      const ran = await b.call("run_tool", { vendor: "demo", name: "never-passed" });
      expect(ran.isError).toBe(true);
      expect(body(ran)).toMatchObject({ error: "refused", reason: "tool_has_no_version" });
    } finally {
      await b.close();
    }
  });
});

describe("runAuthoredTool by version id", () => {
  const scope = { personId: PERSON, agentId: AGENT_A };
  const dryRun = { detached: false, timeoutSeconds: 30, dryRun: true };

  it("dry-runs the version named rather than the pointer's, and stamps the report on that version", async () => {
    // A second version of list-items, published and not activated: same module, its own row.
    const v2 = await deps.tool.insertToolVersion(deps.db, {
      id: "tool_list_items_v2",
      toolId: "tool_list_items",
      versionNumber: 2,
      path: "tools/demo/list-items/v1",
      sourceHash: "fixture",
      checkOutput: { refusals: [], advice: [] },
    });
    expect(store.tools.get("tool_list_items")?.currentVersionId).toBe("tool_list_items_v1");
    const stampedBefore = store.versions.get("tool_list_items_v1")?.dryRunAt ?? null;

    const answer = await runAuthoredTool(deps, scope, {
      vendor: "demo",
      name: "list-items",
      versionId: v2.id,
      input: { limit: 1 },
      mode: dryRun,
      channel: NO_ELICITATION,
    });
    expect(answer.isError).toBe(false);
    expect((answer.answer as { dryRun: Record<string, unknown> }).dryRun).toMatchObject({
      passed: true,
    });
    expect(store.versions.get(v2.id)).toMatchObject({ dryRunOutcome: { passed: true } });
    expect(store.versions.get("tool_list_items_v1")?.dryRunAt ?? null).toBe(stampedBefore);
    expect(store.usage.at(-1)).toMatchObject({ versionId: v2.id, dryRun: true, outcome: "ok" });
    // The pointer is the caller's to move, not the run's.
    expect(store.tools.get("tool_list_items")?.currentVersionId).toBe("tool_list_items_v1");
  }, 30_000);

  it("runs against the connection the caller names instead of the tool's default, held to the agent's scope (GRA-122)", async () => {
    // The tool bound to another person's row: the default would be refused, the named connection runs.
    const tool = store.tools.get("tool_list_items");
    if (!tool) throw new Error("no list-items fixture");
    store.tools.set("tool_list_items", { ...tool, defaultConnectionId: "conn_theirs" });
    try {
      const requestsBefore = vendor.requests.length;
      const named = await runAuthoredTool(deps, scope, {
        vendor: "demo",
        name: "list-items",
        versionId: "tool_list_items_v1",
        connectionId: CONN_DEMO,
        input: { limit: 1 },
        mode: dryRun,
        channel: NO_ELICITATION,
      });
      expect(named.isError, JSON.stringify(named.answer)).toBe(false);
      expect(vendor.requests.slice(requestsBefore).at(-1)?.headers.get("x-demo-key")).toBe(API_KEY);
      // Naming the connection binds nothing: the row's default is the publish's and the pass's to move.
      expect(store.tools.get("tool_list_items")?.defaultConnectionId).toBe("conn_theirs");

      // Another person's row, and the person's own row outside this agent's scope, are both refused
      // before anything runs — the scope names the person's rows and no others.
      for (const connectionId of ["conn_theirs", CONN_OTHER, "no_such_connection"]) {
        const refused = await runAuthoredTool(deps, scope, {
          vendor: "demo",
          name: "list-items",
          connectionId,
          input: {},
          mode: dryRun,
          channel: NO_ELICITATION,
        });
        expect(refused.isError).toBe(true);
        expect(refused.answer).toMatchObject({
          error: "refused",
          reason: "connection_not_in_scope",
          message: expect.stringContaining(`was asked to run against connection ${connectionId}`),
        });
        expect(store.usage.at(-1)).toMatchObject({ outcome: "refused", toolId: "tool_list_items" });
      }
    } finally {
      store.tools.set("tool_list_items", tool);
    }
  }, 30_000);

  it("refuses a version that is another tool's, or nobody's, before anything runs", async () => {
    for (const versionId of ["tool_other_ping_v1", "tool_theirs_v1", "no_such_version"]) {
      const answer = await runAuthoredTool(deps, scope, {
        vendor: "demo",
        name: "list-items",
        versionId,
        input: {},
        mode: dryRun,
        channel: NO_ELICITATION,
      });
      expect(answer.isError).toBe(true);
      expect(answer.answer).toMatchObject({ error: "refused", reason: "version_not_found" });
      expect(store.usage.at(-1)).toMatchObject({ outcome: "refused", toolId: "tool_list_items" });
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
      // The schema rides beside the problems, so a caller whose list never showed the tool can
      // make the second call right (GRA-78).
      expect(body(refused).inputSchema).toEqual(LIST_ITEMS_SCHEMA);
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

/**
 * A sandbox first seeded with a runner that had no `ctx.blob` runs the server's runner on its next
 * open (GRA-193; ADR 0013 as corrected, ADR 0023): the sandbox is the agent's and is never
 * destroyed, and each server seeds its own `/graft/<hash>/` and runs from it, so what an older
 * server left at the fixed path is never what runs. Proved both ways: with the stripped runner
 * standing at this server's own path (present means seeded), the blob tool fails inside the module;
 * with that directory absent, as in a sandbox that never met this server, the same call seeds and
 * succeeds, and the older runner at `/graft/runner.mjs` is untouched.
 */
describe("a sandbox seeded before ctx.blob existed", () => {
  const BLOB_MEMBER = "blob: Object.freeze({ write: blobWrite, read: blobRead, stat: blobStat }),";

  it("runs a tool that writes a blob from the server's own runner directory, whatever an older server left at the fixed path", async () => {
    const source = await loadRunnerSource();
    expect(source).toContain(BLOB_MEMBER);
    const stripped = (source ?? "").replace(BLOB_MEMBER, "");
    const sandboxName = `agent-${AGENT_A}`;
    const { handle } = await sandbox.ensure({ name: sandboxName });
    const runner = await seededRunnerPath(deps);
    expect(runner).toMatch(/^\/graft\/[0-9a-f]{64}\/runner\.mjs$/);
    // An older server's runner at its fixed path, and the same bytes standing in at this server's
    // path: the open finds its runner present and leaves it, so the stripped one runs.
    await handle.writeTree([{ path: RUNNER_FILE, content: stripped }], RUNNER_DIR);
    await handle.writeTree([{ path: RUNNER_FILE, content: stripped }], posix.dirname(runner));

    const a = await connect(TOKEN_A);
    try {
      const before = await a.call(SAVE_REPORT, { limit: 1 });
      expect(before.isError).toBe(true);
      // `ctx.blob` is undefined in that runner, and the module's first use of it is `.write`.
      expect((before.content[0] as { text: string }).text).toContain(
        "Cannot read properties of undefined (reading 'write')",
      );

      // Behind the seam, this server's directory removed: the sandbox as one that never met this
      // server holds it. The open seeds it whole and the blob write goes through.
      await rm(join(sandbox.sandboxRoot(sandboxName), posix.dirname(runner)), {
        recursive: true,
        force: true,
      });
      const after = await a.call(SAVE_REPORT, { limit: 1 });
      expect(after.isError).toBeFalsy();
      const answer = body(after) as { result: { file: string }; blobs: unknown[] };
      expect(answer.result.file).toMatch(/^blob:\/\/[0-9a-f-]{36}$/);
      expect(answer.blobs).toHaveLength(1);
      expect(await handle.read(runner)).toBe(source);
      expect(await handle.read(`${RUNNER_DIR}/${RUNNER_FILE}`)).toBe(stripped);
    } finally {
      await a.close();
    }
  });
});
