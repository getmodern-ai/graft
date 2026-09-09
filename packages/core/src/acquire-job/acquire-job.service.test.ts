import type { AcquireJobRow } from "@graft/db/repo/acquire-job";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { AcquireJobDeps } from "./acquire-job.deps";
import {
  appendAcquireJobProgress,
  completeAcquireJob,
  createAcquireJob,
  recordAcquireJobAttempt,
} from "./acquire-job.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };

const job: AcquireJobRow = {
  id: "job_1",
  agentId: "agent_1",
  connectionId: "conn_1",
  goal: "list today's orders",
  status: "queued",
  progress: [],
  attempts: 0,
  tokenSpend: 0,
  result: null,
  traceRef: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
};

const ctx = { db: {} } as unknown as ServiceContext;

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
      progress: ["Reading the docs"],
    });
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

  it("completes with the status, the result and the trace reference only when given", async () => {
    const deps = fakeDeps();
    await completeAcquireJob(
      ctx,
      SCOPE,
      "job_1",
      { status: "succeeded", result: { toolId: "tool_1" } },
      deps,
    );
    expect(deps.updateAcquireJob).toHaveBeenCalledWith(ctx.db, SCOPE, "job_1", {
      status: "succeeded",
      result: { toolId: "tool_1" },
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
  });
});
