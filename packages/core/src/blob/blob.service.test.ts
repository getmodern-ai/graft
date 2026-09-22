import type { NewBlobRow } from "@graft/db/schema/blob";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { BlobDeps } from "./blob.deps";
import { getBlob, getBlobs, liveBlobBytes, recordBlobsWritten } from "./blob.service";

/** The blob service over fakes: what one run's ledger becomes as rows, and what is refused first. */

const NOW = new Date("2026-09-22T10:00:00Z");
const EXPIRES = new Date("2026-09-23T10:00:00Z");
const SCOPE = { personId: "person_1", agentId: "agent_1" };
const ctx = { db: {} } as unknown as ServiceContext;

function fakeDeps(overrides: Partial<BlobDeps> = {}): BlobDeps {
  return {
    insertBlobs: vi.fn(async (_db: unknown, rows: readonly NewBlobRow[]) =>
      rows.map((row) => ({
        ...row,
        versionId: row.versionId ?? null,
        name: row.name ?? null,
        removedAt: null,
        owner: "person" as const,
        createdAt: row.createdAt ?? NOW,
        updatedAt: NOW,
      })),
    ),
    findBlob: vi.fn(async () => null),
    findBlobs: vi.fn(async () => []),
    listBlobs: vi.fn(async () => []),
    sumLiveBlobBytes: vi.fn(async () => 0),
    now: () => NOW,
    ...overrides,
  };
}

describe("recordBlobsWritten", () => {
  it("writes one row per ledger line, the scope's pair and the version on each, in one call", async () => {
    const deps = fakeDeps();
    const rows = await recordBlobsWritten(
      ctx,
      SCOPE,
      {
        versionId: "ver_1",
        blobs: [
          { id: "b1", bytes: 11, contentType: "text/plain", name: "a.txt", expiresAt: EXPIRES },
          { id: "b2", bytes: 0, contentType: "application/pdf", expiresAt: EXPIRES },
        ],
      },
      deps,
    );
    expect(deps.insertBlobs).toHaveBeenCalledTimes(1);
    expect(deps.insertBlobs).toHaveBeenCalledWith(ctx.db, [
      {
        id: "b1",
        personId: "person_1",
        agentId: "agent_1",
        versionId: "ver_1",
        bytes: 11,
        contentType: "text/plain",
        name: "a.txt",
        expiresAt: EXPIRES,
        createdAt: NOW,
      },
      {
        id: "b2",
        personId: "person_1",
        agentId: "agent_1",
        versionId: "ver_1",
        bytes: 0,
        contentType: "application/pdf",
        name: null,
        expiresAt: EXPIRES,
        createdAt: NOW,
      },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["b1", "b2"]);
  });

  it("writes nothing for an empty ledger", async () => {
    const deps = fakeDeps();
    expect(await recordBlobsWritten(ctx, SCOPE, { versionId: null, blobs: [] }, deps)).toEqual([]);
    expect(deps.insertBlobs).not.toHaveBeenCalled();
  });

  it("refuses a line the runner could not have written, before any row", async () => {
    const deps = fakeDeps();
    const line = { id: "b1", bytes: 1, contentType: "text/plain", expiresAt: EXPIRES };
    for (const bad of [
      { ...line, bytes: 1.5 },
      { ...line, bytes: -1 },
      { ...line, contentType: " " },
      { ...line, id: "" },
      { ...line, expiresAt: new Date("nonsense") },
    ]) {
      await expect(
        recordBlobsWritten(ctx, SCOPE, { versionId: null, blobs: [line, bad] }, deps),
      ).rejects.toBeInstanceOf(ServiceError);
    }
    expect(deps.insertBlobs).not.toHaveBeenCalled();
  });
});

describe("getBlob", () => {
  it("reads under the scope and answers the repo's null as null", async () => {
    const deps = fakeDeps();
    expect(await getBlob(ctx, SCOPE, "b1", deps)).toBeNull();
    expect(deps.findBlob).toHaveBeenCalledWith(ctx.db, SCOPE, "b1");
  });
});

/** The door's two reads (GRA-187): the ids an input names under the scope, and the live bytes at the seam's clock. */
describe("getBlobs and liveBlobBytes", () => {
  it("hand the repo the scope and the ids in one call", async () => {
    const deps = fakeDeps();
    expect(await getBlobs(ctx, SCOPE, ["b1", "b2"], deps)).toEqual([]);
    expect(deps.findBlobs).toHaveBeenCalledTimes(1);
    expect(deps.findBlobs).toHaveBeenCalledWith(ctx.db, SCOPE, ["b1", "b2"]);
  });

  it("sum the live bytes at the seam's now", async () => {
    const deps = fakeDeps({ sumLiveBlobBytes: vi.fn(async () => 4096) });
    expect(await liveBlobBytes(ctx, SCOPE, deps)).toBe(4096);
    expect(deps.sumLiveBlobBytes).toHaveBeenCalledWith(ctx.db, SCOPE, NOW);
  });
});
