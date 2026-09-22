import type { BlobRow } from "@graft/db/repo/blob";
import { BLOB_QUOTA_BYTES, BLOB_TTL_MS } from "@graft/runner";
import { describe, expect, it } from "vitest";

import { blobRefsIn, judgeBlobQuota, judgeBlobRefs } from "./blob-door";

/**
 * The door's pure parts (GRA-187): which strings of an input are refs, where the quota bites, and
 * which refusal a set of rows earns in which order. The door over the store, and before a sandbox,
 * is `server.test.ts`.
 */

const NOW = new Date("2026-09-22T10:00:00Z");
const LIVE = "blob://0f6b6c4e-6d4b-4a8b-9e6e-7c9d5b5f3a21";
const OLD = "blob://1a1a1a1a-6d4b-4a8b-9e6e-7c9d5b5f3a21";
const GONE = "blob://2b2b2b2b-6d4b-4a8b-9e6e-7c9d5b5f3a21";
const NOBODYS = "blob://3c3c3c3c-6d4b-4a8b-9e6e-7c9d5b5f3a21";

const row = (ref: string, overrides: Partial<BlobRow> = {}): BlobRow => ({
  id: ref.slice("blob://".length),
  personId: "person_1",
  agentId: "agent_1",
  versionId: null,
  bytes: 10,
  contentType: "text/plain",
  name: null,
  expiresAt: new Date(NOW.getTime() + BLOB_TTL_MS),
  removedAt: null,
  owner: "person",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("blobRefsIn", () => {
  it("collects every blob:// string leaf, nested in arrays and objects, once each and in walk order", () => {
    expect(
      blobRefsIn({
        file: LIVE,
        note: "see blob://not-a-leaf inside a sentence",
        count: 3,
        attachments: [OLD, LIVE, { deeper: [GONE] }],
        meta: { previous: NOBODYS, flag: true, nothing: null },
      }),
    ).toEqual([LIVE, OLD, GONE, NOBODYS]);
  });

  it("finds nothing in a value with no such leaf, a bare string included", () => {
    expect(blobRefsIn({ limit: 1, tags: ["a", "b"] })).toEqual([]);
    expect(blobRefsIn("blob://alone")).toEqual(["blob://alone"]);
    expect(blobRefsIn(null)).toEqual([]);
    expect(blobRefsIn(undefined)).toEqual([]);
  });
});

describe("judgeBlobQuota", () => {
  it("lets an agent under the quota through and refuses at and over it, naming the MiB and carrying the numbers", () => {
    expect(judgeBlobQuota(0)).toBeNull();
    expect(judgeBlobQuota(BLOB_QUOTA_BYTES - 1)).toBeNull();
    const at = judgeBlobQuota(BLOB_QUOTA_BYTES);
    expect(at).toMatchObject({
      error: "refused",
      reason: "blob_quota",
      bytes: BLOB_QUOTA_BYTES,
      quota: BLOB_QUOTA_BYTES,
    });
    expect(at?.message).toMatch(
      /^This agent's live blobs come to 1024 MiB, at or over the 1024 MiB quota/,
    );
    expect(at?.message).toContain("24 hours");
    const over = judgeBlobQuota(BLOB_QUOTA_BYTES + 5 * 1024 * 1024);
    expect(over?.message).toContain("1029 MiB");
    expect(over).toMatchObject({ bytes: BLOB_QUOTA_BYTES + 5 * 1024 * 1024 });
  });
});

describe("judgeBlobRefs", () => {
  const rows = [
    row(LIVE),
    row(OLD, { expiresAt: new Date(NOW.getTime() - 1) }),
    row(GONE, { removedAt: new Date(NOW.getTime() - 60_000) }),
  ];

  it("passes when every ref has a live row", () => {
    expect(judgeBlobRefs([LIVE], rows, NOW)).toBeNull();
    expect(judgeBlobRefs([], rows, NOW)).toBeNull();
  });

  it("refuses the first ref with no row as blob_not_found, naming the ref and never whose it is", () => {
    const refusal = judgeBlobRefs([LIVE, NOBODYS, OLD], rows, NOW);
    expect(refusal).toEqual({
      error: "refused",
      reason: "blob_not_found",
      ref: NOBODYS,
      message: `${NOBODYS} names no blob this agent holds. Run the tool that produced it again and pass the ref it answers.`,
    });
    // A ref whose id could not name a directory has no row to find, and is worded the same.
    expect(judgeBlobRefs(["blob://../etc"], rows, NOW)).toMatchObject({
      reason: "blob_not_found",
      ref: "blob://../etc",
    });
  });

  it("refuses a row past its expiry, or removed, as blob_expired naming the TTL; an expiry at this instant has passed", () => {
    const expired = judgeBlobRefs([LIVE, OLD], rows, NOW);
    expect(expired).toEqual({
      error: "refused",
      reason: "blob_expired",
      ref: OLD,
      message: `${OLD} has expired: a blob lives 24 hours from its write, and this one's time has passed. Run the tool that produced it again and pass the new ref.`,
    });
    expect(judgeBlobRefs([GONE], rows, NOW)).toMatchObject({ reason: "blob_expired", ref: GONE });
    expect(judgeBlobRefs([LIVE], [row(LIVE, { expiresAt: NOW })], NOW)).toMatchObject({
      reason: "blob_expired",
    });
    expect(
      judgeBlobRefs([LIVE], [row(LIVE, { expiresAt: new Date(NOW.getTime() + 1) })], NOW),
    ).toBeNull();
  });

  it("judges in the input's order: a missing ref ahead of an expired one is the answer", () => {
    expect(judgeBlobRefs([NOBODYS, OLD], rows, NOW)).toMatchObject({ reason: "blob_not_found" });
    expect(judgeBlobRefs([OLD, NOBODYS], rows, NOW)).toMatchObject({ reason: "blob_expired" });
  });
});
