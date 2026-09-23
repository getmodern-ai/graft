import type { AgentScope } from "@graft/core";
import type { BlobLedgerEntry } from "@graft/runner";
import type { BlobStore } from "@graft/toolbox";
import { describe, expect, it } from "vitest";

import { blobBudgetOvershoot, recordBlobsWithinBudget } from "./blob-budget";
import type { McpDeps } from "./deps";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";

/**
 * The record is the rule (GRA-200, after Greptile on #157): a ledger past the budget the door
 * admitted loses its newest blobs, through the store and from the rows, until the rest fit; one
 * within it, or one with no budget to check against, is recorded whole.
 */

const MIB = 1024 * 1024;
const SCOPE: AgentScope = { personId: "person_1", agentId: "agent_1" };

const entry = (id: string, bytes: number): BlobLedgerEntry => ({
  ref: `blob://${id}`,
  bytes,
  contentType: "application/octet-stream",
  name: `${id.slice(-1)}.bin`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const ONE = entry("a0a0a0a0-0000-4000-8000-000000000001", MIB);
const TWO = entry("a0a0a0a0-0000-4000-8000-000000000002", MIB);
const THREE = entry("a0a0a0a0-0000-4000-8000-000000000003", MIB);

/** A store that records what it is asked to remove and nothing else. */
function recordingStore() {
  const removed: string[] = [];
  const store: BlobStore = {
    listAgents: async () => [],
    list: async () => [],
    readMeta: async () => null,
    exists: async () => true,
    stat: async () => null,
    remove: async (_agentId, blobId) => {
      removed.push(blobId);
    },
  };
  return { store, removed };
}

function harness(withStore = true) {
  const fake = createFakeStore();
  const { store, removed } = recordingStore();
  const deps = { ...createFakeDeps(fake), blobStore: withStore ? store : null } as McpDeps;
  return { fake, deps, removed };
}

describe("recordBlobsWithinBudget", () => {
  it("records a ledger within the budget whole and removes nothing", async () => {
    const { fake, deps, removed } = harness();
    const record = await recordBlobsWithinBudget(deps, SCOPE, "ver_1", [ONE, TWO], 0, 2 * MIB);
    expect(record).toEqual({
      kept: [ONE, TWO],
      removed: [],
      committedBytes: 2 * MIB,
      budgetBytes: 2 * MIB,
    });
    expect(fake.blobs.map((row) => row.id)).toEqual([
      "a0a0a0a0-0000-4000-8000-000000000001",
      "a0a0a0a0-0000-4000-8000-000000000002",
    ]);
    expect(removed).toEqual([]);
    expect(blobBudgetOvershoot(record)).toBeNull();
  });

  it("removes the newest blobs until the rest fit, through the store, and writes rows for the rest alone", async () => {
    const { fake, deps, removed } = harness();
    const record = await recordBlobsWithinBudget(
      deps,
      SCOPE,
      null,
      [ONE, TWO, THREE],
      0,
      1.5 * MIB,
    );
    expect(record.kept).toEqual([ONE]);
    expect(record.removed).toEqual([THREE, TWO]);
    expect(record.committedBytes).toBe(3 * MIB);
    expect(removed).toEqual([
      "a0a0a0a0-0000-4000-8000-000000000003",
      "a0a0a0a0-0000-4000-8000-000000000002",
    ]);
    expect(fake.blobs.map((row) => row.id)).toEqual(["a0a0a0a0-0000-4000-8000-000000000001"]);
    expect(fake.blobs[0]?.versionId).toBeNull();

    const overshoot = blobBudgetOvershoot(record);
    expect(overshoot).toEqual({
      error:
        "blob_quota: the run committed 3 MiB of blobs against the 1.5 MiB its budget allowed, 1.5 MiB past it. The newest 2 (2 MiB) were removed and have no ref; the 1 before them stand. The budget is what the agent's quota leaves, and a blob stops counting 24 hours after its write.",
      blobsRemoved: 2,
      removedBytes: 2 * MIB,
      budgetBytes: 1.5 * MIB,
    });
  });

  it("removes every blob when the budget was nothing, and says so", async () => {
    const { fake, deps, removed } = harness();
    const record = await recordBlobsWithinBudget(deps, SCOPE, null, [ONE, TWO], 0, 0);
    expect(record.kept).toEqual([]);
    expect(removed).toHaveLength(2);
    expect(fake.blobs).toEqual([]);
    expect(blobBudgetOvershoot(record)?.error).toContain("the 0 before them stand");
  });

  it("records the ledger whole with no budget to check against, and with no store to remove through", async () => {
    const unknown = harness();
    const first = await recordBlobsWithinBudget(
      unknown.deps,
      SCOPE,
      null,
      [ONE, TWO],
      0,
      undefined,
    );
    expect(first.removed).toEqual([]);
    expect(unknown.fake.blobs).toHaveLength(2);
    expect(unknown.removed).toEqual([]);
    expect(blobBudgetOvershoot(first)).toBeNull();

    const storeless = harness(false);
    const second = await recordBlobsWithinBudget(storeless.deps, SCOPE, null, [ONE, TWO], 0, 0);
    expect(second.removed).toEqual([]);
    expect(storeless.fake.blobs).toHaveLength(2);
    expect(blobBudgetOvershoot(second)).toBeNull();
  });
});
