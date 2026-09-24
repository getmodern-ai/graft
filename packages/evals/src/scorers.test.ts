import type { AcquireAttemptRow, AcquireTraceRow } from "@graft/db/repo/acquire-job";
import type { ToolVersionRow } from "@graft/db/repo/tool";
import { MAX_INPUT_DEPTH } from "@graft/mcp";
import type { ProxyEvent } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { REPORT, SENTINEL_GRANULARITY } from "./files-vendor";
import { listItems, moveReport } from "./scenarios";
import {
  blobReadInDryRun,
  bytesArrivedIntact,
  dryRunBeforeAnyAsk,
  firstWriteThroughPublishedTool,
  MAX_MODEL_TURN_CHARS,
  modulesUseCtxBlob,
  noBlobBytesInModelTurns,
  noVendorHostInCode,
  publishBeforeFirstWrite,
  type RecordedAsk,
  readsBeforePublish,
  refTravels,
  type ScenarioRun,
  sdkBoundToProxy,
} from "./scorers";
import type { ModelTurn, TimedRequest } from "./world";

/**
 * The scorers' directions on synthetic runs: each must go red on the failure it exists to catch and
 * green on the run that avoided it. The harness test covers the green path over a real run; these
 * cover the red paths a scripted model cannot be made to produce.
 */

const T0 = 1_000_000;
const at = (ms: number) => new Date(T0 + ms);
/** The fixture job's settle point in the world's record: its four traces, positions 1 to 4. */
const SETTLED = 4;

function trace(kind: AcquireTraceRow["kind"], ms: number): AcquireTraceRow {
  return {
    id: `t_${kind}_${ms}`,
    jobId: "job_1",
    agentId: "agent_eval",
    attemptNumber: 1,
    sequence: ms,
    kind,
    text: kind,
    data: null,
    redacted: false,
    owner: "person",
    createdAt: at(ms),
  };
}

function request(
  method: string,
  path: string,
  ms: number,
  headers: Record<string, string> = {},
): TimedRequest {
  return {
    at: T0 + ms,
    method,
    url: `https://api.demo.example/v2${path}`,
    hostname: "api.demo.example",
    path: `/v2${path}`,
    headers: { "x-demo-key": "the-real-key", ...headers },
    body: null,
  };
}

function event(tool: string, dryRun: boolean): ProxyEvent {
  return {
    outcome: "forwarded",
    status: 200,
    upstreamStatus: 200,
    method: "POST",
    path: "/orders",
    hasQuery: false,
    connectionId: "conn_demo",
    personId: "person_eval",
    agentId: "agent_eval",
    tool,
    host: "api.demo.example",
    latencyMs: 1,
    requestBytes: 0,
    responseBytes: 0,
    redirectHops: 0,
    dryRun,
    dryRunOutcome: null,
    failure: null,
  } as ProxyEvent;
}

function attempt(files: { path: string; content: string }[]): AcquireAttemptRow {
  return {
    id: "a1",
    jobId: "job_1",
    agentId: "agent_eval",
    attemptNumber: 1,
    draftPath: ".drafts/job_1/a1",
    files,
    checkOutput: { refusals: [], advice: [] },
    versionId: "v1",
    diagnosis: null,
    outcome: "passed",
    inputTokens: 10,
    outputTokens: 5,
    finishedAt: at(500),
    owner: "person",
    createdAt: at(100),
    updatedAt: at(500),
  };
}

const version = (dryRunMs: number | null): ToolVersionRow => ({
  id: "v1",
  toolId: "tool_1",
  versionNumber: 1,
  path: "tools/demo/create-order/v1",
  sourceHash: "h",
  lockfileHash: null,
  checkOutput: { refusals: [], advice: [] },
  dryRunOutcome:
    dryRunMs === null
      ? null
      : { passed: true, writesPreviewed: [{ method: "POST", path: "/orders" }] },
  dryRunAt: dryRunMs === null ? null : at(dryRunMs),
  writesInvolved: true,
  publisherJobId: "job_1",
  owner: "person",
  createdAt: at(300),
});

/** A tool ask created at `ms` and recorded at `position`; inside the job when `position <= SETTLED`. */
const ask = (ms: number, answeredMs: number | null, position: number): RecordedAsk =>
  ({
    position,
    id: "pa_1",
    agentId: "agent_eval",
    kind: "tool",
    payload: { toolId: "tool_1" },
    expiresAt: at(ms + 60_000),
    answeredAt: answeredMs === null ? null : at(answeredMs),
    answer: answeredMs === null ? null : { allow: true },
    consumedAt: null,
    connectionId: "conn_demo",
    owner: "person",
    createdAt: at(ms),
    updatedAt: at(ms),
  }) as RecordedAsk;

function run(overrides: Partial<ScenarioRun>): ScenarioRun {
  return {
    scenario: listItems,
    stage: listItems,
    status: {
      jobId: "job_1",
      status: "succeeded",
      progress: [],
      attempts: 1,
      result: {
        tool: "demo__create-order",
        vendor: "demo",
        name: "create-order",
        toolId: "tool_1",
        version: 1,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: false },
        next: "demo__create-order is promoted into your working set.",
      },
    },
    job: null,
    attempts: [attempt([{ path: "index.ts", content: 'ctx.fetch("/orders")' }])],
    settled: SETTLED,
    traces: [
      trace("proof", 200),
      trace("publish", 300),
      trace("dry_run", 400),
      trace("result", 500),
    ],
    requests: [request("GET", "/items?limit=1", 250)],
    events: [],
    tool: null,
    version: version(400),
    use: null,
    asks: [],
    ledger: [],
    model: [],
    uploads: [],
    handoff: null,
    next: null,
    ms: 1,
    tokens: { input: 10, output: 5, total: 15 },
    ...overrides,
  };
}

describe("reads_before_publish", () => {
  it("is green for a read before publish and red for a write before it, or no read at all", () => {
    expect(readsBeforePublish(run({})).pass).toBe(true);
    expect(readsBeforePublish(run({ requests: [request("POST", "/orders", 250)] })).pass).toBe(
      false,
    );
    expect(readsBeforePublish(run({ requests: [] })).pass).toBe(false);
    expect(readsBeforePublish(run({ requests: [request("GET", "/items", 450)] })).pass).toBe(false);
  });
});

describe("publish_before_first_write", () => {
  it("is red when a write reached the vendor before the job's result", () => {
    expect(publishBeforeFirstWrite(run({})).pass).toBe(true);
    expect(
      publishBeforeFirstWrite(
        run({ requests: [request("GET", "/items", 250), request("POST", "/orders", 450)] }),
      ).pass,
    ).toBe(false);
    expect(
      publishBeforeFirstWrite(
        run({ requests: [request("GET", "/items", 250), request("POST", "/orders", 900)] }),
      ).pass,
    ).toBe(true);
  });
});

describe("no_vendor_host_in_code", () => {
  it("is red for the hostname or an absolute URL in any attempt, package.json excepted", () => {
    expect(noVendorHostInCode(run({}), ["api.demo.example"]).pass).toBe(true);
    expect(
      noVendorHostInCode(
        run({
          attempts: [
            attempt([{ path: "index.ts", content: 'fetch("https://api.demo.example/v2/items")' }]),
          ],
        }),
        ["api.demo.example"],
      ).pass,
    ).toBe(false);
    expect(
      noVendorHostInCode(
        run({
          attempts: [
            attempt([
              { path: "index.ts", content: "ok" },
              { path: "package.json", content: '{"homepage":"https://x"}' },
            ]),
          ],
        }),
        ["api.demo.example"],
      ).pass,
    ).toBe(true);
  });

  /** GRA-213: naming a declared host with the `host` option is the sanctioned form, not a host in the code. */
  it("is green for a declared host named with the host option, and still red for the same host anywhere else", () => {
    const hosts = ["api.demo.example", "geo.demo.example"];
    const named = 'await ctx.fetch("/v1/search", { host: "geo.demo.example" });';
    expect(
      noVendorHostInCode(
        run({ attempts: [attempt([{ path: "index.ts", content: named }])] }),
        hosts,
      ).pass,
    ).toBe(true);
    const elsewhere = `${named}\nconst base = "geo.demo.example";`;
    const score = noVendorHostInCode(
      run({ attempts: [attempt([{ path: "index.ts", content: elsewhere }])] }),
      hosts,
    );
    expect(score.pass).toBe(false);
    expect(score.detail).toContain("geo.demo.example");
  });

  /** Greptile on #169: the exemption is `ctx.fetch`'s second argument alone, not any `host:` property. */
  it("exempts a host property only on ctx.fetch's init object, at its top level", () => {
    const hosts = ["api.demo.example", "geo.demo.example"];
    const scored = (content: string) =>
      noVendorHostInCode(run({ attempts: [attempt([{ path: "index.ts", content }])] }), hosts).pass;

    expect(scored('ctx.fetch("/x", { host: "geo.demo.example" })')).toBe(true);
    // A first argument holding a comma inside a template and a call, and a quoted key among others.
    const multiline = [
      `await ctx.fetch(\`/v1/search?name=$${"{"}encodeURIComponent(input.city, ",")}\`, {`,
      '  method: "GET",',
      '  "host": "geo.demo.example",',
      '  headers: { accept: "application/json" },',
      "})",
    ].join("\n");
    expect(scored(multiline)).toBe(true);
    expect(scored('const config = { host: "geo.demo.example" };')).toBe(false);
    expect(scored('fetch("/x", { host: "geo.demo.example" })')).toBe(false);
    expect(scored('ctx.fetch({ host: "geo.demo.example" })')).toBe(false);
    expect(
      scored(
        'ctx.fetch("/x", { headers: { host: "geo.demo.example" }, host: "api.demo.example" })',
      ),
    ).toBe(false);
    expect(scored('ctx.fetch("/x", { vhost: "geo.demo.example" })')).toBe(false);
  });
});

describe("dry_run_before_any_ask", () => {
  it("is red when the version has no dry run, or an ask came before it or inside the job", () => {
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(900, 950, SETTLED + 1)] })).pass).toBe(true);
    expect(dryRunBeforeAnyAsk(run({ version: version(null) })).pass).toBe(false);
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(350, 360, 3)] })).pass).toBe(false);
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(450, 460, 4)] })).pass).toBe(false);
  });

  it("orders an ask against the settle point by position, not by the clock (GRA-63)", () => {
    // Every ask here shares the result trace's millisecond (500); only the position differs.
    // The tool's first-use ask, recorded after the job settled: never inside the job.
    const after = dryRunBeforeAnyAsk(run({ asks: [ask(500, 950, SETTLED + 1)] }));
    expect(after.pass).toBe(true);
    expect(after.detail).toBe("dry run passed; 1 ask(s), 0 before it or inside the job");
    // An ask the job created before its result: inside the job, however the clocks read.
    const before = dryRunBeforeAnyAsk(run({ asks: [ask(500, 950, SETTLED - 1)] }));
    expect(before.pass).toBe(false);
    expect(before.detail).toBe("dry run passed; 1 ask(s), 1 before it or inside the job");
    // An ask the job's own result step created, the last row before the settle point: still the job's.
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(500, 950, SETTLED)] })).pass).toBe(false);
  });
});

describe("first_write_through_published_tool", () => {
  const written = (tool: string, dryRun: boolean, answeredAt: number | null) =>
    run({
      requests: [request("GET", "/items", 250), request("POST", "/orders", 1_000)],
      events: [event("execute", true), event(tool, dryRun)],
      use: {
        input: {},
        first: {},
        ask: ask(900, 950, SETTLED + 1),
        answeredAt: answeredAt === null ? null : T0 + answeredAt,
        second: {},
        final: {},
      },
    });
  it("is green only for a write under the published tool's claim, not a dry run, after the yes", () => {
    expect(firstWriteThroughPublishedTool(written("demo__create-order", false, 950)).pass).toBe(
      true,
    );
    expect(firstWriteThroughPublishedTool(written("execute", false, 950)).pass).toBe(false);
    expect(firstWriteThroughPublishedTool(written("demo__create-order", true, 950)).pass).toBe(
      false,
    );
    expect(firstWriteThroughPublishedTool(written("demo__create-order", false, null)).pass).toBe(
      false,
    );
    expect(firstWriteThroughPublishedTool(written("demo__create-order", false, 1_500)).pass).toBe(
      false,
    );
  });
});

describe("sdk_bound_to_proxy", () => {
  const sdk = { package: "@octokit/rest", version: "22.0.1" };
  const real = { name: "authorization", value: "Bearer ghp_real" };
  const files = (manifest: string) => [
    { path: "index.ts", content: 'import { Octokit } from "@octokit/rest";' },
    { path: "package.json", content: manifest },
  ];
  const ghRequest = (headers: Record<string, string>, path = "/repos/o/r/issues") => ({
    ...request("GET", "", 250, {}),
    path,
    headers,
  });
  it("is green for the declared package, the vendor's own credential and stripped paths; red for a token or a wrong version", () => {
    const good = run({
      attempts: [attempt(files('{"dependencies":{"@octokit/rest":"22.0.1"}}'))],
      requests: [ghRequest({ authorization: "Bearer ghp_real" })],
    });
    expect(sdkBoundToProxy(good, sdk, real, "/repos/").pass).toBe(true);
    const token = run({
      ...good,
      requests: [ghRequest({ authorization: "Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln" })],
    });
    expect(sdkBoundToProxy(token, sdk, real, "/repos/").pass).toBe(false);
    const version = run({
      ...good,
      attempts: [attempt(files('{"dependencies":{"@octokit/rest":"^22"}}'))],
    });
    expect(sdkBoundToProxy(version, sdk, real, "/repos/").pass).toBe(false);
    const unstripped = run({
      ...good,
      requests: [
        ghRequest({ authorization: "Bearer ghp_real" }, "/c/conn_github/repos/o/r/issues"),
      ],
    });
    expect(sdkBoundToProxy(unstripped, sdk, real, "/repos/").pass).toBe(false);
  });
});

/**
 * The blob scorers (GRA-191) over a synthetic two-stage run: the producing stage's tool answered a
 * ref and a ledger, the consuming stage's job read that blob in its dry run and had its upload
 * intercepted, and the second vendor stored the fixture's bytes. Each scorer is then shown the one
 * failure it exists to catch.
 */
describe("the blob scorers", () => {
  const REF = "blob://0f6b6c4e-1111-4222-8333-444455556666";
  const OTHER_REF = "blob://99999999-1111-4222-8333-444455556666";
  const WRITE_MODULE =
    'export default async (input: Input, ctx: Context) => { const res = await ctx.fetch("/files/" + input.id); const file = await ctx.blob.write(res.body, { contentType: "application/pdf" }); return { file }; };';
  const READ_MODULE =
    'export default async (input: Input, ctx: Context) => { const file = await ctx.blob.read(input.file); const form = new FormData(); form.append("file", file); await ctx.fetch("/uploads", { method: "POST", body: form }); return { ok: true }; };';
  const giveUp = (reason: string) => ({ kind: "give_up", reason });

  const turn = (kind: ModelTurn["kind"], output: unknown): ModelTurn =>
    kind === "open"
      ? {
          jobId: "job_1",
          kind,
          input: {
            jobId: "job_1",
            personId: "person_eval",
            goal: "move the report",
            hints: `the file is ${REF}`,
            connection: {
              id: "conn_drop",
              vendor: "drop",
              displayName: "Drop",
              scheme: "bearer",
              primaryHost: "https://api.drop.example",
              hosts: ["api.drop.example"],
            },
            skill: "the skill",
            budget: { maxAttempts: 3, tokenCeiling: 400_000 },
          },
          output: null,
        }
      : { jobId: "job_1", kind, input: { kind: "goal" }, output };

  const intercepted = (bytes: number, dryRun = true): ProxyEvent =>
    ({
      ...event("execute", dryRun),
      outcome: dryRun ? "dry_run_intercepted" : "forwarded",
      upstreamStatus: dryRun ? null : 201,
      path: "/uploads",
      requestBytes: bytes,
    }) as ProxyEvent;

  const liveTrace = (): AcquireTraceRow => ({
    ...trace("dry_run", 350),
    text: "The test input names 1 live blob(s); the dry run reads it.",
    data: { refs: [REF] },
  });
  const fixtureTrace = (bytes: number): AcquireTraceRow => ({
    ...trace("dry_run", 350),
    text: `Minted fixture blob ${OTHER_REF} (${bytes} bytes, text/plain, fixture.txt) for the dry run of drop__upload-report; it expires at later.`,
    data: { ref: OTHER_REF, bytes },
  });

  const consumer = (overrides: Partial<ScenarioRun> = {}): ScenarioRun =>
    run({
      stage: moveReport.chain?.stage(REF) ?? moveReport,
      attempts: [attempt([{ path: "index.ts", content: READ_MODULE }])],
      traces: [
        trace("proof", 200),
        trace("publish", 300),
        liveTrace(),
        trace("dry_run", 400),
        trace("result", 500),
      ],
      requests: [request("GET", "/folders", 250), request("POST", "/uploads", 1_000)],
      events: [
        intercepted(REPORT.bytes.length + 512),
        intercepted(REPORT.bytes.length + 512, false),
      ],
      version: version(400),
      use: {
        input: { file: REF, name: "report-2026-q3.pdf" },
        first: {},
        ask: null,
        answeredAt: T0 + 950,
        second: { id: "up_1", status: "stored" },
        final: { id: "up_1", status: "stored" },
      },
      uploads: [
        {
          at: T0 + 1_000,
          id: "up_1",
          field: "file",
          name: "report-2026-q3.pdf",
          contentType: "application/pdf",
          bytes: REPORT.bytes.length,
          sha256: REPORT.sha256,
          folder: "reports",
        },
      ],
      model: [turn("open", null), turn("turn", { kind: "proceed", note: "publishing" })],
      ...overrides,
    });

  const chain = (overrides: Partial<ScenarioRun> = {}, next: ScenarioRun | null = consumer()) =>
    run({
      scenario: moveReport,
      stage: moveReport,
      attempts: [attempt([{ path: "index.ts", content: WRITE_MODULE }])],
      use: {
        input: { id: "rep_2026_q3" },
        first: {},
        ask: null,
        answeredAt: null,
        second: null,
        final: {
          result: { file: REF, name: "report-2026-q3.pdf" },
          blobs: [{ ref: REF, bytes: REPORT.bytes.length, contentType: "application/pdf" }],
        },
      },
      model: [turn("open", null), turn("turn", { kind: "proceed", note: "publishing" })],
      handoff: REF,
      next,
      ...overrides,
    });

  it("no_blob_bytes_in_model_turns: green on clean turns; red for a sentinel as text, hex or base64, an oversize turn, or no turn at all", () => {
    expect(noBlobBytesInModelTurns(chain(), REPORT).pass).toBe(true);
    const sentinel = REPORT.sentinels[2]?.text ?? "";
    expect(
      noBlobBytesInModelTurns(chain({ model: [turn("turn", giveUp(`saw ${sentinel}`))] }), REPORT)
        .pass,
    ).toBe(false);
    const asText = noBlobBytesInModelTurns(
      chain({ model: [turn("turn", giveUp(Buffer.from(REPORT.bytes).toString("latin1")))] }),
      REPORT,
    );
    expect(asText.pass).toBe(false);
    expect(asText.detail).toContain("over the");
    expect(asText.detail).toContain("as text");
    // A UTF-8 decode of the body mangles the random bytes and leaves the ASCII sentinels whole.
    const utf8 = noBlobBytesInModelTurns(
      chain({
        model: [turn("turn", giveUp(new TextDecoder().decode(REPORT.bytes.slice(0, 1_500_000))))],
      }),
      REPORT,
    );
    expect(utf8.pass).toBe(false);
    expect(utf8.detail).toContain("as text");
    const base64 = noBlobBytesInModelTurns(
      chain({
        model: [
          turn("turn", giveUp(Buffer.from(REPORT.bytes.slice(0, 1_500_000)).toString("base64"))),
        ],
      }),
      REPORT,
    );
    expect(base64.pass).toBe(false);
    expect(base64.detail).toContain("as base64");
    // A 20 KiB slice from between two of the sentinel positions the first cut of this fixture had
    // (64 KiB and a quarter of the file), so a scorer that only knew those would miss it: caught in
    // every encoding, base64 at each of its three alignments included, at under the turn bound.
    const slice = (from: number) => REPORT.bytes.slice(from, from + 20 * 1024);
    const encodings: [string, string][] = [
      ["text", Buffer.from(slice(200_000)).toString("latin1")],
      ["text", new TextDecoder().decode(slice(200_000))],
      ["hex", Buffer.from(slice(200_000)).toString("hex")],
      ["hex", Buffer.from(slice(200_000)).toString("hex").toUpperCase()],
      ["base64", Buffer.from(slice(200_000)).toString("base64")],
      ["base64", Buffer.from(slice(200_001)).toString("base64")],
      ["base64", Buffer.from(slice(200_002)).toString("base64")],
    ];
    for (const [form, text] of encodings) {
      expect(text.length).toBeLessThan(MAX_MODEL_TURN_CHARS);
      const sliced = noBlobBytesInModelTurns(
        chain({ model: [turn("turn", giveUp(text))] }),
        REPORT,
      );
      expect(sliced.pass, `${form}: ${sliced.detail}`).toBe(false);
      expect(sliced.detail).toContain(`as ${form}`);
      expect(sliced.detail).not.toContain("over the");
    }
    expect(
      noBlobBytesInModelTurns(
        chain({ model: [turn("turn", giveUp("x".repeat(MAX_MODEL_TURN_CHARS)))] }),
        REPORT,
      ).pass,
    ).toBe(false);
    // The consuming stage's turns count too.
    expect(
      noBlobBytesInModelTurns(
        chain({}, consumer({ model: [turn("turn", giveUp(sentinel))] })),
        REPORT,
      ).pass,
    ).toBe(false);
    expect(
      noBlobBytesInModelTurns(chain({ model: [] }, consumer({ model: [] })), REPORT).pass,
    ).toBe(false);
    // The head of the file is not a sentinel: what a 4,000-character proof read shows is admitted.
    expect(
      noBlobBytesInModelTurns(
        chain({
          model: [
            turn("turn", giveUp(Buffer.from(REPORT.bytes.slice(0, 4_000)).toString("latin1"))),
          ],
        }),
        REPORT,
      ).pass,
    ).toBe(true);
    // The granularity as stated: a whole sentinel within every SENTINEL_GRANULARITY bytes, from any start.
    expect(SENTINEL_GRANULARITY).toBeLessThanOrEqual(16 * 1024);
    for (const start of [
      0,
      1,
      4_000,
      16_129,
      200_000,
      REPORT.bytes.length - SENTINEL_GRANULARITY,
    ]) {
      const window = Buffer.from(REPORT.bytes.slice(start, start + SENTINEL_GRANULARITY)).toString(
        "latin1",
      );
      expect(
        REPORT.sentinels.some((sentinel) => window.includes(sentinel.text)),
        `no whole sentinel in the ${SENTINEL_GRANULARITY} bytes from ${start}`,
      ).toBe(true);
    }
    expect(REPORT.sentinels[0]?.offset).toBeGreaterThanOrEqual(4_000);
  });

  it("ref_travels: green when the answered ref is the handoff and the second input carries it; red for a ref that does not match, no ref, or no handoff", () => {
    expect(refTravels(chain()).pass).toBe(true);
    const use = consumer().use;
    expect(
      refTravels(chain({}, consumer({ use: use ? { ...use, input: { file: OTHER_REF } } : null })))
        .pass,
    ).toBe(false);
    expect(refTravels(chain({ handoff: OTHER_REF })).pass).toBe(false);
    expect(refTravels(chain({ handoff: null }, null)).pass).toBe(false);
    const produced = chain().use;
    expect(
      refTravels(
        chain({
          use: produced
            ? { ...produced, final: { result: { name: "report-2026-q3.pdf" }, blobs: [] } }
            : null,
        }),
      ).pass,
    ).toBe(false);
    expect(refTravels(chain({}, consumer({ use: null }))).pass).toBe(false);
  });

  /** The walk is bounded (the door's `MAX_INPUT_DEPTH`); a result past it is said, never read as no ref (Greptile on #159). */
  it("ref_travels: red with a sentence naming the depth when the answer or the input nests past the walk's bound", () => {
    let deep: Record<string, unknown> = { file: REF };
    for (let i = 0; i < MAX_INPUT_DEPTH + 1; i += 1) deep = { deep };
    const produced = chain().use;
    const answer = refTravels(chain({ use: produced ? { ...produced, final: deep } : null }));
    expect(answer.pass).toBe(false);
    expect(answer.detail).toContain("the producing tool's answer nests past");
    expect(answer.detail).toContain(`${MAX_INPUT_DEPTH} levels`);
    const use = consumer().use;
    const input = refTravels(chain({}, consumer({ use: use ? { ...use, input: deep } : null })));
    expect(input.pass).toBe(false);
    expect(input.detail).toContain("the consuming tool's input nests past");
    // One level inside the bound reads as before.
    let shallow: Record<string, unknown> = { file: REF };
    for (let i = 0; i < MAX_INPUT_DEPTH - 2; i += 1) shallow = { shallow };
    expect(refTravels(chain({ use: produced ? { ...produced, final: shallow } : null })).pass).toBe(
      true,
    );
  });

  it("blob_read_in_dry_run: green for a live or fixture blob and an intercepted write carrying it; red for no blob, an un-intercepted write, a body too small, or a failed dry run", () => {
    const live = blobReadInDryRun(chain());
    expect(live.pass).toBe(true);
    expect(live.detail).toContain(`a live blob of ${REPORT.bytes.length} bytes`);
    const fixture = blobReadInDryRun(
      chain(
        {},
        consumer({
          traces: [trace("publish", 300), fixtureTrace(611), trace("result", 500)],
          events: [intercepted(700)],
        }),
      ),
    );
    expect(fixture.pass).toBe(true);
    expect(fixture.detail).toContain("a fixture blob of 611 bytes");
    expect(
      blobReadInDryRun(
        chain({}, consumer({ traces: [trace("publish", 300), trace("result", 500)] })),
      ).pass,
    ).toBe(false);
    // The write reached the vendor instead of stopping at the proxy.
    const forwarded = blobReadInDryRun(
      chain({}, consumer({ events: [intercepted(REPORT.bytes.length + 512, false)] })),
    );
    expect(forwarded.pass).toBe(false);
    expect(forwarded.detail).toContain("intercepted no write");
    const small = blobReadInDryRun(chain({}, consumer({ events: [intercepted(100)] })));
    expect(small.pass).toBe(false);
    expect(small.detail).toContain("carried 100 byte(s)");
    expect(blobReadInDryRun(chain({}, consumer({ version: version(null) }))).pass).toBe(false);
    expect(blobReadInDryRun(chain({}, null)).pass).toBe(false);
  });

  it("bytes_arrived_intact: green when every upload hashes to the fixture at its size; red for another hash, another size, or no upload", () => {
    expect(bytesArrivedIntact(chain(), REPORT).pass).toBe(true);
    const upload = consumer().uploads[0];
    if (!upload) throw new Error("the fixture consumer has no upload");
    expect(
      bytesArrivedIntact(
        chain({}, consumer({ uploads: [{ ...upload, sha256: "0".repeat(64) }] })),
        REPORT,
      ).pass,
    ).toBe(false);
    expect(
      bytesArrivedIntact(chain({}, consumer({ uploads: [{ ...upload, bytes: 10 }] })), REPORT).pass,
    ).toBe(false);
    expect(bytesArrivedIntact(chain({}, consumer({ uploads: [] })), REPORT).pass).toBe(false);
    expect(bytesArrivedIntact(chain({}, null), REPORT).pass).toBe(false);
  });

  it("modules_use_ctx_blob: green for ctx.blob.write then ctx.blob.read with no banned import; red for fs in either, or a module on neither call", () => {
    expect(modulesUseCtxBlob(chain()).pass).toBe(true);
    const withFs = modulesUseCtxBlob(
      chain({
        attempts: [
          attempt([
            {
              path: "index.ts",
              content: `import { writeFile } from "node:fs/promises";\n${WRITE_MODULE}`,
            },
          ]),
        ],
      }),
    );
    expect(withFs.pass).toBe(false);
    expect(withFs.detail).toContain("imports node:fs/promises");
    expect(
      modulesUseCtxBlob(
        chain(
          {},
          consumer({
            attempts: [
              attempt([{ path: "index.ts", content: `const fs = require("fs");\n${READ_MODULE}` }]),
            ],
          }),
        ),
      ).pass,
    ).toBe(false);
    expect(
      modulesUseCtxBlob(
        chain({ attempts: [attempt([{ path: "index.ts", content: 'ctx.fetch("/files")' }])] }),
      ).pass,
    ).toBe(false);
    expect(
      modulesUseCtxBlob(
        chain(
          {},
          consumer({
            attempts: [attempt([{ path: "index.ts", content: 'ctx.fetch("/uploads")' }])],
          }),
        ),
      ).pass,
    ).toBe(false);
    expect(modulesUseCtxBlob(chain({}, null)).pass).toBe(false);
  });
});
