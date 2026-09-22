import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { checkModule, type ModuleCheck } from "@graft/check";
import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import {
  createScriptedModel,
  type ModelAdapter,
  type ModelSituation,
  type ModelSituationKind,
  type ModuleDraft,
  type ScriptedStep,
} from "@graft/model";
import { CREDENTIAL_REDACTED } from "@graft/proxy";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
  type PublishOutcome,
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  blobReadFieldsOf,
  FIXTURE_BLOB_CONTENT_TYPE,
  FIXTURE_BLOB_NAME,
  substituteBlobRefs,
} from "./acquire/job";
import { type AcquireRunner, type AcquireRunnerEvent, createAcquireRunner } from "./acquire/runner";
import type { AcquireFailure, AcquireStatus, AcquireSuccess } from "./acquire/shapes";
import type { McpDeps } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createToolListChangedNotifier } from "./notifier";
import { openAgentSession } from "./session";
import { createFakeDeps, createFakeStore, type FakeStore } from "./testing/fake-deps";
import { type FakeVendor, generateTestKeys, startFakeVendor } from "./testing/fake-vendor";
import { authoredToolName } from "./tool-names";
import { FIRST_PROGRESS_LINE } from "./tools/meta";

/**
 * `acquire` end to end, as a harness observes it (GRA-29's acceptance criteria) — GRA-1's primary
 * seam again: the SDK's client over the in-memory pair, the real services over in-memory fakes, the
 * fake sandbox, the real check where a criterion turns on it, a fake vendor behind the real proxy,
 * and a **scripted model** in the seat Graft's model takes (ADR 0004), so the whole loop runs with
 * no provider and no network beyond the loopback proxy. What is asserted is what the agent and the
 * person see — an answer, a notification, a tool in the list, rows the console reads — never how
 * the loop got there.
 */

const PERSON = "person_1";
const AGENT_A = "agent_a";
const AGENT_B = "agent_b";
const TOKEN_A = "grft_acquire_token_a_00000000000000000000000000";
const TOKEN_B = "grft_acquire_token_b_00000000000000000000000000";
const CONN_DEMO = "conn_demo";
/** A second Demo account of the person's, in A's scope — what a tool follows once the first is revoked (GRA-122). */
const CONN_DEMO_2 = "conn_demo_2";
const CONN_OTHER = "conn_other";
/** The planted credential: shaped like nothing the job's own redaction recognises by name alone. */
const API_KEY = "zq8Wv2pLm9Kd4Xr7Tn1Bs6Yc3Hf5Jg0A";
const API_KEY_2 = "Kd4Xr7Tn1Bs6Yc3Hf5Jg0Azq8Wv2pLm9";
const DOCS_URL = "https://docs.demo.example/items";
const LIST_ITEMS = authoredToolName("demo", "list-items");
const VENDOR_BODY = { items: [{ id: "itm_1", name: "Widget" }], vendor: "demo" };
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

const LIST_ITEMS_SCHEMA = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1 } },
  additionalProperties: false,
};

/** A `$` for module source: `${D}{x}` reads as `${x}` inside the module, and is not an interpolation here. */
const D = "$";

/** A module reading `path` — the same shape every draft below takes, so a test changes only the path. */
function readerModule(path: string): string {
  return [
    "export default async (input: Input, ctx: Context) => {",
    `  const res = await ctx.fetch(\`${path}\`);`,
    `  if (!res.ok) throw new Error(\`GET ${D}{res.status}: ${D}{await res.text()}\`);`,
    "  return await res.json();",
    "};",
    "",
  ].join("\n");
}

/** A module that creates an order — the write the loop must never make for real. */
const CREATE_ORDER_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  '  const res = await ctx.fetch("/orders", {',
  '    method: "POST",',
  '    headers: { "content-type": "application/json" },',
  "    body: JSON.stringify({ itemId: input.itemId, quantity: input.quantity }),",
  "  });",
  `  if (!res.ok) throw new Error(\`POST /orders ${D}{res.status}\`);`,
  "  return await res.json();",
  "};",
  "",
].join("\n");

const CREATE_ORDER_SCHEMA = {
  type: "object",
  properties: { itemId: { type: "string" }, quantity: { type: "integer" } },
  required: ["itemId", "quantity"],
  additionalProperties: false,
};

/** The file the vendor's export answers: 3,000 fixed bytes, so the blob's data can be compared whole. */
const EXPORT_BYTES = new Uint8Array(3_000).map((_, i) => i % 251);

/**
 * A producing tool (GRA-190; ADR 0023), in the authoring skill's shape: the vendor's body goes to
 * `ctx.blob.write` as the response's stream, typed and named from the headers, and the ref is
 * answered under `file`. Through the real check, since `ctx.blob` and `res.body` are what it types.
 */
const EXPORT_FILE_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  `  const res = await ctx.fetch(\`/export?id=${D}{input.id}\`);`,
  `  if (!res.ok || !res.body) throw new Error(\`GET /export ${D}{res.status}: ${D}{await res.text()}\`);`,
  '  const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "export.bin";',
  "  const file = await ctx.blob.write(res.body, {",
  '    contentType: res.headers.get("content-type") ?? "application/octet-stream",',
  "    name,",
  "  });",
  "  return { file, name };",
  "};",
  "",
].join("\n");
const EXPORT_FILE_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};
const EXPORT_FILE = authoredToolName("demo", "export-file");

/** The consuming tool: the ref off `input.file`, the `Blob` into a `FormData`, one write. */
const UPLOAD_FILE_MODULE = [
  "export default async (input: Input, ctx: Context) => {",
  "  const file = await ctx.blob.read(input.file);",
  "  const form = new FormData();",
  '  form.append("channel", input.channel);',
  '  form.append("file", file, input.name ?? "upload.bin");',
  '  const res = await ctx.fetch("/files/upload", { method: "POST", body: form });',
  `  if (!res.ok) throw new Error(\`POST /files/upload ${D}{res.status}: ${D}{await res.text()}\`);`,
  "  return { uploaded: input.file, status: res.status, bytes: file.size };",
  "};",
  "",
].join("\n");
const UPLOAD_FILE_SCHEMA = {
  type: "object",
  properties: { file: { type: "string" }, channel: { type: "string" }, name: { type: "string" } },
  required: ["file", "channel"],
  additionalProperties: false,
};
const UPLOAD_FILE = authoredToolName("demo", "upload-file");

function uploadDraft(testInput: Record<string, unknown>): ModuleDraft {
  return {
    name: "upload-file",
    description: "Uploads a file to a Demo Orders channel.",
    inputSchema: UPLOAD_FILE_SCHEMA,
    files: [{ path: "index.ts", content: UPLOAD_FILE_MODULE }],
    testInput,
    proofReads: [],
  };
}

function draft(overrides: Partial<ModuleDraft> & { path?: string } = {}): ModuleDraft {
  const { path, ...rest } = overrides;
  return {
    name: "list-items",
    description: "Lists items from Demo Orders, up to a limit.",
    inputSchema: LIST_ITEMS_SCHEMA,
    files: [
      { path: "index.ts", content: readerModule(path ?? `/items?limit=${D}{input.limit ?? 5}`) },
    ],
    testInput: { limit: 2 },
    proofReads: [],
    ...rest,
  };
}

const write = (on: ModelSituationKind, module: ModuleDraft, note: string): ScriptedStep => ({
  on,
  answer: { kind: "write_module", draft: module, note },
});

/** The suite's default check, which a test that swapped the real one in puts back. */
const FAKE_CHECK: ModuleCheck = async (input) => ({
  entry: input.entry,
  refusals: [],
  advice: [],
  annotations: { readOnly: true, destructive: false },
});

let sandbox: FakeSandboxBackend;
const runnerEvents: AcquireRunnerEvent[] = [];
let vendor: FakeVendor;
let store: FakeStore;
let deps: McpDeps;
let runner: AcquireRunner;

beforeAll(async () => {
  const keys = await generateTestKeys();
  vendor = await startFakeVendor({
    keys,
    connections: [
      {
        id: CONN_DEMO,
        personId: PERSON,
        primaryHost: "https://api.demo.example/v2",
        hosts: ["files.demo.example"],
        credential: { apiKey: API_KEY },
      },
      {
        id: CONN_DEMO_2,
        personId: PERSON,
        primaryHost: "https://api.demo.example/v2",
        hosts: ["files.demo.example"],
        credential: { apiKey: API_KEY_2 },
      },
    ],
    respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/items") return Response.json(VENDOR_BODY);
      // A vendor that points elsewhere, as Open-Meteo does for a keyed request (GRA-65): once to a
      // host the connection declares, once to one it does not. The real proxy hands both back.
      if (url.pathname === "/v2/moved-home") {
        return new Response(null, {
          status: 303,
          headers: { location: "https://files.demo.example/v3/archive?since=2024" },
        });
      }
      if (url.pathname === "/v2/moved-port") {
        return new Response(null, {
          status: 303,
          headers: { location: "https://api.demo.example:8443/v2/items" },
        });
      }
      if (url.pathname === "/v2/moved-relative") {
        return new Response(null, { status: 303, headers: { location: "archive?since=2024" } });
      }
      if (url.pathname === "/v2/moved") {
        return new Response(null, {
          status: 303,
          headers: { location: "https://customer.demo.example/v2/moved" },
        });
      }
      // A vendor the proxy cannot reach (GRA-79): the fetch throws as undici's does when a name
      // does not resolve, and the real proxy turns it into its marked 502.
      if (url.pathname === "/v2/unreachable") {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.demo.example"), {
            code: "ENOTFOUND",
          }),
        });
      }
      if (url.pathname === "/v2/secret-echo") {
        // The vendor quotes the key it refused — under a field name and in prose.
        return Response.json(
          { error: "unauthorized", message: `bad key ${API_KEY}`, apiKey: API_KEY },
          { status: 401 },
        );
      }
      if (url.pathname === "/v2/orders" && request.method === "POST") {
        return Response.json({ id: "ord_1", status: "created" }, { status: 201 });
      }
      // A file the vendor answers as bytes with a filename (GRA-190): what a producing tool moves
      // into a blob; and the upload a consuming tool posts the blob to.
      if (url.pathname === "/v2/export") {
        return new Response(EXPORT_BYTES, {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="invoice.pdf"',
          },
        });
      }
      if (url.pathname === "/v2/files/upload" && request.method === "POST") {
        return Response.json({ ok: true, file: { id: "F1" } }, { status: 201 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  sandbox = createFakeSandboxBackend();

  store = createFakeStore();
  store.addConnection({
    id: CONN_DEMO,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders",
    primaryHost: "https://api.demo.example/v2",
    hosts: ["files.demo.example"],
  });
  store.addConnection({
    id: CONN_DEMO_2,
    personId: PERSON,
    vendor: "demo",
    displayName: "Demo Orders (second account)",
    primaryHost: "https://api.demo.example/v2",
    hosts: ["files.demo.example"],
  });
  store.addConnection({
    id: CONN_OTHER,
    personId: PERSON,
    vendor: "other",
    primaryHost: "https://api.other.example",
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    name: "laptop Hermes",
    connectionIds: [CONN_DEMO, CONN_DEMO_2],
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT_B,
    personId: PERSON,
    token: TOKEN_B,
    connectionIds: [CONN_DEMO],
  });
  // A has the build approval (ADR 0008); B does not, and is what the ask is asserted on.
  store.grantBuild(AGENT_A, CONN_DEMO);
  store.grantBuild(AGENT_A, CONN_DEMO_2);

  const fakeCheck: ModuleCheck = async (input) => ({
    entry: input.entry,
    refusals: [],
    advice: [],
    annotations: { readOnly: true, destructive: false },
  });

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
    // The publish's check is the one the deps name at call time, so a test that swaps in the real
    // check sees it on both the loop's check step and the publish's.
    check: (input, options) => deps.checkModule(input, options),
  });

  deps = {
    ...fake,
    sandbox,
    keys,
    proxyPublicUrl: vendor.url,
    checkModule: fakeCheck,
    runnerFiles,
    skills: loadSkills,
    readWebPage: async ({ url }) =>
      url === DOCS_URL
        ? {
            ok: true,
            url,
            title: "Demo Orders API — Items",
            content: "GET /items?limit=<n> returns { items: [{ id, name }] }.",
            offset: 0,
            totalCharacters: 52,
            truncated: false,
            nextOffset: null,
            note: "untrusted",
          }
        : { ok: false, url, error: "no network in this suite" },
    listChangedWindowMs: 50,
    toolbox,
    publishTool: (args) => publishToolVersion(publish, args),
    handoff: {
      consoleUrl: "http://console.graft.test",
      secret: "graft-acquire-test-handoff-secret-long-enough-32",
      waitMs: 0,
      ttlMs: 60_000,
    },
    notifier: createToolListChangedNotifier({ windowMs: 50 }),
    inFlight: createInFlightRegistry(),
    model: null,
    acquire: { maxAttempts: 4, tokenCeiling: 400_000 },
  };
  runner = createAcquireRunner(deps, {
    concurrency: 1,
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 60,
    heartbeatMs: 200,
    onEvent: (event) => runnerEvents.push(event),
  });
  deps.acquireRunner = runner;
}, 30_000);

afterAll(async () => {
  runner.stop();
  deps.notifier?.close();
  deps.inFlight?.close();
  await sandbox.close();
  await vendor.close();
});

afterEach(() => {
  deps.model = null;
  deps.acquire = { maxAttempts: 4, tokenCeiling: 400_000 };
});

/** A harness: the SDK's client over the in-memory pair, attached to the deps' one notifier. */
async function connect(token: string) {
  const notifier = deps.notifier;
  if (!notifier) throw new Error("the fixture has no notifier");
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
    },
  };
}

function body<T = Record<string, unknown>>(result: CallToolResult): T {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text) as T;
}

const until = async (predicate: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

/** Start a job through the meta-tool and run it to its end; answers the start and the final status. */
async function acquireAndFinish(
  harness: Awaited<ReturnType<typeof connect>>,
  // `ignoreExisting`: the suite publishes `demo__list-items` over and over, and from the second
  // job on `acquire` would answer that it exists (GRA-154); the pre-check has its own describe.
  args: Record<string, unknown> = {
    connectionId: CONN_DEMO,
    goal: "List the items in Demo Orders",
    ignoreExisting: true,
  },
) {
  const started = body(await harness.call("acquire", args));
  expect(started.jobId).toEqual(expect.any(String));
  await runner.idle();
  const status = body<AcquireStatus>(
    await harness.call("acquire_status", { jobId: started.jobId }),
  );
  return { started, status, jobId: started.jobId as string };
}

const rowsOf = (jobId: string) => ({
  job: store.acquireJobs.get(jobId) as AcquireJobRow,
  attempts: [...store.acquireAttempts.values()]
    .filter((row) => row.jobId === jobId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber),
  traces: store.acquireTraces.filter((row) => row.jobId === jobId),
});

describe("the door", () => {
  it("without a build approval, acquire asks the person and creates no job", async () => {
    deps.model = createScriptedModel([]);
    const b = await connect(TOKEN_B);
    const jobsBefore = store.acquireJobs.size;
    try {
      const result = await b.call("acquire", { connectionId: CONN_DEMO, goal: "List items" });
      expect(result.isError).toBe(false);
      expect(body(result)).toMatchObject({
        error: "awaiting_approval",
        reason: "awaiting_approval",
        pendingActionId: expect.any(String),
        url: expect.stringContaining("http://console.graft.test/pending/"),
      });
      expect(store.acquireJobs.size).toBe(jobsBefore);
      const ask = [...store.pendingActions.values()].find((row) => row.agentId === AGENT_B);
      expect(ask).toMatchObject({ kind: "build", payload: { connectionId: CONN_DEMO } });
    } finally {
      await b.close();
    }
  });

  it("refuses a connection outside the agent's scope, pointing at request_connection, and a deployment with no model", async () => {
    const a = await connect(TOKEN_A);
    try {
      const outside = await a.call("acquire", { connectionId: CONN_OTHER, goal: "Ping" });
      expect(body(outside)).toMatchObject({ error: "refused", reason: "connection_not_in_scope" });
      expect(String(body(outside).message)).toContain("request_connection");

      const unconfigured = await a.call("acquire", { connectionId: CONN_DEMO, goal: "Ping" });
      expect(body(unconfigured)).toMatchObject({
        error: "refused",
        reason: "acquire_unconfigured",
      });

      const bad = await a.call("acquire", { connectionId: CONN_DEMO, goal: "" });
      expect(body(bad)).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(String(body(bad).message)).toContain("goal is required");

      // A wrong field name is named back with the accepted set, not silently dropped (GRA-130).
      const wrongField = await a.call("acquire", { connectionId: CONN_DEMO, task: "Ping" });
      expect(body(wrongField)).toMatchObject({ error: "refused", reason: "input_invalid" });
      expect(String(body(wrongField).message)).toContain("goal is required");
      expect(String(body(wrongField).message)).toContain(
        "task is not an acquire argument; it takes connectionId, goal, hints",
      );

      const unknown = await a.call("acquire_status", { jobId: "job_nobody" });
      expect(body(unknown)).toMatchObject({ error: "refused", reason: "job_not_found" });
    } finally {
      await a.close();
    }
  });
});

describe("a job that passes first time", () => {
  it("returns a job id at once, shows progress, and ends with tools/list_changed and the tool first-class in the list", async () => {
    const scripted = createScriptedModel([
      {
        on: "goal",
        answer: {
          kind: "read_docs",
          urls: [DOCS_URL, "https://docs.demo.example/missing"],
          note: "Reading the Items page of the Demo Orders documentation.",
        },
      },
      write(
        "docs",
        draft({ proofReads: ["/items?limit=1"] }),
        "Drafted list-items around GET /items.",
      ),
      {
        on: "proof",
        answer: { kind: "proceed", note: "The read answered as documented; publishing." },
      },
    ]);
    // The job holds the agent in flight for its whole length (ADR 0009): every model turn happens under the hold.
    const heldDuringTurns: boolean[] = [];
    /** What each turn was shown, so the shape a provider-backed adapter renders is asserted too. */
    const shown: ModelSituation[] = [];
    const model: ModelAdapter = {
      name: scripted.name,
      open: (context) => {
        const conversation = scripted.open(context);
        return {
          turn: async (situation) => {
            heldDuringTurns.push(deps.inFlight?.has(AGENT_A) ?? false);
            shown.push(situation);
            return conversation.turn(situation);
          },
        };
      },
    };
    deps.model = model;

    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    try {
      expect(await a.names()).not.toContain(LIST_ITEMS);

      const started = body(
        await a.call("acquire", {
          connectionId: CONN_DEMO,
          goal: "List the items in Demo Orders",
          ignoreExisting: true,
          hints: "GET /items",
        }),
      );
      // acquire_status's shape (GRA-125), and with the suite's wait at 0, unfinished: no result yet.
      expect(started).toEqual({
        jobId: expect.any(String),
        status: expect.stringMatching(/^(queued|running)$/),
        progress: [FIRST_PROGRESS_LINE],
        attempts: 0,
      });
      const jobId = started.jobId as string;

      // Progress while it runs — at least the first line, and the status not yet final.
      const early = body<AcquireStatus>(await a.call("acquire_status", { jobId }));
      expect(["queued", "running"]).toContain(early.status);
      expect(early.progress.length).toBeGreaterThanOrEqual(1);
      expect(early.result).toBeUndefined();

      await runner.idle();
      const status = body<AcquireStatus>(await a.call("acquire_status", { jobId }));
      expect(status.status).toBe("succeeded");
      expect(status.attempts).toBe(1);
      const success = status.result as AcquireSuccess;
      // Three names and the schema on purpose (GRA-78): a client that never refreshes its list
      // calls the tool through run_tool from this answer alone.
      expect(success).toEqual({
        tool: LIST_ITEMS,
        vendor: "demo",
        name: "list-items",
        toolId: expect.any(String),
        version: 1,
        inputSchema: LIST_ITEMS_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false },
        next: 'demo__list-items is promoted into your working set; where your tool list has not refreshed, run_tool { vendor: "demo", name: "list-items", input } calls it, with input matching inputSchema.',
      });
      expect(status.progress.length).toBeGreaterThan(3);
      expect(status.progress.at(-1)).toContain("promoted into your working set");
      // Every line names its phase (GRA-71): the job's opening, a step before the first attempt,
      // or `Attempt N:`. A poller reading the same line twice knows which step is still running.
      const labelled =
        /^(Queued: |Authoring "|Asking the model |Reading the documentation: |Opening the sandbox|Attempt \d+: )/;
      for (const line of status.progress) expect(line).toMatch(labelled);
      // A step ends with one full stop whether the loop's words or the model's note bring it
      // (GRA-91): the scripted `read_docs` note above ends with its own.
      for (const line of status.progress) expect(line).not.toContain("..");
      expect(status.progress).toEqual(
        expect.arrayContaining([
          "Reading the documentation: Reading the Items page of the Demo Orders documentation.",
          expect.stringMatching(/^Asking the model for a first draft/),
          "Attempt 1: checking the module.",
          expect.stringMatching(/^Attempt 1: publishing demo__list-items\.$/),
        ]),
      );

      await until(() => a.notifications.length >= 1);
      expect(a.notifications.length).toBeGreaterThanOrEqual(1);
      expect(await a.names()).toContain(LIST_ITEMS);
      expect(body(await a.call(LIST_ITEMS, { limit: 2 }))).toEqual(VENDOR_BODY);

      // The model saw the loop's situations, in order, and was never shown a credential.
      expect(scripted.conversations).toHaveLength(1);
      const conversation = scripted.conversations[0];
      expect(conversation?.situations.map((s) => s.kind)).toEqual(["goal", "docs", "proof"]);
      expect(conversation?.context).toMatchObject({
        jobId,
        goal: "List the items in Demo Orders",
        hints: "GET /items",
        connection: { id: CONN_DEMO, vendor: "demo", scheme: "api_key_header" },
      });
      expect(conversation?.context.skill).toContain("Authoring a tool");
      expect(JSON.stringify(conversation)).not.toContain(API_KEY);
      const docs = conversation?.situations[1];
      expect(docs?.kind === "docs" && docs.pages.map((p) => p.ok)).toEqual([true, false]);
      expect(heldDuringTurns).toEqual([true, true, true]);
      // The proof situation carries its reads as an array — the shape the seam declares and a
      // provider-backed adapter renders; a spread into an object once passed the types (GRA-31).
      const proof = shown.find((s) => s.kind === "proof");
      expect(proof && Array.isArray(proof.reads)).toBe(true);
      expect(deps.inFlight?.has(AGENT_A)).toBe(false);

      // The rows the console reads (ADR 0012).
      const { job, attempts, traces } = rowsOf(jobId);
      expect(job).toMatchObject({
        status: "succeeded",
        attempts: 1,
        toolId: success.toolId,
        hints: "GET /items",
      });
      expect(job.tokenSpend).toBe(3 * 600);
      expect(job.startedAt).toBeInstanceOf(Date);
      expect(job.finishedAt).toBeInstanceOf(Date);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNumber: 1,
        outcome: "passed",
        draftPath: `.drafts/${jobId}/a1`,
        diagnosis: "Drafted list-items around GET /items.",
        inputTokens: 500,
        outputTokens: 100,
      });
      const version = store.versions.get(attempts[0]?.versionId ?? "");
      expect(version).toMatchObject({ publisherJobId: jobId, writesInvolved: false });
      expect(version?.dryRunOutcome).toMatchObject({ dryRun: true, passed: true });
      const kinds = traces.map((row) => row.kind);
      for (const kind of [
        "progress",
        "model",
        "docs",
        "edit",
        "check",
        "proof",
        "publish",
        "dry_run",
        "result",
      ]) {
        expect(kinds, kind).toContain(kind);
      }
      expect(traces.map((row) => row.sequence)).toEqual(traces.map((_, i) => i + 1));

      // Only reads reached the vendor: the proof read and the dry run's, then the first-class call.
      const sent = vendor.requests.slice(requestsBefore);
      expect(sent.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
      expect(sent.every((r) => r.headers.get("x-demo-key") === API_KEY)).toBe(true);
    } finally {
      await a.close();
    }
  }, 30_000);
});

describe("the toolbox first (GRA-154)", () => {
  /** A goal a live tool of the vendor already covers is answered, not rebuilt; the agent may insist. */
  it("answers similar_tools_exist with the tools and their schemas, opens no job, and builds with ignoreExisting", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    const a = await connect(TOKEN_A);
    try {
      // The suite's earlier jobs left `demo__list-items` published; here the goal names it.
      const jobsBefore = store.acquireJobs.size;
      const refused = await a.call("acquire", {
        connectionId: CONN_DEMO,
        goal: "List the items in Demo Orders",
      });
      expect(refused.isError).toBe(true);
      const answer = body(refused);
      expect(answer).toMatchObject({ error: "refused", reason: "similar_tools_exist" });
      expect(answer.message).toContain("demo__list-items");
      expect(answer.message).toContain("ignoreExisting: true");
      expect(answer.tools).toEqual([
        expect.objectContaining({
          vendor: "demo",
          name: "list-items",
          tool: "demo__list-items",
          inputSchema: LIST_ITEMS_SCHEMA,
          annotations: { readOnlyHint: true, destructiveHint: false },
        }),
      ]);
      expect(store.acquireJobs.size).toBe(jobsBefore);
      // A goal the toolbox does not cover opens a job as before, no flag needed.
      const other = body(
        await a.call("acquire", {
          connectionId: CONN_DEMO,
          goal: "Cancel an order by its id and refund the payment",
        }),
      );
      expect(other.jobId).toEqual(expect.any(String));
      await runner.idle();
      // And the agent may insist.
      const { status } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
    } finally {
      await a.close();
      await runner.idle();
    }
  }, 30_000);
});

describe("a proof-only answer (GRA-153)", () => {
  /** The model proves the second path with the id the first read returned — a turn, not an attempt. */
  it("runs the added reads against the same draft, shows every read so far, and publishes on proceed with one attempt", async () => {
    const scripted = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      {
        on: "proof",
        answer: {
          kind: "prove",
          proofReads: ["/items?limit=2"],
          note: "The list answered; one more page.",
        },
      },
      { on: "proof", answer: { kind: "proceed", note: "Both reads answered as documented." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([[1, "passed"]]);
      const proofs = traces.filter((row) => row.kind === "proof").map((row) => row.text);
      expect(proofs).toEqual([
        "Proof read GET /items?limit=1: 200.",
        "Proof read GET /items?limit=2: 200.",
      ]);
      // The second proof situation carries both reads, the draft's first.
      const shown = scripted.conversations[0]?.situations.filter((s) => s.kind === "proof") ?? [];
      expect(shown.map((s) => (s.kind === "proof" ? s.reads.map((r) => r.path) : []))).toEqual([
        ["/items?limit=1"],
        ["/items?limit=1", "/items?limit=2"],
      ]);
      expect(
        traces.some(
          (row) => row.kind === "model" && row.text.startsWith("Proving attempt 1 further:"),
        ),
      ).toBe(true);
    } finally {
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  it("refuses a prove past the attempt's cap as a turn, naming the room left, and takes the proceed after", async () => {
    const scripted = createScriptedModel([
      write(
        "goal",
        draft({
          proofReads: ["/items?limit=1", "/items?limit=2", "/items?limit=3", "/items?limit=4"],
        }),
        "Drafted list-items.",
      ),
      {
        on: "proof",
        answer: { kind: "prove", proofReads: ["/items/itm_1", "/items/itm_2"], note: "Two more." },
      },
      { on: "proof", answer: { kind: "proceed", note: "Enough was proven." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([[1, "passed"]]);
      expect(traces.filter((row) => row.kind === "proof")).toHaveLength(4);
      const refused = scripted.conversations[0]?.situations.find(
        (s) => s.kind === "proof" && s.refused !== null,
      );
      expect(refused && refused.kind === "proof" ? refused.refused : null).toContain(
        "named 2 more read(s), and this attempt has 1 of 5 left",
      );
    } finally {
      await a.close();
      await runner.idle();
    }
  }, 30_000);
});

describe("a job that fails and tries again", () => {
  /**
   * GRA-125: a chat model polled `acquire_status` seven times in twelve seconds, then ran its own
   * code through `execute__` while the job it started went on to succeed unused. So `acquire` holds
   * its call for the approvals' wait and answers the settled job when it finishes in time, and
   * `acquire_status` holds its call until there is news. The suite's wait is 0 elsewhere, so every
   * other test sees the old shape; here the wait is long enough for the scripted job.
   */
  /** A publish that refuses `draft-missing` — the store's miss, not the module's (GRA-123). */
  const storeMiss = (draftPath: string): PublishOutcome =>
    ({
      ok: false,
      refusals: [
        {
          rule: "draft-missing",
          file: "index.ts",
          line: 1,
          column: 1,
          text: "",
          message: `Nothing is at ${draftPath} in the toolbox`,
          hint: "Write the draft first.",
        },
      ],
      advice: [],
      annotations: { readOnly: false, destructive: true },
    }) as never;

  /**
   * GRA-123, then GRA-141: a `draft-missing` refusal is the store's miss. The job holds the draft,
   * so it writes it through the store — the side the publish reads — and publishes again, and the
   * model never sees the miss.
   */
  it("writes the draft through the toolbox store when the publish finds nothing at it, and publishes on that", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    const publishBefore = deps.publishTool;
    const toolboxBefore = deps.toolbox;
    if (!toolboxBefore) throw new Error("no toolbox store in this suite");
    const written: { path: string; files: string[] }[] = [];
    deps.toolbox = {
      readTree: (...a) => toolboxBefore.readTree(...a),
      writeTree: async (toolboxId, path, files) => {
        written.push({ path, files: files.map((f) => f.path) });
        await toolboxBefore.writeTree(toolboxId, path, files);
      },
    };
    let calls = 0;
    deps.publishTool = async (args) => {
      calls += 1;
      // The store misses until the job has written the draft through it.
      if (written.length === 0) return storeMiss(args.draftPath);
      if (!publishBefore) throw new Error("no publish in this suite");
      return publishBefore(args);
    };
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
      expect((status.result as AcquireSuccess).tool).toBe(LIST_ITEMS);
      expect(calls).toBe(2);
      const { attempts, traces } = rowsOf(jobId);
      expect(written).toEqual([{ path: attempts[0]?.draftPath, files: ["index.ts"] }]);
      // One attempt, passed: the miss cost the model nothing and was never shown to it.
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([[1, "passed"]]);
      expect(
        traces.some(
          (row) =>
            row.kind === "publish" && row.text.includes("writing the draft through the store"),
        ),
      ).toBe(true);
      const model = deps.model as ReturnType<typeof createScriptedModel>;
      expect(model.conversations[0]?.situations.map((situation) => situation.kind)).not.toContain(
        "publish_refused",
      );
    } finally {
      deps.publishTool = publishBefore;
      deps.toolbox = toolboxBefore;
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  /** GRA-141: a store that still misses after the write is waited for, once per configured delay, before the model hears of it. */
  it("waits and asks the store again while it misses, and publishes when it answers", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    deps.acquire = { maxAttempts: 4, tokenCeiling: 400_000, storeMissRetryDelaysMs: [5, 5, 5] };
    const publishBefore = deps.publishTool;
    let calls = 0;
    deps.publishTool = async (args) => {
      calls += 1;
      // The first ask, the one after the store write, and the first wait all miss.
      if (calls <= 3) return storeMiss(args.draftPath);
      if (!publishBefore) throw new Error("no publish in this suite");
      return publishBefore(args);
    };
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
      expect(calls).toBe(4);
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([[1, "passed"]]);
      expect(
        traces.filter((row) => row.kind === "publish" && row.text.includes("waiting 5 ms")).length,
      ).toBe(2);
      const model = deps.model as ReturnType<typeof createScriptedModel>;
      expect(model.conversations[0]?.situations.map((situation) => situation.kind)).not.toContain(
        "publish_refused",
      );
    } finally {
      deps.publishTool = publishBefore;
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  /** Greptile on #114: a store write that fails is traced and the waits still run; the job does not end on it. */
  it("goes on to the waits when writing the draft through the store fails", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    deps.acquire = { maxAttempts: 4, tokenCeiling: 400_000, storeMissRetryDelaysMs: [5, 5] };
    const publishBefore = deps.publishTool;
    const toolboxBefore = deps.toolbox;
    if (!toolboxBefore) throw new Error("no toolbox store in this suite");
    deps.toolbox = {
      readTree: (...a) => toolboxBefore.readTree(...a),
      writeTree: async () => {
        throw new Error("the drive is read-only from here");
      },
    };
    let calls = 0;
    deps.publishTool = async (args) => {
      calls += 1;
      if (calls === 1) return storeMiss(args.draftPath);
      if (!publishBefore) throw new Error("no publish in this suite");
      return publishBefore(args);
    };
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("succeeded");
      // The miss, then the first wait's ask — the failed write asked nothing.
      expect(calls).toBe(2);
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([[1, "passed"]]);
      expect(
        traces.some(
          (row) =>
            row.kind === "publish" &&
            row.text.includes("Writing the draft through the store failed (the drive is read-only"),
        ),
      ).toBe(true);
    } finally {
      deps.publishTool = publishBefore;
      deps.toolbox = toolboxBefore;
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  /** GRA-141: the floor. A store that never answers reaches the model as `publish_refused`, as before. */
  it("shows the model the draft-missing refusal only once the store write and every wait have missed", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
      {
        on: "publish_refused",
        answer: { kind: "give_up", reason: "The toolbox lost the draft." },
      },
    ]);
    deps.acquire = { maxAttempts: 4, tokenCeiling: 400_000, storeMissRetryDelaysMs: [5, 5] };
    const publishBefore = deps.publishTool;
    let calls = 0;
    deps.publishTool = async (args) => {
      calls += 1;
      return storeMiss(args.draftPath);
    };
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a);
      expect(status.status).toBe("failed");
      // One ask, one after the store write, one per wait.
      expect(calls).toBe(4);
      const { attempts } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([
        [1, "publish_refused"],
      ]);
      const model = deps.model as ReturnType<typeof createScriptedModel>;
      const refused = model.conversations[0]?.situations.find((s) => s.kind === "publish_refused");
      expect(refused).toMatchObject({
        kind: "publish_refused",
        refusals: [{ rule: "draft-missing" }],
      });
    } finally {
      deps.publishTool = publishBefore;
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  it("acquire waits for the job and answers the result when it settles in time; acquire_status waits for news", async () => {
    const scripted = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    deps.model = scripted;
    const waitBefore = deps.handoff.waitMs;
    deps.handoff = { ...deps.handoff, waitMs: 20_000, pollMs: 25 };
    const a = await connect(TOKEN_A);
    try {
      const settled = body<AcquireStatus>(
        await a.call("acquire", {
          connectionId: CONN_DEMO,
          goal: "List the items",
          ignoreExisting: true,
        }),
      );
      // The job finished inside the wait: the answer is acquire_status's, result included.
      expect(settled.status).toBe("succeeded");
      expect((settled.result as AcquireSuccess).tool).toBe(LIST_ITEMS);
      expect(settled.progress.length).toBeGreaterThan(1);

      // A settled job answers at once, whatever `after` says.
      const t0 = Date.now();
      const again = body<AcquireStatus>(
        await a.call("acquire_status", { jobId: settled.jobId, after: 1000 }),
      );
      expect(again.status).toBe("succeeded");
      expect(Date.now() - t0).toBeLessThan(2_000);

      // `after` must be a count.
      const bad = await a.call("acquire_status", { jobId: settled.jobId, after: -1 });
      expect(bad.isError).toBe(true);
      expect(body(bad).reason).toBe("input_invalid");
    } finally {
      deps.handoff = { ...deps.handoff, waitMs: waitBefore, pollMs: undefined };
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  it("acquire_status holds its call until a progress line newer than the caller's arrives", async () => {
    // A model turn that waits to be released: the job sits in its first turn until `release`.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scripted = createScriptedModel([
      write("goal", draft({ proofReads: ["/items?limit=1"] }), "Drafted list-items."),
      { on: "proof", answer: { kind: "proceed", note: "Publishing." } },
    ]);
    deps.model = {
      name: scripted.name,
      open: (context) => {
        const conversation = scripted.open(context);
        let first = true;
        return {
          turn: async (situation) => {
            if (first) {
              first = false;
              await gate;
            }
            return conversation.turn(situation);
          },
        };
      },
    };
    const waitBefore = deps.handoff.waitMs;
    deps.handoff = { ...deps.handoff, waitMs: 0, pollMs: 25 };
    const a = await connect(TOKEN_A);
    try {
      const started = body<AcquireStatus>(
        await a.call("acquire", {
          connectionId: CONN_DEMO,
          goal: "List the items",
          ignoreExisting: true,
        }),
      );
      expect(["queued", "running"]).toContain(started.status);

      // With the wait at 0 the status answers at once, news or none.
      const immediate = body<AcquireStatus>(
        await a.call("acquire_status", { jobId: started.jobId, after: 1000 }),
      );
      expect(["queued", "running"]).toContain(immediate.status);

      // With a wait, the call holds until the job moves: release the model turn while it waits.
      deps.handoff = { ...deps.handoff, waitMs: 20_000, pollMs: 25 };
      const seen = immediate.progress.length;
      const pending = a.call("acquire_status", { jobId: started.jobId, after: seen });
      setTimeout(() => release(), 200);
      const news = body<AcquireStatus>(await pending);
      expect(news.progress.length).toBeGreaterThan(seen);
    } finally {
      release();
      deps.handoff = { ...deps.handoff, waitMs: waitBefore, pollMs: undefined };
      await a.close();
      await runner.idle();
    }
  }, 30_000);

  it("records a first attempt whose dry run failed and a second that passed, each with its diagnosis", async () => {
    deps.model = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-items-retry", path: "/nope" }),
        "Drafted list-items around GET /nope.",
      ),
      write(
        "dry_run_failed",
        draft({
          name: "list-items-retry",
          description: "Lists items from Demo Orders, up to a limit — the documented path.",
        }),
        "The dry run read GET /nope and the vendor answered 404; the documented path is /items.",
      ),
    ]);
    // Every pointer move, so "moved only at the pass" is a fact about the moves and not the end state.
    const moves: string[] = [];
    const setCurrent = deps.tool.setCurrentToolVersion;
    deps.tool.setCurrentToolVersion = async (db, personId, toolId, versionId) => {
      moves.push(versionId);
      return setCurrent(db, personId, toolId, versionId);
    };
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List the items in Demo Orders, second job",
        ignoreExisting: true,
      });
      expect(status.status).toBe("succeeded");
      expect(status.attempts).toBe(2);
      const retried = authoredToolName("demo", "list-items-retry");
      expect(status.result).toMatchObject({ tool: retried, version: 2 });
      expect(await a.names()).toContain(retried);

      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome, row.diagnosis])).toEqual([
        [1, "dry_run_failed", "Drafted list-items around GET /nope."],
        [
          2,
          "passed",
          "The dry run read GET /nope and the vendor answered 404; the documented path is /items.",
        ],
      ]);
      const failedVersion = store.versions.get(attempts[0]?.versionId ?? "");
      expect(failedVersion?.dryRunOutcome).toMatchObject({
        dryRun: true,
        passed: false,
        reads: [{ method: "GET", path: "/nope", status: 404 }],
      });
      const failedLine = traces.find((row) => row.kind === "dry_run" && row.attemptNumber === 1);
      expect(failedLine?.text).toContain("failed");
      expect(failedLine?.data).toMatchObject({ report: { passed: false } });
      // Both attempts published a version of the one tool; the pointer moved once, at the pass, onto
      // the version that passed (GRA-77) — v1 was never current, and keeps its failed report — the
      // definition is the passing draft's, and the tool was promoted only then.
      const toolId = failedVersion?.toolId ?? "";
      expect(store.versions.get(attempts[1]?.versionId ?? "")?.toolId).toBe(toolId);
      expect(moves).toEqual([attempts[1]?.versionId]);
      expect(store.tools.get(toolId)).toMatchObject({
        currentVersionId: attempts[1]?.versionId,
        description: "Lists items from Demo Orders, up to a limit — the documented path.",
      });
      expect(store.versions.get(attempts[0]?.versionId ?? "")?.dryRunOutcome).toMatchObject({
        passed: false,
      });
      expect(store.isPromoted(AGENT_A, toolId)).toBe(true);
      expect(
        store.changes.filter((c) => c.toolId === toolId && c.change === "promote"),
      ).toHaveLength(1);
    } finally {
      deps.tool.setCurrentToolVersion = setCurrent;
      await a.close();
    }
  }, 30_000);

  it("does not publish a draft whose proof read failed when the model answers proceed: the refusal is shown once, and the redraft publishes", async () => {
    const scripted = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-proven", path: "/nope", proofReads: ["/nope"] }),
        "Drafted around GET /nope.",
      ),
      { on: "proof", answer: { kind: "proceed", note: "Publishing despite the 404." } },
      write(
        "proof",
        draft({ name: "list-proven", proofReads: ["/items?limit=1"] }),
        "The documented path is /items.",
      ),
      { on: "proof", answer: { kind: "proceed", note: "Every read answered." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List the items, proven first",
      });
      expect(status.status).toBe("succeeded");
      // v1, not v2: attempt 1 never published (GRA-72).
      expect(status.result).toMatchObject({
        tool: authoredToolName("demo", "list-proven"),
        version: 1,
      });
      const proofs = (scripted.conversations[0]?.situations ?? []).filter(
        (s) => s.kind === "proof",
      );
      expect(proofs.map((s) => (s.kind === "proof" ? [s.attempt, s.refused] : null))).toEqual([
        [1, null],
        [
          1,
          expect.stringContaining(
            "Your `proceed` was refused: 1 of 1 proof read(s) failed (GET /nope 404), and a draft is published only when every proof read passes.",
          ),
        ],
        [2, null],
      ]);
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([
        [1, "proof_failed"],
        [2, "passed"],
      ]);
      expect(
        traces.filter((row) => row.kind === "publish").map((row) => row.attemptNumber),
      ).toEqual([2]);
      expect(status.progress).toContain(
        "Attempt 1: 1 of 1 proof read(s) failed (GET /nope 404), so the draft is not published; asking the model what to change.",
      );
    } finally {
      await a.close();
    }
  }, 30_000);

  it("ends model_failed when the model answers proceed a second time over a failed proof read", async () => {
    deps.model = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-stubborn", path: "/nope", proofReads: ["/nope"] }),
        "Drafted around GET /nope.",
      ),
      { on: "proof", answer: { kind: "proceed", note: "Publishing anyway." } },
      { on: "proof", answer: { kind: "proceed", note: "Publishing anyway, again." } },
    ]);
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List the items, stubbornly",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("model_failed");
      expect(failure.message).toContain("proceed twice after 1 of 1 proof read(s) failed");
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "proof_failed",
          summary:
            "1 of 1 proof read(s) failed (GET /nope 404); the model answered proceed a second time.",
          note: "Drafted around GET /nope.",
        },
      ]);
      const { traces } = rowsOf(jobId);
      expect(traces.some((row) => row.kind === "publish")).toBe(false);
      expect(await a.names()).not.toContain(authoredToolName("demo", "list-stubborn"));
    } finally {
      await a.close();
    }
  }, 30_000);

  /**
   * The network's answer is not the vendor's (GRA-79): the job ends on the first proof read the
   * proxy could not make, naming the host, the reason and the code, and the model is never shown
   * the 502 as something to fix.
   */
  it("ends vendor_unreachable on a proof read the proxy got no response for, after one attempt and no second model turn", async () => {
    const scripted = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-unreachable", path: "/unreachable", proofReads: ["/unreachable"] }),
        "Reading /unreachable first.",
      ),
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List the items of a vendor that is down",
      });
      expect(status.status).toBe("failed");
      expect(status.attempts).toBe(1);
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("vendor_unreachable");
      expect(failure.message).toBe(
        "The proxy got no response from api.demo.example on GET /unreachable: upstream_unreachable [ENOTFOUND]. No change to the module can fix this; try again later, or check the connection's host.",
      );
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "run_failed",
          summary:
            "The proxy got no response from api.demo.example on GET /unreachable: upstream_unreachable [ENOTFOUND].",
          note: "Reading /unreachable first.",
        },
      ]);
      expect(failure.lastDiagnostics).toMatchObject({
        proofReads: [
          {
            path: "/unreachable",
            ok: false,
            status: 502,
            reason: "upstream_unreachable",
            error: expect.stringContaining("ENOTFOUND"),
          },
        ],
      });
      // The model saw the goal and nothing after it: no proof situation, no second draft.
      expect(scripted.conversations[0]?.situations.map((s) => s.kind)).toEqual(["goal"]);
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome, row.versionId])).toEqual([
        [1, "run_failed", null],
      ]);
      expect(traces.some((row) => row.kind === "publish")).toBe(false);
      const vendorError = traces.find((row) => row.kind === "vendor_error");
      expect(vendorError?.data).toMatchObject({
        path: "/unreachable",
        status: 502,
        reason: "upstream_unreachable",
        code: "ENOTFOUND",
        host: "api.demo.example",
      });
      expect(status.progress.at(-1)).toContain("Stopped: The proxy got no response from");
      // The proxy's side of the same event: its 502, marked, and the sandbox never dialled anyone.
      expect(vendor.events.at(-1)).toMatchObject({
        outcome: "upstream_unreachable",
        status: 502,
        failure: expect.stringContaining("ENOTFOUND"),
      });
      expect(await a.names()).not.toContain(authoredToolName("demo", "list-unreachable"));
    } finally {
      await a.close();
    }
  }, 30_000);

  it("ends vendor_unreachable when the dry run's read gets no response, with the failed report on the version row", async () => {
    const scripted = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-unreachable-dry", path: "/unreachable" }),
        "Drafted around GET /unreachable.",
      ),
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List the items of a vendor that is down, unproven",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("vendor_unreachable");
      expect(failure.message).toContain("api.demo.example");
      expect(failure.message).toContain("upstream_unreachable [ENOTFOUND]");
      expect(failure.message).toContain("GET /unreachable");
      expect(scripted.conversations[0]?.situations.map((s) => s.kind)).toEqual(["goal"]);

      const { attempts, traces } = rowsOf(jobId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attemptNumber: 1, outcome: "run_failed" });
      expect(attempts[0]?.versionId).toEqual(expect.any(String));
      expect(failure.tried[0]?.summary).toContain("api.demo.example");
      expect(failure.tried[0]?.summary).toContain("[ENOTFOUND]");
      // The version was published and dry-run; the report on its row carries the runner's record
      // of the marked read, which is what the job read the ending from.
      const version = store.versions.get(attempts[0]?.versionId ?? "");
      expect(version?.dryRunOutcome).toMatchObject({
        dryRun: true,
        passed: false,
        reads: [
          {
            method: "GET",
            path: "/unreachable",
            status: 502,
            reason: "upstream_unreachable",
            code: "ENOTFOUND",
            host: "api.demo.example",
          },
        ],
      });
      expect(failure.lastDiagnostics).toMatchObject({
        dryRun: { passed: false, reads: [{ reason: "upstream_unreachable" }] },
      });
      const vendorError = traces.find((row) => row.kind === "vendor_error");
      expect(vendorError?.data).toMatchObject({
        versionId: attempts[0]?.versionId,
        read: { reason: "upstream_unreachable", code: "ENOTFOUND" },
      });
      // Published, never promoted: the tool is not in the agent's list.
      expect(await a.names()).not.toContain(authoredToolName("demo", "list-unreachable-dry"));
    } finally {
      await a.close();
    }
  }, 30_000);

  it("ends after the attempt budget with the last diagnostics and what was tried", async () => {
    deps.acquire = { maxAttempts: 2, tokenCeiling: 400_000 };
    deps.model = createScriptedModel([
      write("goal", draft({ name: "list-nothing", path: "/nope" }), "First guess: /nope."),
      write(
        "dry_run_failed",
        draft({ name: "list-nothing", path: "/nope" }),
        "Second guess: /nope again.",
      ),
      write(
        "dry_run_failed",
        draft({ name: "list-nothing", path: "/nope" }),
        "Third guess, never made.",
      ),
    ]);
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List nothing",
      });
      expect(status.status).toBe("failed");
      expect(status.attempts).toBe(2);
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("attempt_budget");
      expect(failure.message).toContain("2");
      expect(failure.lastDiagnostics).toMatchObject({
        dryRun: { passed: false, reads: [{ method: "GET", path: "/nope", status: 404 }] },
      });
      // Each summary is how that attempt ended, the model's note beside it (GRA-70): before, the
      // second draft's note stood in for the first attempt's ending.
      const listNothing = authoredToolName("demo", "list-nothing");
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "dry_run_failed",
          summary: `The dry run of ${listNothing} v1 failed: 1 read(s), 0 write(s) previewed, 0 refused; module error: Error: GET 404: {"error":"not found"}.`,
          note: "First guess: /nope.",
        },
        {
          attempt: 2,
          outcome: "dry_run_failed",
          summary: `The dry run of ${listNothing} v2 failed: 1 read(s), 0 write(s) previewed, 0 refused; module error: Error: GET 404: {"error":"not found"}.`,
          note: "Second guess: /nope again.",
        },
      ]);
      expect(status.progress.at(-1)).toContain("Stopped");
      const { job, traces, attempts } = rowsOf(jobId);
      expect(job.status).toBe("failed");
      expect(traces.at(-1)).toMatchObject({
        kind: "result",
        text: expect.stringContaining("attempt_budget"),
      });
      const nothing = authoredToolName("demo", "list-nothing");
      expect(await a.names()).not.toContain(nothing);

      // What a job that never passed leaves (GRA-77): both versions with their failed reports, the
      // tool with no current version — findable by nobody, promotable by nobody, runnable by nobody.
      const versions = attempts.map((row) => store.versions.get(row.versionId ?? ""));
      expect(versions.map((v) => v?.versionNumber)).toEqual([1, 2]);
      for (const version of versions) {
        expect(version?.dryRunOutcome).toMatchObject({ passed: false });
      }
      const tool = store.tools.get(versions[0]?.toolId ?? "");
      expect(tool).toMatchObject({ name: "list-nothing", currentVersionId: null });
      const found = body(await a.call("find_tool", { query: "list-nothing" }));
      expect(found.tools).toEqual([]);
      const promoted = await a.call("promote", { vendor: "demo", name: "list-nothing" });
      expect(promoted.isError).toBe(true);
      expect(body(promoted)).toMatchObject({ error: "refused", reason: "tool_has_no_version" });
      const ran = await a.call("run_tool", { vendor: "demo", name: "list-nothing", input: {} });
      expect(body(ran)).toMatchObject({ error: "refused", reason: "tool_has_no_version" });
      expect(store.isPromoted(AGENT_A, tool?.id ?? "")).toBe(false);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("a version that passes after a later one was activated leaves the pointer there, and the job still succeeds naming the current version", async () => {
    deps.model = createScriptedModel([
      write("goal", draft({ name: "list-raced" }), "Drafted list-raced around GET /items."),
    ]);
    // Another job's pass lands between this job's dry run and its activation: as the report is
    // recorded on v1, v2 appears on the tool and becomes current.
    const record = deps.tool.recordToolVersionDryRun;
    let racedVersionId: string | null = null;
    deps.tool.recordToolVersionDryRun = async (db, personId, versionId, outcome) => {
      const stamped = await record(db, personId, versionId, outcome);
      const tool = store.tools.get(stamped?.toolId ?? "");
      if (tool?.name === "list-raced" && racedVersionId === null) {
        const v2 = await deps.tool.insertToolVersion(db, {
          id: "list_raced_v2",
          toolId: tool.id,
          versionNumber: 2,
          path: stamped?.path ?? "",
          sourceHash: "raced",
          checkOutput: { refusals: [], advice: [] },
        });
        await deps.tool.setCurrentToolVersion(db, personId, tool.id, v2.id);
        racedVersionId = v2.id;
      }
      return stamped;
    };
    const a = await connect(TOKEN_A);
    const raced = authoredToolName("demo", "list-raced");
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List, racing another job",
      });
      expect(status.status).toBe("succeeded");
      expect(status.result).toMatchObject({ tool: raced, version: 2 });
      const { attempts, traces } = rowsOf(jobId);
      expect(attempts.map((row) => row.outcome)).toEqual(["passed"]);
      const v1 = store.versions.get(attempts[0]?.versionId ?? "");
      expect(v1).toMatchObject({ versionNumber: 1, dryRunOutcome: { passed: true } });
      const tool = store.tools.get(v1?.toolId ?? "");
      expect(tool?.currentVersionId).toBe(racedVersionId);
      expect(store.isPromoted(AGENT_A, tool?.id ?? "")).toBe(true);
      expect(await a.names()).toContain(raced);
      expect(traces.filter((row) => row.kind === "publish").map((row) => row.text)).toContainEqual(
        expect.stringContaining("v2 is already current"),
      );
      expect(status.progress.at(-1)).toContain("so demo__list-raced runs as v2");
    } finally {
      deps.tool.recordToolVersionDryRun = record;
      await a.close();
    }
  }, 30_000);

  it("a later job over the same vendor and name publishes v2 and the pointer lands on it", async () => {
    deps.acquire = { maxAttempts: 1, tokenCeiling: 400_000 };
    deps.model = createScriptedModel([
      write("goal", draft({ name: "list-later", path: "/nope" }), "Guessed /nope."),
    ]);
    const a = await connect(TOKEN_A);
    const later = authoredToolName("demo", "list-later");
    try {
      const first = await acquireAndFinish(a, { connectionId: CONN_DEMO, goal: "List later" });
      expect(first.status.status).toBe("failed");
      const [v1] = rowsOf(first.jobId).attempts.map((row) =>
        store.versions.get(row.versionId ?? ""),
      );
      expect(v1).toMatchObject({ versionNumber: 1, dryRunOutcome: { passed: false } });
      const toolId = v1?.toolId ?? "";
      expect(store.tools.get(toolId)?.currentVersionId).toBeNull();
      expect(body(await a.call("find_tool", { query: "list-later" })).tools).toEqual([]);

      deps.acquire = { maxAttempts: 4, tokenCeiling: 400_000 };
      deps.model = createScriptedModel([
        write("goal", draft({ name: "list-later" }), "Read the documentation this time: /items."),
      ]);
      const second = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List later, again",
      });
      expect(second.status.status).toBe("succeeded");
      expect(second.status.result).toMatchObject({ tool: later, toolId, version: 2 });
      const [v2] = rowsOf(second.jobId).attempts.map((row) =>
        store.versions.get(row.versionId ?? ""),
      );
      expect(v2).toMatchObject({ toolId, versionNumber: 2, dryRunOutcome: { passed: true } });
      expect(store.tools.get(toolId)?.currentVersionId).toBe(v2?.id);
      // v1 is still there with its report (ADR 0009), and the tool is now findable and in the list.
      expect(store.versions.get(v1?.id ?? "")).toMatchObject({ dryRunOutcome: { passed: false } });
      expect(body(await a.call("find_tool", { query: "list-later" })).tools).toMatchObject([
        { tool: later, promoted: true },
      ]);
      expect(await a.names()).toContain(later);
    } finally {
      await a.close();
    }
  }, 60_000);

  /**
   * GRA-122's live case: the person revoked the connection a tool was authored against and
   * connected the vendor again under another row; a job against the new row publishes v2 of the
   * same tool. The dry run must run against the job's connection, not the row's revoked default,
   * and the row must follow — at publish, before the pass — so the job spends no attempt on a
   * refusal the model cannot fix.
   */
  it("dry-runs a republished version against the job's connection, not the tool row's revoked default, and rebinds the row at publish (GRA-122)", async () => {
    const CONN_GONE = "conn_demo_gone";
    const gone = store.addConnection({
      id: CONN_GONE,
      personId: PERSON,
      vendor: "demo",
      displayName: "Demo Orders (revoked)",
      primaryHost: "https://api.demo.example/v2",
    });
    store.connections.set(CONN_GONE, {
      ...gone,
      revokedAt: new Date(),
      credentialCiphertext: null,
      credentialSetAt: null,
    });
    store.agentConnections.get(AGENT_A)?.add(CONN_GONE);
    const rebound = authoredToolName("demo", "list-rebound");
    // Every patch to a tool row, so the publish's rebind is told apart from the pass's definition.
    const patches: Record<string, unknown>[] = [];
    const update = deps.tool.updateAuthoredTool;
    deps.tool.updateAuthoredTool = async (db, personId, toolId, patch) => {
      patches.push(patch);
      return update(db, personId, toolId, patch);
    };
    const a = await connect(TOKEN_A);
    try {
      deps.model = createScriptedModel([
        write("goal", draft({ name: "list-rebound" }), "Read the documentation: /items."),
      ]);
      const first = await acquireAndFinish(a, { connectionId: CONN_DEMO, goal: "List, rebound" });
      expect(first.status.status).toBe("succeeded");
      const toolId = (first.status.result as AcquireSuccess).toolId;
      const tool = store.tools.get(toolId);
      if (!tool) throw new Error("the first job left no tool row");
      // The row bound to the connection the person has since revoked.
      store.tools.set(toolId, { ...tool, defaultConnectionId: CONN_GONE });
      patches.length = 0;

      deps.model = createScriptedModel([
        write(
          "goal",
          draft({ name: "list-rebound", description: "Lists items from Demo Orders, again." }),
          "The documented path, again.",
        ),
      ]);
      const requestsBefore = vendor.requests.length;
      const second = await acquireAndFinish(a, {
        connectionId: CONN_DEMO_2,
        goal: "List, rebound, from the second account",
      });
      expect(second.status.status).toBe("succeeded");
      expect(second.status.attempts).toBe(1);
      expect(second.status.result).toMatchObject({ tool: rebound, toolId, version: 2 });
      expect(second.status.progress.join("\n")).not.toContain("did not run");
      // The publish rebound the row before the dry run; the pass then applied the definition.
      expect(patches[0]).toEqual({ defaultConnectionId: CONN_DEMO_2 });
      expect(store.tools.get(toolId)).toMatchObject({
        defaultConnectionId: CONN_DEMO_2,
        description: "Lists items from Demo Orders, again.",
      });
      // The dry run's read left under the second account's key, and nothing under the first's.
      const reads = vendor.requests.slice(requestsBefore);
      expect(reads.length).toBeGreaterThan(0);
      for (const request of reads) {
        expect(request.headers.get("x-demo-key")).toBe(API_KEY_2);
      }
    } finally {
      deps.tool.updateAuthoredTool = update;
      store.agentConnections.get(AGENT_A)?.delete(CONN_GONE);
      await a.close();
    }
  }, 60_000);

  it("names a refused dry run by its reason and message in the progress line and the attempt's summary, not by the word refused (GRA-122)", async () => {
    deps.acquire = { maxAttempts: 2, tokenCeiling: 400_000 };
    // A test input the tool's own schema refuses: the run is refused `input_invalid` before
    // anything reaches the sandbox — a refusal, as `connection_revoked` was live. Twice, so the
    // job ends on the attempt budget with both attempts in `tried`.
    const badInput = draft({ name: "list-badly", testInput: { limit: 0 } });
    deps.model = createScriptedModel([
      write("goal", badInput, "A test input the schema refuses."),
      write("dry_run_failed", badInput, "The same input again."),
      write("dry_run_failed", badInput, "A third draft, never made: the budget is spent."),
    ]);
    const a = await connect(TOKEN_A);
    try {
      const { status } = await acquireAndFinish(a, { connectionId: CONN_DEMO, goal: "List badly" });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("attempt_budget");
      const badly = authoredToolName("demo", "list-badly");
      const didNotRun = (version: number) =>
        expect.stringMatching(
          new RegExp(`^The dry run of ${badly} v${version} did not run: input_invalid: .*limit`),
        );
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "run_failed",
          summary: didNotRun(1),
          note: "A test input the schema refuses.",
        },
        { attempt: 2, outcome: "run_failed", summary: didNotRun(2), note: "The same input again." },
      ]);
      const line = status.progress.find((entry) => entry.includes("did not run"));
      expect(line).toContain(`the dry run of ${badly} did not run (input_invalid: `);
      expect(status.progress.join("\n")).not.toContain("(refused)");
    } finally {
      await a.close();
    }
  }, 30_000);

  it("ends on the token ceiling with a result naming it", async () => {
    deps.acquire = { maxAttempts: 4, tokenCeiling: 1_000 };
    deps.model = createScriptedModel([
      {
        on: "goal",
        answer: { kind: "read_docs", urls: [DOCS_URL], note: "Reading everything." },
        usage: { inputTokens: 900, outputTokens: 200 },
      },
      write("docs", draft(), "Never reached."),
    ]);
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Spend everything",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("token_ceiling");
      expect(failure.message).toContain("1000");
      expect(failure.message).toContain("1100");
      expect(rowsOf(jobId).job.tokenSpend).toBe(1_100);
      expect(rowsOf(jobId).attempts).toHaveLength(0);
    } finally {
      await a.close();
    }
  });

  it("ends sandbox_unavailable with the backing's own sentence when the backing throws a plain object, and the runner's event names it", async () => {
    // What a provider SDK throws: the vendor API's error body, not an Error. `String` of it is
    // `[object Object]`, which is all one hosted job could report of a refused drive call.
    // The body echoes a credential too, as a vendor's can: the result must carry the sentence and
    // not the value — the final result is stored and logged without a repo's redaction (job.ts).
    const refusal = {
      code: 403,
      error:
        "Drives feature is not enabled for this workspace; authorization: Bearer sk-live-0123456789abcdef",
    };
    const ensure = sandbox.ensure;
    sandbox.ensure = async () => {
      throw refusal;
    };
    deps.model = createScriptedModel([write("goal", draft(), "Never reached.")]);
    const a = await connect(TOKEN_A);
    try {
      const before = runnerEvents.length;
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Open a sandbox that the provider refuses",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("sandbox_unavailable");
      expect(failure.message).toBe(
        "The sandbox is unavailable: Drives feature is not enabled for this workspace; authorization: Bearer [redacted] (403)",
      );
      expect(JSON.stringify(failure)).not.toContain("[object Object]");
      expect(JSON.stringify(failure)).not.toContain("sk-live-");
      expect(rowsOf(jobId).job.result).not.toMatchObject({
        message: expect.stringContaining("sk-live-"),
      });
      // The row keeps the draft's note; the refusal is the attempt's summary (GRA-70).
      expect(
        rowsOf(jobId).attempts.map((r) => ({ outcome: r.outcome, diagnosis: r.diagnosis })),
      ).toEqual([{ outcome: "abandoned", diagnosis: "Never reached." }]);
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "abandoned",
          summary:
            "Set aside unpublished; The sandbox is unavailable: Drives feature is not enabled for this workspace; authorization: Bearer [redacted] (403).",
          note: "Never reached.",
        },
      ]);
      expect(runnerEvents.slice(before)).toContainEqual({
        kind: "finished",
        jobId,
        agentId: AGENT_A,
        personId: PERSON,
        status: "failed",
        failure:
          "sandbox_unavailable: The sandbox is unavailable: Drives feature is not enabled for this workspace; authorization: Bearer [redacted] (403)",
        attempts: 1,
        tokenSpend: 600,
      });
    } finally {
      sandbox.ensure = ensure;
      await a.close();
    }
  });

  it("ends sandbox_unavailable naming every cause and its code when the backing throws an Error with a chain", async () => {
    // The other thing a backing throws: an Error wrapping undici's `fetch failed`, which says
    // nothing about what failed — the host and ENOTFOUND are two causes down (GRA-80). One hosted
    // job reported `TypeError: fetch failed` and nothing else.
    const ensure = sandbox.ensure;
    sandbox.ensure = async () => {
      throw new Error("the toolbox could not be mounted", {
        cause: new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND drives.blaxel.example"), {
            code: "ENOTFOUND",
          }),
        }),
      });
    };
    deps.model = createScriptedModel([write("goal", draft(), "Never reached.")]);
    const a = await connect(TOKEN_A);
    try {
      const { status } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Open a sandbox whose drive host does not resolve",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("sandbox_unavailable");
      expect(failure.message).toBe(
        "The sandbox is unavailable: the toolbox could not be mounted (caused by TypeError: fetch failed <- Error [ENOTFOUND]: getaddrinfo ENOTFOUND drives.blaxel.example)",
      );
    } finally {
      sandbox.ensure = ensure;
      await a.close();
    }
  });

  it("tells the model a redirected proof read is about the host set: an undeclared host is named, and give_up carries it", async () => {
    const scripted = createScriptedModel([
      write("goal", draft({ name: "list-moved", proofReads: ["/moved"] }), "Reading /moved."),
      {
        on: "proof",
        answer: {
          kind: "give_up",
          reason:
            "The vendor answers at customer.demo.example, which the connection does not declare.",
        },
      },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List what moved",
      });
      expect(status.status).toBe("failed");
      const failure = status.result as AcquireFailure;
      expect(failure.failure).toBe("model_gave_up");
      expect(failure.message).toContain("customer.demo.example");
      // The attempt's summary opens with the read that failed it, then the give-up; the note is
      // the draft's own (GRA-70).
      expect(failure.tried).toEqual([
        {
          attempt: 1,
          outcome: "proof_failed",
          summary:
            "1 of 1 proof read(s) failed (GET /moved 303); the model gave up: The vendor answers at customer.demo.example, which the connection does not declare.",
          note: "Reading /moved.",
        },
      ]);
      expect(status.progress).toContain("Attempt 1: proof read 1 of 1: GET /moved.");
      // What the model was shown: the status, the host, and the remedy.
      const proof = scripted.conversations[0]?.situations.find((s) => s.kind === "proof");
      const read = proof?.kind === "proof" ? proof.reads[0] : undefined;
      expect(read).toMatchObject({
        path: "/moved",
        ok: false,
        status: 303,
        redirectTo: "customer.demo.example",
      });
      expect(read?.error).toContain(
        "redirected GET /moved to customer.demo.example/v2/moved, which this connection does not declare (it declares api.demo.example, files.demo.example)",
      );
      expect(read?.error).toContain("give_up");
      const trace = rowsOf(jobId).traces.find((row) => row.kind === "vendor_error");
      expect(trace?.data).toMatchObject({ status: 303, redirectTo: "customer.demo.example" });
      // The sandbox never dialled the vendor: the proxy saw the one read and returned the 303.
      expect(vendor.events.at(-1)).toMatchObject({ outcome: "redirect_returned", status: 303 });
    } finally {
      await a.close();
    }
  });

  it("resolves a relative Location against the URL the read went to, base path included", async () => {
    const scripted = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-moved-rel", proofReads: ["/moved-relative#top"] }),
        "Reading.",
      ),
      { on: "proof", answer: { kind: "give_up", reason: "Stopping here for the test." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      await acquireAndFinish(a, { connectionId: CONN_DEMO, goal: "List what moved, relatively" });
      const proof = scripted.conversations[0]?.situations.find((s) => s.kind === "proof");
      const read = proof?.kind === "proof" ? proof.reads[0] : undefined;
      // `archive?since=2024` beside `/v2/moved-relative` is `/v2/archive?since=2024` on the primary
      // host; the fragment never reached the vendor and plays no part.
      expect(read).toMatchObject({ ok: false, status: 303, redirectTo: "api.demo.example" });
      expect(read?.error).toContain(
        "redirected GET /moved-relative#top to api.demo.example/v2/archive?since=2024, a host this connection declares",
      );
    } finally {
      await a.close();
    }
  });

  it("says a redirect to another port is out of the proxy's reach, whatever the host set declares", async () => {
    const scripted = createScriptedModel([
      write("goal", draft({ name: "list-moved-port", proofReads: ["/moved-port"] }), "Reading."),
      { on: "proof", answer: { kind: "give_up", reason: "Stopping here for the test." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      await acquireAndFinish(a, { connectionId: CONN_DEMO, goal: "List what moved ports" });
      const proof = scripted.conversations[0]?.situations.find((s) => s.kind === "proof");
      const read = proof?.kind === "proof" ? proof.reads[0] : undefined;
      expect(read).toMatchObject({ ok: false, status: 303, redirectTo: "api.demo.example:8443" });
      expect(read?.error).toContain("on a port the proxy cannot address");
      expect(read?.error).not.toContain("ctx.proxyBase");
    } finally {
      await a.close();
    }
  });

  it("describes a redirect to a declared host as the module's to follow through ctx.proxyBase", async () => {
    const scripted = createScriptedModel([
      write("goal", draft({ name: "list-moved-home", proofReads: ["/moved-home"] }), "Reading."),
      { on: "proof", answer: { kind: "give_up", reason: "Stopping here for the test." } },
    ]);
    deps.model = scripted;
    const a = await connect(TOKEN_A);
    try {
      const { status } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List what moved home",
      });
      expect(status.status).toBe("failed");
      const proof = scripted.conversations[0]?.situations.find((s) => s.kind === "proof");
      const read = proof?.kind === "proof" ? proof.reads[0] : undefined;
      expect(read).toMatchObject({ ok: false, status: 303, redirectTo: "files.demo.example" });
      expect(read?.error).toContain(
        "redirected GET /moved-home to files.demo.example/v3/archive?since=2024, a host this connection declares",
      );
      expect(read?.error).toContain('ctx.proxyBase("files.demo.example")');
      expect(read?.error).toContain("/v3/archive?since=2024 is the path the vendor wants there");
    } finally {
      await a.close();
    }
  });
});

describe("what the rows hold", () => {
  it("keeps every trace, vendor error and report with no credential in any of them, when the vendor echoes the key", async () => {
    deps.model = createScriptedModel([
      write(
        "goal",
        draft({ name: "list-secrets", path: "/secret-echo", proofReads: ["/secret-echo"] }),
        "Drafted list-secrets around GET /secret-echo.",
      ),
      { on: "proof", answer: { kind: "give_up", reason: "The vendor refuses the credential." } },
    ]);
    const a = await connect(TOKEN_A);
    const eventsBefore = vendor.events.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Read the secrets",
      });
      expect(status.status).toBe("failed");
      expect(status.result).toMatchObject({ failure: "model_gave_up" });

      const { job, attempts, traces } = rowsOf(jobId);
      const everything = JSON.stringify({ job, attempts, traces, status });
      expect(everything).not.toContain(API_KEY);
      expect(everything).not.toMatch(JWT_SHAPE);

      const vendorError = traces.find((row) => row.kind === "vendor_error");
      expect(vendorError?.text).toContain("401");
      expect(vendorError?.text).toContain(CREDENTIAL_REDACTED);
      expect(vendorError?.data).toMatchObject({
        path: "/secret-echo",
        status: 401,
        body: expect.stringContaining(CREDENTIAL_REDACTED),
      });
      expect(attempts).toEqual([
        expect.objectContaining({ attemptNumber: 1, outcome: "proof_failed" }),
      ]);
      // The proxy did the value-based redaction, and its event says the vendor echoed the key.
      expect(vendor.events.slice(eventsBefore)).toEqual([
        expect.objectContaining({
          outcome: "forwarded",
          upstreamStatus: 401,
          credentialEchoed: true,
        }),
      ]);
      // What the model was shown carried the marker, never the key.
      const model = deps.model as ReturnType<typeof createScriptedModel>;
      const proof = model.conversations[0]?.situations[1];
      expect(proof?.kind).toBe("proof");
      expect(JSON.stringify(proof)).not.toContain(API_KEY);
      expect(JSON.stringify(proof)).toContain(CREDENTIAL_REDACTED);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("never writes to the vendor: a tool that creates an order is dry-run with the write previewed, and the vendor saw only reads", async () => {
    deps.checkModule = checkModule;
    deps.model = createScriptedModel([
      write(
        "goal",
        {
          name: "create-order",
          description: "Creates an order in Demo Orders for one item and a quantity.",
          inputSchema: CREATE_ORDER_SCHEMA,
          files: [{ path: "index.ts", content: CREATE_ORDER_MODULE }],
          testInput: { itemId: "itm_1", quantity: 2 },
          proofReads: ["/items?limit=1"],
        },
        "Drafted create-order around POST /orders.",
      ),
      { on: "proof", answer: { kind: "proceed", note: "The catalogue read works; publishing." } },
    ]);
    const a = await connect(TOKEN_A);
    const requestsBefore = vendor.requests.length;
    const eventsBefore = vendor.events.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Create an order",
      });
      expect(status.status).toBe("succeeded");
      expect(status.result).toMatchObject({
        tool: authoredToolName("demo", "create-order"),
        annotations: { readOnlyHint: false, destructiveHint: false },
      });
      const sent = vendor.requests.slice(requestsBefore);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((r) => r.method === "GET")).toBe(true);
      expect(vendor.events.slice(eventsBefore).map((e) => e.outcome)).toContain(
        "dry_run_intercepted",
      );
      const { attempts } = rowsOf(jobId);
      const version = store.versions.get(attempts[0]?.versionId ?? "");
      expect(version).toMatchObject({ writesInvolved: true });
      expect(version?.dryRunOutcome).toMatchObject({
        passed: true,
        writesPreviewed: [
          expect.objectContaining({ method: "POST", path: expect.stringContaining("/orders") }),
        ],
      });
    } finally {
      deps.checkModule = async (input) => ({
        entry: input.entry,
        refusals: [],
        advice: [],
        annotations: { readOnly: true, destructive: false },
      });
      await a.close();
    }
  }, 60_000);

  it("accepts a module built on an SDK only once it is bound to ctx.proxyKey and ctx.proxyBase", async () => {
    deps.checkModule = checkModule;
    const sdkDraft = (construction: string): ModuleDraft => ({
      name: "list-issues",
      description: "Lists Linear issues.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      files: [
        {
          path: "index.ts",
          content: [
            'import { LinearClient } from "@linear/sdk";',
            "",
            "export default async (input: Input, ctx: Context) => {",
            `  const linear = new LinearClient(${construction});`,
            "  const issues = await linear.issues();",
            "  return { count: issues.nodes.length };",
            "};",
            "",
          ].join("\n"),
        },
        {
          path: "package.json",
          content: JSON.stringify(
            { name: "list-issues", type: "module", dependencies: { "@linear/sdk": "1.0.0" } },
            null,
            2,
          ),
        },
      ],
      testInput: {},
      proofReads: [],
    });
    deps.model = createScriptedModel([
      write(
        "goal",
        sdkDraft(
          '{ apiKey: "lin_api_0123456789abcdefghijklmnop", apiUrl: "https://api.linear.app/graphql" }',
        ),
        "Drafted list-issues with the Linear SDK.",
      ),
      write(
        "check_refused",
        sdkDraft("{ apiKey: ctx.proxyKey, apiUrl: ctx.proxyBase() }"),
        "Bound the client to ctx.proxyKey and ctx.proxyBase().",
      ),
      {
        on: "publish_refused",
        answer: { kind: "give_up", reason: "No install step in this suite." },
      },
    ]);
    const a = await connect(TOKEN_A);
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "List Linear issues",
      });
      const { attempts } = rowsOf(jobId);
      expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([
        [1, "check_refused"],
        [2, "publish_refused"],
      ]);
      const refused = attempts[0]?.checkOutput as { refusals: { rule: string }[] };
      expect(refused.refusals.map((r) => r.rule)).toContain("sdk-not-bound");
      // The bound draft passed the check — the publish stopped at the install step, which the fake
      // sandbox has none of — so the only refusal on attempt two is the install's, not the check's.
      const installed = attempts[1]?.checkOutput as { refusals: { rule: string }[] };
      expect(installed.refusals.map((r) => r.rule)).toEqual(["install-failed"]);
      expect(status.result).toMatchObject({ failure: "model_gave_up" });
      // The model was told which rule refused it, at the file and line.
      const model = deps.model as ReturnType<typeof createScriptedModel>;
      const shown = model.conversations[0]?.situations[1];
      expect(shown).toMatchObject({
        kind: "check_refused",
        attempt: 1,
        refusals: expect.arrayContaining([
          expect.objectContaining({ rule: "sdk-not-bound", file: "index.ts", line: 4 }),
        ]),
      });
    } finally {
      deps.checkModule = async (input) => ({
        entry: input.entry,
        refusals: [],
        advice: [],
        annotations: { readOnly: true, destructive: false },
      });
      await a.close();
    }
  }, 60_000);
});

/**
 * A file between two tools (GRA-190; ADR 0023), as the loop authors each half: a producing tool
 * whose module writes the vendor's body as a blob, and a consuming tool whose dry run has to have a
 * blob to read — the one the test input names when it is live, a fixture the job mints when it
 * names none or a dead one. Both through the real check, since `ctx.blob` is what it types.
 */
describe("a tool that moves a file (GRA-190)", () => {
  const REF = /^blob:\/\/[0-9a-f-]{36}$/;
  const DEAD_REF = "blob://00000000-0000-4000-8000-000000000000";
  const FIXTURE_LINE = new RegExp(
    `so a fixture blob \\(\\d+ bytes of ${FIXTURE_BLOB_CONTENT_TYPE}, ${FIXTURE_BLOB_NAME.replace(".", "\\.")}\\) stands in`,
  );
  /** The ref the producing tool answers in (a), read by (b). */
  let liveRef = "";
  /** A failed job's result as the assertion's message, so the failure is named rather than "failed". */
  const failureOf = (status: AcquireStatus) =>
    status.status === "succeeded" ? "" : JSON.stringify(status.result, null, 1);

  const dryRunOf = (jobId: string) => {
    const { attempts } = rowsOf(jobId);
    return store.versions.get(attempts.at(-1)?.versionId ?? "")?.dryRunOutcome as {
      passed: boolean;
      writesPreviewed: { method: string; path: string }[];
      moduleResult: Record<string, unknown> | null;
    };
  };

  it("finds the field a module reads a blob from, and only that", () => {
    const module = (body: string) => [{ path: "index.ts", content: body }];
    expect(blobReadFieldsOf(module(UPLOAD_FILE_MODULE))).toEqual({
      readsABlob: true,
      fields: ["file"],
    });
    expect(
      blobReadFieldsOf(
        module('await ctx.blob.stat(input?.attachment); await ctx.blob.read(input["report"]);'),
      ),
    ).toEqual({ readsABlob: true, fields: ["attachment", "report"] });
    // Read through a variable: the module reads a blob, and the field is not the match's to name.
    expect(blobReadFieldsOf(module("const ref = input.file; await ctx.blob.read(ref);"))).toEqual({
      readsABlob: true,
      fields: [],
    });
    expect(blobReadFieldsOf(module(EXPORT_FILE_MODULE))).toEqual({ readsABlob: false, fields: [] });
    // A `package.json` beside the module is not source.
    expect(
      blobReadFieldsOf([{ path: "package.json", content: '{"x":"ctx.blob.read(input.a)"}' }]),
    ).toEqual({ readsABlob: false, fields: [] });
  });

  it("substitutes every dead ref, nested included, and nothing else", () => {
    const dead = new Set([DEAD_REF]);
    expect(
      substituteBlobRefs(
        {
          file: DEAD_REF,
          channel: "finance",
          more: [DEAD_REF, "blob://other"],
          meta: { f: DEAD_REF },
        },
        dead,
        "blob://fixture",
      ),
    ).toEqual({
      file: "blob://fixture",
      channel: "finance",
      more: ["blob://fixture", "blob://other"],
      meta: { f: "blob://fixture" },
    });
  });

  it("(a) a producing tool whose module writes a blob publishes, dry-runs and promotes; its run answers the ref and the ledger and the vendor's bytes are the blob", async () => {
    deps.checkModule = checkModule;
    deps.model = createScriptedModel([
      write(
        "goal",
        {
          name: "export-file",
          description: "Downloads the Demo Orders export as a file.",
          inputSchema: EXPORT_FILE_SCHEMA,
          files: [{ path: "index.ts", content: EXPORT_FILE_MODULE }],
          testInput: { id: "exp_1" },
          proofReads: [],
        },
        "Drafted export-file: the export's bytes go to ctx.blob.write.",
      ),
    ]);
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Download the latest export as a file",
        ignoreExisting: true,
      });
      expect(status.status, failureOf(status)).toBe("succeeded");
      expect(status.result).toMatchObject({
        tool: EXPORT_FILE,
        // Writing a blob moves no annotation (ADR 0023): a download that writes one stays read-only.
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      expect(status.progress.join("\n")).not.toContain("fixture");
      // The dry run wrote a real blob under the mount and it got its row, with the version.
      const dry = dryRunOf(jobId);
      expect(dry).toMatchObject({ passed: true, writesPreviewed: [] });
      expect(dry.moduleResult?.file).toMatch(REF);
      const { attempts } = rowsOf(jobId);
      expect(store.blobs.slice(blobsBefore)).toEqual([
        expect.objectContaining({
          personId: PERSON,
          agentId: AGENT_A,
          versionId: attempts[0]?.versionId,
          bytes: EXPORT_BYTES.length,
          contentType: "application/pdf",
          name: "invoice.pdf",
        }),
      ]);

      // The first-class run: the ref where a caller would look, the ledger beside it, no byte on the wire.
      const result = await a.call("run_tool", {
        vendor: "demo",
        name: "export-file",
        input: { id: "exp_2" },
      });
      expect(result.isError).toBeFalsy();
      const answer = body<{
        result: { file: string; name: string };
        blobs: Record<string, unknown>[];
      }>(result);
      expect(answer.result).toEqual({ file: expect.stringMatching(REF), name: "invoice.pdf" });
      expect(answer.blobs).toEqual([
        {
          ref: answer.result.file,
          bytes: EXPORT_BYTES.length,
          contentType: "application/pdf",
          name: "invoice.pdf",
          expiresAt: expect.any(String),
        },
      ]);
      liveRef = answer.result.file;
      const id = liveRef.slice("blob://".length);
      const data = await readFile(join(sandbox.blobsRoot(AGENT_A), id, "data"));
      expect(new Uint8Array(data)).toEqual(EXPORT_BYTES);
    } finally {
      deps.checkModule = FAKE_CHECK;
      await a.close();
    }
  }, 60_000);

  it("(b) a consuming tool whose test input names a live ref dry-runs against it, the write is intercepted, and no fixture is minted", async () => {
    expect(liveRef).toMatch(REF);
    deps.checkModule = checkModule;
    deps.model = createScriptedModel([
      write(
        "goal",
        uploadDraft({ file: liveRef, channel: "finance" }),
        "Drafted upload-file around POST /files/upload with the blob in a FormData.",
      ),
    ]);
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    const eventsBefore = vendor.events.length;
    const requestsBefore = vendor.requests.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Upload a file to a channel",
        hints: `The file to upload is ${liveRef}`,
        ignoreExisting: true,
      });
      expect(status.status, failureOf(status)).toBe("succeeded");
      expect(status.result).toMatchObject({
        tool: UPLOAD_FILE,
        annotations: { readOnlyHint: false, destructiveHint: false },
      });
      expect(status.progress.join("\n")).not.toContain("fixture");
      const { traces } = rowsOf(jobId);
      expect(traces.map((row) => row.text)).toContain(
        "The test input names 1 live blob(s); the dry run reads it.",
      );
      // The write stopped at the proxy as a preview; the vendor saw no request at all.
      expect(vendor.events.slice(eventsBefore).map((e) => e.outcome)).toContain(
        "dry_run_intercepted",
      );
      expect(vendor.requests.slice(requestsBefore)).toEqual([]);
      const dry = dryRunOf(jobId);
      expect(dry.passed).toBe(true);
      expect(dry.writesPreviewed).toEqual([
        expect.objectContaining({ method: "POST", path: expect.stringContaining("/files/upload") }),
      ]);
      expect(dry.moduleResult).toMatchObject({ uploaded: liveRef, bytes: EXPORT_BYTES.length });
      expect(store.blobs).toHaveLength(blobsBefore);
    } finally {
      deps.checkModule = FAKE_CHECK;
      await a.close();
    }
  }, 60_000);

  it("(c) with no ref in the test input, the job mints a fixture blob through the runner, says so, dry-runs against it and passes; the draft's test input is untouched", async () => {
    deps.checkModule = checkModule;
    const draft = uploadDraft({ channel: "finance" });
    deps.model = createScriptedModel([
      write("goal", draft, "Drafted upload-file; no file to hand, so the test input names none."),
    ]);
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Upload a file to a channel",
        ignoreExisting: true,
      });
      expect(status.status, failureOf(status)).toBe("succeeded");
      const line = status.progress.find((entry) => FIXTURE_LINE.test(entry));
      expect(line).toMatch(
        /^Attempt 1: the test input names no blob and the module reads one from input\.file, so a fixture blob \(\d+ bytes of text\/plain, fixture\.txt\) stands in as input\.file in the dry run's input alone; the test input itself is unchanged\.$/,
      );
      // One row for the fixture: the agent's, a few hundred bytes of text, no version, the normal TTL.
      const rows = store.blobs.slice(blobsBefore);
      expect(rows).toHaveLength(1);
      const fixture = rows[0];
      expect(fixture).toMatchObject({
        personId: PERSON,
        agentId: AGENT_A,
        versionId: null,
        contentType: FIXTURE_BLOB_CONTENT_TYPE,
        name: FIXTURE_BLOB_NAME,
        removedAt: null,
      });
      expect(fixture?.bytes).toBeGreaterThan(200);
      expect(fixture?.bytes).toBeLessThan(1_000);
      expect((fixture?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(line).toContain(`(${fixture?.bytes} bytes of`);
      // Written through the same path as any blob: the directory under the agent's mount, whole.
      const dir = join(sandbox.blobsRoot(AGENT_A), fixture?.id ?? "");
      expect((await readdir(dir)).sort()).toEqual(["data", "meta.json"]);
      const text = await readFile(join(dir, "data"), "utf8");
      expect(text).toContain("A fixture blob.");
      expect(text).toContain(jobId);
      expect(text).toContain(UPLOAD_FILE);
      expect(JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))).toMatchObject({
        agentId: AGENT_A,
        toolVersion: null,
        contentType: FIXTURE_BLOB_CONTENT_TYPE,
        name: FIXTURE_BLOB_NAME,
      });
      // The dry run read the fixture and previewed the upload.
      const dry = dryRunOf(jobId);
      expect(dry.passed).toBe(true);
      expect(dry.moduleResult).toMatchObject({
        uploaded: `blob://${fixture?.id}`,
        bytes: fixture?.bytes,
      });
      expect(dry.writesPreviewed).toEqual([
        expect.objectContaining({ method: "POST", path: expect.stringContaining("/files/upload") }),
      ]);
      // The substitution was the dry run's alone.
      expect(draft.testInput).toEqual({ channel: "finance" });
    } finally {
      deps.checkModule = FAKE_CHECK;
      await a.close();
    }
  }, 60_000);

  it("(d) a ref dead at the door is replaced by a fixture the same way, and the line names the ref and the reason", async () => {
    deps.checkModule = checkModule;
    const draft = uploadDraft({ file: DEAD_REF, channel: "finance" });
    deps.model = createScriptedModel([
      write("goal", draft, "Drafted upload-file with the ref from the hints."),
    ]);
    const a = await connect(TOKEN_A);
    const blobsBefore = store.blobs.length;
    try {
      const { status, jobId } = await acquireAndFinish(a, {
        connectionId: CONN_DEMO,
        goal: "Upload a file to a channel",
        hints: `The file to upload is ${DEAD_REF}`,
        ignoreExisting: true,
      });
      expect(status.status, failureOf(status)).toBe("succeeded");
      const line = status.progress.find((entry) => FIXTURE_LINE.test(entry));
      expect(line).toMatch(
        new RegExp(
          `^Attempt 1: the test input's ref is dead at the door \\(${DEAD_REF} blob_not_found\\), so a fixture blob \\(\\d+ bytes of text/plain, fixture\\.txt\\) stands in for it in the dry run's input alone; the test input itself is unchanged\\.$`,
        ),
      );
      const rows = store.blobs.slice(blobsBefore);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentId: AGENT_A,
        versionId: null,
        name: FIXTURE_BLOB_NAME,
        contentType: FIXTURE_BLOB_CONTENT_TYPE,
      });
      const dry = dryRunOf(jobId);
      expect(dry.passed).toBe(true);
      expect(dry.moduleResult?.uploaded).toBe(`blob://${rows[0]?.id}`);
      expect(draft.testInput).toEqual({ file: DEAD_REF, channel: "finance" });
    } finally {
      deps.checkModule = FAKE_CHECK;
      await a.close();
    }
  }, 60_000);
});

describe("the runner", () => {
  it("resumes a running job whose heartbeat went stale, abandoning the attempt its dead process left", async () => {
    deps.model = createScriptedModel([
      write("goal", draft(), "Drafted list-items again after the restart."),
    ]);
    const stale = new Date(Date.now() - 10 * 60_000);
    const job = await deps.acquireJob.insertAcquireJob(deps.db, {
      id: "job_stale",
      agentId: AGENT_A,
      connectionId: CONN_DEMO,
      goal: "List the items in Demo Orders, resumed",
      status: "running",
      attempts: 1,
      tokenSpend: 600,
      startedAt: stale,
      heartbeatAt: stale,
      progress: [FIRST_PROGRESS_LINE],
    });
    await deps.acquireJob.insertAcquireAttempt(deps.db, {
      id: "att_stale",
      jobId: job.id,
      agentId: AGENT_A,
      attemptNumber: 1,
      draftPath: `.drafts/${job.id}/a1`,
      files: [{ path: "index.ts", content: "// half-written" }],
      diagnosis: "A draft the dead process never finished.",
    });

    runner.kick();
    await runner.idle();

    const { job: finished, attempts } = rowsOf(job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.attempts).toBe(2);
    expect(finished.progress.some((line) => line.startsWith("Resumed after an interruption"))).toBe(
      true,
    );
    expect(attempts.map((row) => [row.attemptNumber, row.outcome])).toEqual([
      [1, "abandoned"],
      [2, "passed"],
    ]);
    expect(finished.result).toMatchObject({ tool: LIST_ITEMS });
    // The abandoned row keeps the dead process's own note (GRA-70): the loop never rewrites a row's
    // diagnosis, so a resumed job's `tried[].note` is always what opened the draft.
    expect(attempts[0]).toMatchObject({ diagnosis: "A draft the dead process never finished." });
  }, 30_000);

  it("leaves a running job with a live heartbeat alone", async () => {
    deps.model = createScriptedModel([]);
    await deps.acquireJob.insertAcquireJob(deps.db, {
      id: "job_live",
      agentId: AGENT_A,
      connectionId: CONN_DEMO,
      goal: "Someone else's job",
      status: "running",
      heartbeatAt: new Date(),
    });
    runner.kick();
    await runner.idle();
    expect(store.acquireJobs.get("job_live")?.status).toBe("running");
  });
});
