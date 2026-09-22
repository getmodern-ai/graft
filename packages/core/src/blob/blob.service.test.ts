import type { NewBlobRow } from "@graft/db/schema/blob";
import { describe, expect, it, vi } from "vitest";

import type { ServiceContext } from "../context";
import { ServiceError } from "../errors";
import type { BlobDeps } from "./blob.deps";
import {
  adoptBlob,
  getBlob,
  getBlobs,
  liveBlobBytes,
  markBlobRemoved,
  recordBlobsWritten,
} from "./blob.service";

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
    listUnremovedBlobs: vi.fn(async () => []),
    markBlobRemoved: vi.fn(async () => true),
    insertAdoptedBlob: vi.fn(async (_db: unknown, row: NewBlobRow) => ({
      ...row,
      versionId: row.versionId ?? null,
      name: row.name ?? null,
      removedAt: null,
      owner: "person" as const,
      createdAt: row.createdAt ?? NOW,
      updatedAt: NOW,
    })),
    now: () => NOW,
    ...overrides,
  };
}

describe("the sweep's writes", () => {
  it("marks a removal at the service's clock, under the scope", async () => {
    const deps = fakeDeps();
    expect(await markBlobRemoved(ctx, SCOPE, "b1", deps)).toBe(true);
    expect(deps.markBlobRemoved).toHaveBeenCalledWith(ctx.db, SCOPE, "b1", NOW);
  });

  it("adopts an orphan as the decision built it: the scope's pair, the version, size, type, name and times", async () => {
    const deps = fakeDeps();
    const writtenAt = new Date("2026-09-22T08:00:00Z");
    const row = await adoptBlob(
      ctx,
      SCOPE,
      "b9",
      {
        bytes: 7,
        contentType: "text/csv",
        name: "rows.csv",
        writtenAt,
        expiresAt: EXPIRES,
        toolVersion: "ver_2",
      },
      deps,
    );
    expect(deps.insertAdoptedBlob).toHaveBeenCalledWith(ctx.db, {
      id: "b9",
      personId: "person_1",
      agentId: "agent_1",
      versionId: "ver_2",
      bytes: 7,
      contentType: "text/csv",
      name: "rows.csv",
      expiresAt: EXPIRES,
      createdAt: writtenAt,
    });
    expect(row?.id).toBe("b9");
  });

  it("answers the repo's null when the row already exists, and refuses an empty id first", async () => {
    const deps = fakeDeps({ insertAdoptedBlob: vi.fn(async () => null) });
    const sidecar = {
      bytes: 1,
      contentType: "text/plain",
      name: null,
      writtenAt: NOW,
      expiresAt: EXPIRES,
      toolVersion: null,
    };
    expect(await adoptBlob(ctx, SCOPE, "b1", sidecar, deps)).toBeNull();
    await expect(adoptBlob(ctx, SCOPE, " ", sidecar, deps)).rejects.toBeInstanceOf(ServiceError);
    expect(deps.insertAdoptedBlob).toHaveBeenCalledTimes(1);
  });
});

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
