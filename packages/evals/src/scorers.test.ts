import type { AcquireAttemptRow, AcquireTraceRow } from "@graft/db/repo/acquire-job";
import type { PendingActionRow } from "@graft/db/repo/pending-action";
import type { ToolVersionRow } from "@graft/db/repo/tool";
import type { ProxyEvent } from "@graft/proxy";
import { describe, expect, it } from "vitest";

import { listItems } from "./scenarios";
import {
  dryRunBeforeAnyAsk,
  firstWriteThroughPublishedTool,
  noVendorHostInCode,
  publishBeforeFirstWrite,
  readsBeforePublish,
  type ScenarioRun,
  sdkBoundToProxy,
} from "./scorers";
import type { TimedRequest } from "./world";

/**
 * The scorers' directions on synthetic runs: each must go red on the failure it exists to catch and
 * green on the run that avoided it. The harness test covers the green path over a real run; these
 * cover the red paths a scripted model cannot be made to produce.
 */

const T0 = 1_000_000;
const at = (ms: number) => new Date(T0 + ms);

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

const ask = (ms: number, answeredMs: number | null): PendingActionRow =>
  ({
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
  }) as PendingActionRow;

function run(overrides: Partial<ScenarioRun>): ScenarioRun {
  return {
    scenario: listItems,
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
});

describe("dry_run_before_any_ask", () => {
  it("is red when the version has no dry run, or an ask came before it or inside the job", () => {
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(900, 950)] })).pass).toBe(true);
    expect(dryRunBeforeAnyAsk(run({ version: version(null) })).pass).toBe(false);
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(350, 360)] })).pass).toBe(false);
    expect(dryRunBeforeAnyAsk(run({ asks: [ask(450, 460)] })).pass).toBe(false);
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
        ask: ask(900, 950),
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
