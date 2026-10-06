import type { AgentScope } from "@graft/core";
import type { BlobRow } from "@graft/db/repo/blob";
import { BLOB_QUOTA_BYTES, BLOB_TTL_MS, type BlobLedgerEntry } from "@graft/runner";
import type { BlobStore } from "@graft/toolbox";
import { describe, expect, it } from "vitest";

import { blobQuotaOvershoot, recordBlobsWithinQuota, withRecordedBlobs } from "./blob-budget";
import type { McpDeps } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";

/**
 * The record is an adoption from the store (GRA-200, after Greptile on #157): the ledger supplies
 * the ids and nothing else; the store's measurement, the sidecar under the sweep's rules and the
 * server's clock supply the row; the quota is judged over what was measured; and a run past it
 * loses its newest blobs until the rest fit. One step per agent.
 */

const MIB = 1024 * 1024;
const SCOPE: AgentScope = { personId: "person_1", agentId: "agent_1" };
const ID = (n: number) => `a0a0a0a0-0000-4000-8000-00000000000${n}`;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const WRITTEN = new Date("2026-09-23T11:00:00.000Z");
const EXPIRES = new Date(WRITTEN.getTime() + BLOB_TTL_MS);
const FAR = new Date("2099-01-01T00:00:00.000Z");

/** A ledger entry as a command might print it: the id is all the record reads off it. */
const entry = (id: string, bytes: number, expiresAt: Date = FAR): BlobLedgerEntry => ({
  ref: `blob://${id}`,
  bytes,
  contentType: "text/x-declared",
  name: "declared.bin",
  expiresAt: expiresAt.toISOString(),
});
const row = (id: string, bytes: number, overrides: Partial<BlobRow> = {}): BlobRow => ({
  id,
  personId: SCOPE.personId,
  agentId: SCOPE.agentId,
  versionId: null,
  bytes,
  contentType: "application/octet-stream",
  name: null,
  expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  removedAt: null,
  owner: "person",
  createdAt: WRITTEN,
  updatedAt: WRITTEN,
  ...overrides,
});

/** What sits in a blob's directory on the store: `data`'s size, the directory's age, the sidecar text. */
type Dir = { bytes: number | null; lastWrittenAt?: Date; meta?: string | null };
const sidecar = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    bytes: MIB,
    contentType: "application/octet-stream",
    name: "one.bin",
    writtenAt: WRITTEN.toISOString(),
    expiresAt: EXPIRES.toISOString(),
    agentId: SCOPE.agentId,
    toolVersion: "ver_sidecar",
    ...over,
  });
const honest = (bytes = MIB): Dir => ({ bytes, meta: sidecar({ bytes }) });

/** A store holding `dirs` for the agent, recording what it is asked to remove. */
function storeWith(dirs: Record<string, Dir>) {
  const removed: string[] = [];
  const store: BlobStore = {
    listAgents: async () => [],
    list: async () => Object.keys(dirs),
    readMeta: async (agentId, blobId) =>
      agentId === SCOPE.agentId ? (dirs[blobId]?.meta ?? null) : null,
    exists: async (agentId, blobId) => agentId === SCOPE.agentId && blobId in dirs,
    stat: async (agentId, blobId) => {
      const dir = agentId === SCOPE.agentId ? dirs[blobId] : undefined;
      return dir ? { lastWrittenAt: dir.lastWrittenAt ?? WRITTEN, bytes: dir.bytes } : null;
    },
    remove: async (_agentId, blobId) => {
      removed.push(blobId);
      delete dirs[blobId];
    },
  };
  return { store, removed };
}

function harness(dirs: Record<string, Dir>, rows: BlobRow[] = [], withStore = true) {
  const fake = createFakeStore();
  fake.now = () => NOW;
  fake.blobs.push(...rows);
  const { store, removed } = storeWith(dirs);
  const registry = createInFlightRegistry();
  const deps = {
    ...createFakeDeps(fake),
    blobStore: withStore ? store : null,
    inFlight: registry,
  } as McpDeps;
  return { fake, deps, removed, registry };
}

describe("recordBlobsWithinQuota adopts this run's blobs from the store", () => {
  it("takes the id alone from the ledger: bytes from the store, media type and name from the sidecar, the expiry from the write and the TTL, the version from the caller", async () => {
    const { fake, deps, removed } = harness({ [ID(1)]: honest(MIB), [ID(2)]: honest(2 * MIB) });
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      "ver_1",
      [entry(ID(1), 0), entry(ID(2), 5)],
      0,
    );
    const adopted = (id: string, bytes: number): BlobLedgerEntry => ({
      ref: `blob://${id}`,
      bytes,
      contentType: "application/octet-stream",
      name: "one.bin",
      expiresAt: EXPIRES.toISOString(),
    });
    expect(record.kept).toEqual([adopted(ID(1), MIB), adopted(ID(2), 2 * MIB)]);
    expect(record.listed).toEqual(record.kept);
    expect(record).toMatchObject({
      removed: [],
      dropped: 0,
      committedBytes: 3 * MIB,
      liveBytes: 0,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(fake.blobs.map((b) => [b.id, b.bytes, b.versionId, b.name, b.expiresAt])).toEqual([
      [ID(1), MIB, "ver_1", "one.bin", EXPIRES],
      [ID(2), 2 * MIB, "ver_1", "one.bin", EXPIRES],
    ]);
    expect(removed).toEqual([]);
    expect(blobQuotaOvershoot(record)).toBeNull();
  });

  it("clamps a sidecar's far-future expiry to the write plus the TTL, and a directory touched into the future to now plus the TTL", async () => {
    const { fake, deps } = harness({
      [ID(1)]: { bytes: MIB, meta: sidecar({ expiresAt: FAR.toISOString() }) },
      [ID(2)]: {
        bytes: MIB,
        lastWrittenAt: FAR,
        meta: sidecar({ writtenAt: FAR.toISOString(), expiresAt: FAR.toISOString() }),
      },
    });
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(1), MIB), entry(ID(2), MIB)],
      0,
    );
    expect(record.kept.map((b) => b.expiresAt)).toEqual([
      EXPIRES.toISOString(),
      new Date(NOW.getTime() + BLOB_TTL_MS).toISOString(),
    ]);
    expect(fake.blobs.map((b) => b.expiresAt.getTime())).toEqual([
      EXPIRES.getTime(),
      NOW.getTime() + BLOB_TTL_MS,
    ]);
  });

  it("drops what cannot be adopted: no directory, no data yet, no sidecar, a sidecar that is not JSON, a bad name, a bad media type, another agent's sidecar, no id, a repeat", async () => {
    const { fake, deps, removed } = harness({
      [ID(1)]: honest(),
      [ID(2)]: { bytes: null, meta: sidecar() },
      [ID(3)]: { bytes: MIB, meta: null },
      [ID(4)]: { bytes: MIB, meta: "not json" },
      [ID(5)]: { bytes: MIB, meta: sidecar({ name: "../../etc/passwd" }) },
      [ID(6)]: { bytes: MIB, meta: sidecar({ contentType: "not a media type" }) },
      [ID(7)]: { bytes: MIB, meta: sidecar({ agentId: "agent_2" }) },
    });
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [
        entry(ID(1), MIB),
        entry(ID(2), MIB),
        entry(ID(3), MIB),
        entry(ID(4), MIB),
        entry(ID(5), MIB),
        entry(ID(6), MIB),
        entry(ID(7), MIB),
        entry(ID(8), MIB),
        { ...entry(ID(1), MIB), ref: "blob://not-an-id" },
        entry(ID(1), MIB),
      ],
      1,
    );
    expect(record.kept.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    expect(record.listed).toEqual(record.kept);
    // The reader's one refused line, plus the nine entries this record could not adopt.
    expect(record.dropped).toBe(10);
    expect(removed).toEqual([]);
    expect(fake.blobs.map((b) => b.id)).toEqual([ID(1)]);
  });
});

describe("recordBlobsWithinQuota and a blob that has a row already", () => {
  it("lists a live known blob from its row, never records or removes it, whatever the entry declares", async () => {
    const existing = row(ID(9), 4096, { name: "theirs.bin" });
    const { fake, deps, removed } = harness({ [ID(1)]: honest(), [ID(9)]: honest(4096) }, [
      existing,
    ]);
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(9), 900 * MIB), entry(ID(1), MIB)],
      0,
    );
    expect(record.kept.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    expect(record.listed[0]).toEqual({
      ref: `blob://${ID(9)}`,
      bytes: 4096,
      contentType: "application/octet-stream",
      name: "theirs.bin",
      expiresAt: existing.expiresAt.toISOString(),
    });
    expect(record.listed).toHaveLength(2);
    expect(record.dropped).toBe(0);
    expect(record.committedBytes).toBe(MIB);
    expect(removed).toEqual([]);
    expect(fake.blobs[0]).toBe(existing);
    expect(fake.blobs).toHaveLength(2);
  });

  it("drops a known blob that is removed, expired, or whose directory is gone, so a dead ref is never advertised", async () => {
    const removedRow = row(ID(7), MIB, { removedAt: NOW });
    const expiredRow = row(ID(8), MIB, { expiresAt: new Date(NOW.getTime() - 1) });
    const goneRow = row(ID(9), MIB);
    const { fake, deps, removed } = harness({ [ID(7)]: honest(), [ID(8)]: honest() }, [
      removedRow,
      expiredRow,
      goneRow,
    ]);
    const record = await recordBlobsWithinQuota(
      deps,
      SCOPE,
      null,
      [entry(ID(7), MIB), entry(ID(8), MIB), entry(ID(9), MIB)],
      0,
    );
    expect(record.kept).toEqual([]);
    expect(record.listed).toEqual([]);
    expect(record.dropped).toBe(3);
    expect(removed).toEqual([]);
    expect(fake.blobs).toEqual([removedRow, expiredRow, goneRow]);
  });

  it("past the quota, a known blob is never in the removal set however large the entry declares it", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES - 0.5 * MIB);
    const { fake, deps, removed } = harness({ [ID(1)]: honest(), [ID(8)]: honest(filler.bytes) }, [
      filler,
    ]);
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
});

describe("recordBlobsWithinQuota and the quota", () => {
  it("past the quota, removes this run's newest blobs through the store until the rest fit, and words the overshoot", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES - 1.5 * MIB);
    const { fake, deps, removed } = harness(
      { [ID(1)]: honest(), [ID(2)]: honest(), [ID(3)]: honest(), [ID(8)]: honest(filler.bytes) },
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
    const { fake, deps, removed } = harness({ [ID(1)]: honest(), [ID(2)]: honest() }, [filler]);
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

  /**
   * Two runs of one agent finishing together (Greptile on #157, the third review): each would read
   * the same live total and each find room. The record is one step per agent, so the second reads
   * the first's row and removes its own.
   */
  it("records two runs finishing together one after the other, so exactly one keeps its blob when there is room for one", async () => {
    const filler = row(ID(8), BLOB_QUOTA_BYTES - MIB);
    const { fake, deps, removed } = harness(
      { [ID(1)]: honest(), [ID(2)]: honest(), [ID(8)]: honest(filler.bytes) },
      [filler],
    );
    const [first, second] = await Promise.all([
      recordBlobsWithinQuota(deps, SCOPE, null, [entry(ID(1), MIB)], 0),
      recordBlobsWithinQuota(deps, SCOPE, null, [entry(ID(2), MIB)], 0),
    ]);
    expect(first.kept.map((b) => b.ref)).toEqual([`blob://${ID(1)}`]);
    expect(second.kept).toEqual([]);
    expect(second.removed.map((b) => b.ref)).toEqual([`blob://${ID(2)}`]);
    expect(second.liveBytes).toBe(filler.bytes + MIB);
    expect(removed).toEqual([ID(2)]);
    expect(fake.blobs.map((b) => b.id)).toEqual([ID(8), ID(1)]);
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
  const record = (over: Partial<Parameters<typeof withRecordedBlobs>[1]>) => ({
    kept: [],
    removed: [],
    listed: [],
    dropped: 0,
    committedBytes: 0,
    liveBytes: 0,
    quota: BLOB_QUOTA_BYTES,
    ...over,
  });

  it("replaces what the process declared with what the record listed, and drops the blob keys for nothing", () => {
    const declared = { ...base, blobs: [entry(ID(9), 900 * MIB)], blobsDropped: 1 };
    const kept = entry(ID(1), MIB, EXPIRES);
    expect(
      withRecordedBlobs(declared, record({ kept: [kept], listed: [kept], dropped: 2 })),
    ).toEqual({ ...base, blobs: [kept], blobsDropped: 2 });
    expect(withRecordedBlobs(declared, record({}))).toEqual(base);
  });

  it("puts the overshoot's failure fields on top when the record removed something", () => {
    const answer = withRecordedBlobs(
      base,
      record({ removed: [entry(ID(2), MIB)], committedBytes: MIB, liveBytes: BLOB_QUOTA_BYTES }),
    );
    expect(answer).toMatchObject({ ...base, blobsRemoved: 1, removedBytes: MIB });
    expect(String(answer.error)).toMatch(/^blob_quota: this run committed 1 MiB of blobs/);
    expect(answer.blobs).toBeUndefined();
  });
});
