import type { AgentScope } from "@graft/core";
import type { BlobRow } from "@graft/db/repo/blob";
import { BLOB_QUOTA_BYTES, type BlobLedgerEntry } from "@graft/runner";
import type { BlobStore } from "@graft/toolbox";
import { describe, expect, it } from "vitest";

import { blobQuotaOvershoot, recordBlobsWithinQuota, withRecordedBlobs } from "./blob-budget";
import type { McpDeps } from "./deps";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";

/**
 * The record is the rule and the envelope is a claim (GRA-200, after Greptile on #157): a ledger's
 * ids are measured against the store and the rows, the quota is judged over what was measured, and
 * a run past it loses its newest blobs until the rest fit. Nothing declared is used but the id.
 */

const MIB = 1024 * 1024;
const SCOPE: AgentScope = { personId: "person_1", agentId: "agent_1" };
const ID = (n: number) => `a0a0a0a0-0000-4000-8000-00000000000${n}`;

const entry = (id: string, bytes: number): BlobLedgerEntry => ({
  ref: `blob://${id}`,
  bytes,
  contentType: "application/octet-stream",
  name: `${id.slice(-1)}.bin`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const row = (id: string, bytes: number): BlobRow => ({
  id,
  personId: SCOPE.personId,
  agentId: SCOPE.agentId,
  versionId: null,
  bytes,
  contentType: "application/octet-stream",
  name: null,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  removedAt: null,
  owner: "person",
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** A store holding the directories `sizes` names for the agent, recording what it is asked to remove. */
function storeWith(sizes: Record<string, number>) {
  const removed: string[] = [];
  const store: BlobStore = {
    listAgents: async () => [],
    list: async () => Object.keys(sizes),
    readMeta: async () => null,
    exists: async (_agentId, blobId) => blobId in sizes,
    stat: async (agentId, blobId) =>
      agentId === SCOPE.agentId && blobId in sizes
        ? { lastWrittenAt: new Date(), bytes: sizes[blobId] ?? null }
        : null,
    remove: async (_agentId, blobId) => {
      removed.push(blobId);
    },
  };
  return { store, removed };
}

function harness(sizes: Record<string, number>, rows: BlobRow[] = [], withStore = true) {
  const fake = createFakeStore();
  fake.blobs.push(...rows);
  const { store, removed } = storeWith(sizes);
  const deps = { ...createFakeDeps(fake), blobStore: withStore ? store : null } as McpDeps;
  return { fake, deps, removed };
}

describe("recordBlobsWithinQuota", () => {
  it("records this run's blobs at the bytes the store measured, never the bytes declared", async () => {
    const { fake, deps, removed } = harness({ [ID(1)]: MIB, [ID(2)]: 2 * MIB });
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      "ver_1",
      [entry(ID(1), 0), entry(ID(2), 5)],
      0,
    );
    expect(record.kept.map((b) => b.bytes)).toEqual([MIB, 2 * MIB]);
    expect(record.listed).toEqual(record.kept);
    expect(record).toMatchObject({
      removed: [],
      dropped: 0,
      committedBytes: 3 * MIB,
      liveBytes: 0,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(fake.blobs.map((b) => [b.id, b.bytes, b.versionId])).toEqual([
      [ID(1), MIB, "ver_1"],
      [ID(2), 2 * MIB, "ver_1"],
    ]);
    expect(removed).toEqual([]);
    expect(blobQuotaOvershoot(record)).toBeNull();
  });

  it("lists a blob with a row already from its row and never records or removes it, and drops one the store cannot find, one without an id and a repeat", async () => {
    const existing = row(ID(9), 4096);
    const { fake, deps, removed } = harness({ [ID(1)]: MIB, [ID(9)]: 4096 }, [existing]);
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [
        entry(ID(9), 900 * MIB),
        entry(ID(5), MIB),
        { ...entry(ID(1), MIB), ref: "blob://not-an-id" },
        entry(ID(1), 0),
        entry(ID(1), MIB),
      ],
      1,
    );
    expect(record.kept.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    // The known blob first, at the row's 4096 and not the declared 900 MiB, then this run's.
    expect(record.listed).toEqual([
      {
        ref: `blob://${ID(9)}`,
        bytes: 4096,
        contentType: "application/octet-stream",
        expiresAt: existing.expiresAt.toISOString(),
      },
      { ...entry(ID(1), MIB) },
    ]);
    // The reader's one refused line, plus the three entries that named nothing anyone wrote.
    expect(record.dropped).toBe(4);
    expect(record.committedBytes).toBe(MIB);
    expect(removed).toEqual([]);
    expect(fake.blobs.map((b) => b.id)).toEqual([ID(9), ID(1)]);
    expect(fake.blobs[0]).toBe(existing);
  });

  it("past the quota, a known blob is never in the removal set however large the entry declares it", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES - 0.5 * MIB);
    const { fake, deps, removed } = harness({ [ID(1)]: MIB, [ID(8)]: filler.bytes }, [filler]);
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(8), 900 * MIB), entry(ID(1), MIB)],
      0,
    );
    expect(record.kept).toEqual([]);
    expect(record.removed.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    expect(record.listed.map((b) => b.ref)).toEqual([`blob://${ID(8)}`]);
    expect(removed).toEqual([ID(1)]);
    expect(fake.blobs).toEqual([filler]);
  });

  it("past the quota, removes this run's newest blobs through the store until the rest fit, and words the overshoot", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES - 1.5 * MIB);
    const { fake, deps, removed } = harness(
      { [ID(1)]: MIB, [ID(2)]: MIB, [ID(3)]: MIB, [ID(8)]: filler.bytes },
      [filler],
    );
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(1), MIB), entry(ID(2), MIB), entry(ID(3), MIB)],
      0,
    );
    expect(record.kept.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    expect(record.removed.map((b) => b.ref)).toEqual([`blob://${ID(3)}`, `blob://${ID(2)}`]);
    expect(record.listed).toEqual(record.kept);
    expect(record.liveBytes).toBe(filler.bytes);
    expect(removed).toEqual([ID(3), ID(2)]);
    expect(fake.blobs.map((b) => b.id)).toEqual([ID(8), ID(1)]);

    expect(blobQuotaOvershoot(record)).toEqual({
      error:
        "blob_quota: this run committed 3 MiB of blobs, and with the agent's 1022.5 MiB live before it that comes to 1025.5 MiB, 1.5 MiB past the 1024 MiB quota. The newest 2 (2 MiB) were removed and have no ref; the 1 before them stand. A blob stops counting 24 hours after its write.",
      blobsRemoved: 2,
      removedBytes: 2 * MIB,
      quota: BLOB_QUOTA_BYTES,
    });
  });

  it("removes every blob of a run when the agent was already at the quota", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES);
    const { fake, deps, removed } = harness({ [ID(1)]: MIB, [ID(2)]: MIB }, [filler]);
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(1), MIB), entry(ID(2), MIB)],
      0,
    );
    expect(record.kept).toEqual([]);
    expect(removed).toEqual([ID(2), ID(1)]);
    expect(fake.blobs).toEqual([filler]);
    expect(blobQuotaOvershoot(record)?.error).toContain("the 0 before them stand");
  });

  it("with no store bound records the ledger as declared, as before", async () => {
    const { fake, deps } = harness({}, [], false);
    const record = await recordBlobsWithinQuota(deps, SCOPE, null, [entry(ID(1), 7)], 2);
    expect(record.kept).toEqual([entry(ID(1), 7)]);
    expect(record.dropped).toBe(2);
    expect(fake.blobs.map((b) => b.bytes)).toEqual([7]);
    expect(blobQuotaOvershoot(record)).toBeNull();
  });
});

describe("withRecordedBlobs", () => {
  const base = { exitCode: 0, output: "…" };
  it("replaces what the process declared with what the record kept, and drops the blob keys for nothing", () => {
    const declared = { ...base, blobs: [entry(ID(9), 900 * MIB)], blobsDropped: 1 };
    const kept = entry(ID(1), MIB);
    const within = withRecordedBlobs(declared, {
      kept: [kept],
      removed: [],
      listed: [kept],
      dropped: 2,
      committedBytes: MIB,
      liveBytes: 0,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(within).toEqual({ ...base, blobs: [kept], blobsDropped: 2 });
    const nothing = withRecordedBlobs(declared, {
      kept: [],
      removed: [],
      listed: [],
      dropped: 0,
      committedBytes: 0,
      liveBytes: 0,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(nothing).toEqual(base);
  });

  it("puts the overshoot's failure fields on top when the record removed something", () => {
    const removed = entry(ID(2), MIB);
    const answer = withRecordedBlobs(base, {
      kept: [],
      removed: [removed],
      listed: [],
      dropped: 0,
      committedBytes: MIB,
      liveBytes: BLOB_QUOTA_BYTES,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(answer).toMatchObject({ ...base, blobsRemoved: 1, removedBytes: MIB });
    expect(String(answer.error)).toMatch(/^blob_quota: this run committed 1 MiB of blobs/);
    expect(answer.blobs).toBeUndefined();
  });
});
