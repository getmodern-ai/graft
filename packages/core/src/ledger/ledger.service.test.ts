import type { UsageLedgerRow } from "@graft/db/repo/usage";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import type { LedgerDeps } from "./ledger.deps";
import { listVendorUsage, recordUsage } from "./ledger.service";

const NOW = new Date("2026-09-09T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };
const ctx = { db: {} } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<LedgerDeps> = {}): LedgerDeps {
  return {
    insertUsage: vi.fn(async (_db, row) => row as UsageLedgerRow),
    listUsage: vi.fn(async () => []),
    listUsageForVendor: vi.fn(async () => []),
    lastUsedAtByTool: vi.fn(async () => []),
    newId: () => "usage_1",
    now: () => NOW,
    ...overrides,
  };
}

describe("recordUsage", () => {
  it("writes one line per invocation, rounding the latency", async () => {
    const deps = fakeDeps();
    await recordUsage(
      ctx,
      SCOPE,
      {
        toolId: "tool_1",
        versionId: "ver_1",
        toolName: "list-orders",
        outcome: "ok",
        latencyMs: 12.6,
      },
      deps,
    );
    expect(deps.insertUsage).toHaveBeenCalledWith(ctx.db, {
      id: "usage_1",
      agentId: "agent_1",
      toolId: "tool_1",
      versionId: "ver_1",
      toolName: "list-orders",
      outcome: "ok",
      dryRun: false,
      latencyMs: 13,
      createdAt: NOW,
    });
  });

  it("records a meta-tool call with no tool row", async () => {
    const deps = fakeDeps();
    await recordUsage(ctx, SCOPE, { toolName: "acquire", outcome: "ok", latencyMs: 3 }, deps);
    expect(vi.mocked(deps.insertUsage).mock.calls[0]?.[1]).toMatchObject({
      toolId: null,
      versionId: null,
      toolName: "acquire",
    });
  });

  it("refuses a negative latency and an unnamed tool", async () => {
    const deps = fakeDeps();
    await expect(
      recordUsage(ctx, SCOPE, { toolName: "x", outcome: "ok", latencyMs: -1 }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      recordUsage(ctx, SCOPE, { toolName: " ", outcome: "ok", latencyMs: 1 }, deps),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deps.insertUsage).not.toHaveBeenCalled();
  });
});

describe("listVendorUsage", () => {
  it("reads under the person, passing the vendor and the wire names along", async () => {
    const deps = fakeDeps();
    await listVendorUsage(
      ctx,
      { personId: "person_1" },
      { vendor: "demo", toolNames: ["execute__conn_1"], limit: 20 },
      deps,
    );
    expect(deps.listUsageForVendor).toHaveBeenCalledWith(ctx.db, "person_1", {
      vendor: "demo",
      toolNames: ["execute__conn_1"],
      limit: 20,
    });
  });

  it("refuses a limit that is not a positive whole number", async () => {
    const deps = fakeDeps();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        listVendorUsage(ctx, { personId: "person_1" }, { vendor: "demo", limit }, deps),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(deps.listUsageForVendor).not.toHaveBeenCalled();
  });
});
