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
const CONN_OTHER = "conn_other";
/** The planted credential: shaped like nothing the job's own redaction recognises by name alone. */
const API_KEY = "zq8Wv2pLm9Kd4Xr7Tn1Bs6Yc3Hf5Jg0A";
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
    id: CONN_OTHER,
    personId: PERSON,
    vendor: "other",
    primaryHost: "https://api.other.example",
  });
  store.addAgent({
    id: AGENT_A,
    personId: PERSON,
    token: TOKEN_A,
    name: "laptop Hermes",
    connectionIds: [CONN_DEMO],
  });
  store.addAgent({ id: AGENT_B, personId: PERSON, token: TOKEN_B, connectionIds: [CONN_DEMO] });
  // A has the build approval (ADR 0008); B does not, and is what the ask is asserted on.
  store.grantBuild(AGENT_A, CONN_DEMO);

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
  args: Record<string, unknown> = {
    connectionId: CONN_DEMO,
    goal: "List the items in Demo Orders",
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
      expect(result.isError).toBe(true);
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
          hints: "GET /items",
        }),
      );
      expect(started).toEqual({
        jobId: expect.any(String),
        status: expect.stringMatching(/^(queued|running)$/),
        progress: [FIRST_PROGRESS_LINE],
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
      expect(success).toEqual({
        tool: LIST_ITEMS,
        toolId: expect.any(String),
        version: 1,
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      expect(status.progress.length).toBeGreaterThan(3);
      expect(status.progress.at(-1)).toContain("promoted into your working set");
      // Every line names its phase (GRA-71): the job's opening, a step before the first attempt,
      // or `Attempt N:`. A poller reading the same line twice knows which step is still running.
      const labelled =
        /^(Queued: |Authoring "|Asking the model |Reading the documentation: |Opening the sandbox|Attempt \d+: )/;
      for (const line of status.progress) expect(line).toMatch(labelled);
      expect(status.progress).toEqual(
        expect.arrayContaining([
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

describe("a job that fails and tries again", () => {
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
        status: "failed",
        failure:
          "sandbox_unavailable: The sandbox is unavailable: Drives feature is not enabled for this workspace; authorization: Bearer [redacted] (403)",
      });
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
