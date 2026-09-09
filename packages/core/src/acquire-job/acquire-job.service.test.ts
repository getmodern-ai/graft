import type { AcquireAttemptRow, AcquireJobRow } from "@graft/db/repo/acquire-job";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { AcquireJobDeps } from "./acquire-job.deps";
import {
  appendAcquireJobProgress,
  appendAcquireTrace,
  claimRunnableAcquireJobs,
  completeAcquireJob,
  createAcquireJob,
  finishAcquireAttempt,
  recordAcquireJobAttempt,
  recordAcquireJobTokens,
  startAcquireAttempt,
} from "./acquire-job.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };

const job: AcquireJobRow = {
  id: "job_1",
  agentId: "agent_1",
  connectionId: "conn_1",
  goal: "list today's orders",
  hints: null,
  status: "queued",
  progress: [],
  attempts: 0,
  tokenSpend: 0,
  result: null,
  traceRef: null,
  startedAt: null,
  heartbeatAt: null,
  finishedAt: null,
  toolId: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const attempt: AcquireAttemptRow = {
  id: "att_1",
  jobId: "job_1",
  agentId: "agent_1",
  attemptNumber: 1,
  draftPath: ".drafts/job_1/a1",
  files: [],
  checkOutput: null,
  versionId: null,
  diagnosis: null,
  outcome: "running",
  inputTokens: 0,
  outputTokens: 0,
  finishedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const fakeDb = { transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(fakeDb) };
const ctx = { db: fakeDb } as unknown as ServiceContext;

const TOKEN =
  "eyJhbGciOiJFZERTQSIsImtpZCI6ImFiYyJ9.eyJwZXJzb24iOiJwZXJzb25fMSIsImFnZW50IjoiYWdlbnRfYSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";

function fakeDeps(overrides: Partial<AcquireJobDeps> = {}): AcquireJobDeps {
  return {
    insertAcquireJob: vi.fn(async (_db, input) => ({ ...job, ...input }) as AcquireJobRow),
    findAcquireJob: vi.fn(async () => job),
    listAcquireJobs: vi.fn(async () => [job]),
    updateAcquireJob: vi.fn(async (_db, _s, _id, patch) => ({ ...job, ...patch })),
    appendAcquireJobProgress: vi.fn(async (_db, _s, _id, lines) => ({
      ...job,
      progress: [...lines],
    })),
    recordAcquireJobAttempt: vi.fn(async () => ({ ...job, attempts: 1 })),
    addAcquireJobTokenSpend: vi.fn(async (_db, _s, _id, tokens) => ({
      ...job,
      tokenSpend: tokens,
    })),
    heartbeatAcquireJob: vi.fn(async (_db, _s, _id, at) => ({ ...job, heartbeatAt: at })),
    listRunnableAcquireJobs: vi.fn(async () => [{ job, personId: "person_1" }]),
    claimAcquireJob: vi.fn(async (_db, _id, args) => ({
      ...job,
      status: "running" as const,
      startedAt: args.now,
      heartbeatAt: args.now,
    })),
    insertAcquireAttempt: vi.fn(
      async (_db, input) => ({ ...attempt, ...input }) as AcquireAttemptRow,
    ),
    updateAcquireAttempt: vi.fn(async (_db, _s, _id, patch) => ({ ...attempt, ...patch })),
    listAcquireAttempts: vi.fn(async () => [attempt]),
    insertAcquireTrace: vi.fn(async (_db, input) => ({
      ...input,
      sequence: 1,
      attemptNumber: input.attemptNumber ?? null,
      data: input.data ?? null,
      redacted: input.redacted ?? false,
      owner: "person" as const,
      createdAt: NOW,
    })),
    listAcquireTraces: vi.fn(async () => []),
    findConnection: vi.fn(async () => ({ id: "conn_1" }) as never),
    newId: () => "job_new",
    now: () => NOW,
    ...overrides,
  };
}

describe("createAcquireJob", () => {
  it("writes the agent's job against the person's connection, with the first line when given", async () => {
    const deps = fakeDeps();
    await createAcquireJob(
      ctx,
      SCOPE,
      {
        connectionId: "conn_1",
        goal: "  list today's orders ",
        firstProgressLine: "Reading the docs",
      },
      deps,
    );
    expect(deps.findConnection).toHaveBeenCalledWith(ctx.db, "person_1", "conn_1");
    expect(deps.insertAcquireJob).toHaveBeenCalledWith(ctx.db, {
      id: "job_new",
      agentId: "agent_1",
      connectionId: "conn_1",
      goal: "list today's orders",
      hints: null,
      progress: ["Reading the docs"],
    });
  });

  it("keeps the agent's hints, trimmed, and refuses ones past the bound", async () => {
    const deps = fakeDeps();
    await createAcquireJob(
      ctx,
      SCOPE,
      { connectionId: "conn_1", goal: "g", hints: "  GET /orders  " },
      deps,
    );
    expect(vi.mocked(deps.insertAcquireJob).mock.calls[0]?.[1]).toMatchObject({
      hints: "GET /orders",
    });
    await expect(
      createAcquireJob(
        ctx,
        SCOPE,
        { connectionId: "conn_1", goal: "g", hints: "h".repeat(4001) },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an empty goal, and a connection that is not the person's", async () => {
    await expect(
      createAcquireJob(ctx, SCOPE, { connectionId: "conn_1", goal: "  " }, fakeDeps()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createAcquireJob(
        ctx,
        SCOPE,
        { connectionId: "conn_x", goal: "g" },
        fakeDeps({ findConnection: vi.fn(async () => null) }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the loop's writes", () => {
  it("appends lines, and reads the job back rather than writing when there are none", async () => {
    const deps = fakeDeps();
    await appendAcquireJobProgress(ctx, SCOPE, "job_1", ["Checked", "Published"], deps);
    expect(deps.appendAcquireJobProgress).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1", [
      "Checked",
      "Published",
    ]);
    await appendAcquireJobProgress(ctx, SCOPE, "job_1", [], deps);
    expect(deps.appendAcquireJobProgress).toHaveBeenCalledTimes(1);
    expect(deps.findAcquireJob).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1");
  });

  it("counts an attempt with its tokens, refusing a negative or fractional count", async () => {
    const deps = fakeDeps();
    await recordAcquireJobAttempt(ctx, SCOPE, "job_1", 1200, deps);
    expect(deps.recordAcquireJobAttempt).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1", 1200);
    await expect(recordAcquireJobAttempt(ctx, SCOPE, "job_1", -1, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(recordAcquireJobAttempt(ctx, SCOPE, "job_1", 1.5, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("counts a model turn's tokens as one figure, refusing a bad one", async () => {
    const deps = fakeDeps();
    await recordAcquireJobTokens(ctx, SCOPE, "job_1", { inputTokens: 700, outputTokens: 50 }, deps);
    expect(deps.addAcquireJobTokenSpend).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1", 750);
    await expect(
      recordAcquireJobTokens(ctx, SCOPE, "job_1", { inputTokens: -1, outputTokens: 0 }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("completes with the status, the result, the moment, and the tool and trace reference only when given", async () => {
    const deps = fakeDeps();
    await completeAcquireJob(
      ctx,
      SCOPE,
      "job_1",
      { status: "succeeded", result: { tool: "demo__x" }, toolId: "tool_1" },
      deps,
    );
    expect(deps.updateAcquireJob).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1", {
      status: "succeeded",
      result: { tool: "demo__x" },
      finishedAt: NOW,
      toolId: "tool_1",
    });
    await completeAcquireJob(
      ctx,
      SCOPE,
      "job_1",
      { status: "failed", result: { diagnostics: [] }, traceRef: "trace_1" },
      deps,
    );
    expect(vi.mocked(deps.updateAcquireJob).mock.calls[1]?.[3]).toMatchObject({
      traceRef: "trace_1",
    });
    expect(vi.mocked(deps.updateAcquireJob).mock.calls[1]?.[3]).not.toHaveProperty("toolId");
  });
});

describe("attempts", () => {
  it("opens an attempt in one transaction with the job's count, numbering the draft path from it, the files and diagnosis redacted", async () => {
    const deps = fakeDeps({
      recordAcquireJobAttempt: vi.fn(async () => ({ ...job, attempts: 3 })),
    });
    const row = await startAcquireAttempt(
      ctx,
      SCOPE,
      "job_1",
      {
        draftPath: (n) => `.drafts/job_1/a${n}`,
        files: [{ path: "index.ts", content: `// ${TOKEN}\nexport default async () => 1;` }],
        diagnosis: `The proxy refused Bearer ${TOKEN}`,
        redaction: { secretValues: [TOKEN] },
      },
      deps,
    );
    expect(deps.recordAcquireJobAttempt).toHaveBeenCalledWith(fakeDb, SCOPE, "job_1", 0);
    expect(row.attemptNumber).toBe(3);
    expect(row.draftPath).toBe(".drafts/job_1/a3");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row.diagnosis).toBe("The proxy refused Bearer [redacted]");
  });

  it("closes an attempt with its outcome, the check's words, the version and the cost — each only when given", async () => {
    const deps = fakeDeps();
    await finishAcquireAttempt(
      ctx,
      SCOPE,
      "att_1",
      {
        outcome: "dry_run_failed",
        versionId: "ver_1",
        usage: { inputTokens: 10, outputTokens: 2 },
        checkOutput: { refusals: [], note: `saw ${TOKEN}` },
      },
      deps,
    );
    expect(deps.updateAcquireAttempt).toHaveBeenCalledWith(ctx.db, SCOPE, "att_1", {
      outcome: "dry_run_failed",
      finishedAt: NOW,
      versionId: "ver_1",
      inputTokens: 10,
      outputTokens: 2,
      checkOutput: { refusals: [], note: "saw [redacted]" },
    });
    await finishAcquireAttempt(ctx, SCOPE, "att_1", { outcome: "passed" }, deps);
    expect(vi.mocked(deps.updateAcquireAttempt).mock.calls[1]?.[3]).toEqual({
      outcome: "passed",
      finishedAt: NOW,
    });
    await expect(
      finishAcquireAttempt(
        ctx,
        SCOPE,
        "att_1",
        { outcome: "passed", usage: { inputTokens: 1.5, outputTokens: 0 } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("the trace", () => {
  it("writes a line with its text and payload redacted, bounded, and marked when anything changed", async () => {
    const deps = fakeDeps();
    const line = await appendAcquireTrace(
      ctx,
      SCOPE,
      "job_1",
      {
        attemptNumber: 2,
        kind: "vendor_error",
        text: `GET /items 401: {"apiKey":"sk_live_the_real_vendor_key_0123456789"}`,
        data: { status: 401, body: { authorization: `Bearer ${TOKEN}` } },
        redaction: { secretValues: [TOKEN], secretFieldNames: ["x-demo-key"] },
      },
      deps,
    );
    expect(JSON.stringify(line)).not.toContain("sk_live_the_real_vendor_key_0123456789");
    expect(JSON.stringify(line)).not.toContain(TOKEN);
    expect(line).toMatchObject({
      id: "job_new",
      jobId: "job_1",
      agentId: "agent_1",
      attemptNumber: 2,
      kind: "vendor_error",
      text: 'GET /items 401: {"apiKey":"[redacted]"}',
      data: { status: 401, body: { authorization: "Bearer [redacted]" } },
      redacted: true,
    });

    const plain = await appendAcquireTrace(
      ctx,
      SCOPE,
      "job_1",
      { kind: "progress", text: "x".repeat(9_000) },
      deps,
    );
    expect(plain.redacted).toBe(false);
    expect(plain.attemptNumber).toBeNull();
    expect(plain.data).toBeNull();
    expect(plain.text).toHaveLength(8_001);
  });
});

describe("the runner's claim", () => {
  it("lists what is runnable against the stale bound, claims each, and keeps only what the claim answered", async () => {
    const deps = fakeDeps({
      listRunnableAcquireJobs: vi.fn(async () => [
        { job, personId: "person_1" },
        { job: { ...job, id: "job_2" }, personId: "person_2" },
      ]),
      claimAcquireJob: vi.fn(async (_db, id, args) =>
        id === "job_2" ? null : { ...job, status: "running" as const, heartbeatAt: args.now },
      ),
    });
    const claimed = await claimRunnableAcquireJobs(ctx, { staleAfterMs: 120_000, limit: 2 }, deps);
    expect(deps.listRunnableAcquireJobs).toHaveBeenCalledWith(ctx.db, {
      staleBefore: new Date(NOW.getTime() - 120_000),
      limit: 2,
    });
    expect(claimed).toEqual([
      { job: expect.objectContaining({ id: "job_1", status: "running" }), personId: "person_1" },
    ]);
    expect(await claimRunnableAcquireJobs(ctx, { staleAfterMs: 1, limit: 0 }, deps)).toEqual([]);
  });
});
