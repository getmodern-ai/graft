import type { BlobRow } from "@graft/db/repo/blob";
import { BLOB_QUOTA_BYTES, BLOB_TTL_MS } from "@graft/runner";
import { describe, expect, it } from "vitest";

import {
  admitBlobs,
  blobBudgetEnvironment,
  blobRefsIn,
  judgeBlobQuota,
  judgeBlobRefs,
  MAX_INPUT_DEPTH,
  walkStringLeaves,
} from "./blob-door";
import type { McpDeps } from "./deps";
import { createInFlightRegistry } from "./in-flight";
import { createFakeDeps, createFakeStore } from "./testing/fake-deps";

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

describe("walkStringLeaves", () => {
  it("visits every string leaf in the input's own order and writes a replacement into its container", () => {
    const input = { a: "x", list: ["y", { deep: "z" }, 3], n: null, b: "w" };
    const seen: string[] = [];
    const walk = walkStringLeaves(input, (leaf, replace) => {
      seen.push(leaf);
      if (leaf === "y" || leaf === "z") replace(`${leaf}!`);
    });
    expect(walk).toEqual({ tooDeep: false });
    expect(seen).toEqual(["x", "y", "z", "w"]);
    expect(input).toEqual({ a: "x", list: ["y!", { deep: "z!" }, 3], n: null, b: "w" });
  });

  it("visits a string root without a container to replace it in, and stops past the depth bound", () => {
    const seen: string[] = [];
    expect(
      walkStringLeaves("alone", (leaf, replace) => {
        seen.push(leaf);
        replace("other");
      }),
    ).toEqual({ tooDeep: false });
    expect(seen).toEqual(["alone"]);
    let nested: unknown = "leaf";
    for (let i = 0; i < MAX_INPUT_DEPTH + 1; i += 1) nested = { nested };
    expect(walkStringLeaves(nested, () => {})).toEqual({ tooDeep: true });
  });
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
    ).toEqual({ refs: [LIVE, OLD, GONE, NOBODYS], tooDeep: false });
  });

  it("finds nothing in a value with no such leaf, a bare string included", () => {
    expect(blobRefsIn({ limit: 1, tags: ["a", "b"] })).toEqual({ refs: [], tooDeep: false });
    expect(blobRefsIn("blob://alone")).toEqual({ refs: ["blob://alone"], tooDeep: false });
    expect(blobRefsIn(null)).toEqual({ refs: [], tooDeep: false });
    expect(blobRefsIn(undefined)).toEqual({ refs: [], tooDeep: false });
  });

  /**
   * The walk is a stack, not the call stack (Greptile on #149): an input nested ten thousand deep
   * is not a stack overflow turned internal error, and past the bound the door refuses it as
   * `input_invalid`, naming the bound.
   */
  it("stops past MAX_INPUT_DEPTH without recursing, and admitBlobs refuses such an input as input_invalid naming the bound", async () => {
    const nest = (depth: number): unknown => {
      let value: unknown = LIVE;
      for (let i = 0; i < depth; i += 1) value = i % 2 === 0 ? { value } : [value];
      return value;
    };
    expect(MAX_INPUT_DEPTH).toBe(64);
    expect(blobRefsIn(nest(MAX_INPUT_DEPTH))).toEqual({ refs: [LIVE], tooDeep: false });
    expect(blobRefsIn(nest(MAX_INPUT_DEPTH + 1))).toEqual({ refs: [], tooDeep: true });
    expect(blobRefsIn(nest(10_000)).tooDeep).toBe(true);

    const store = createFakeStore();
    const deps = {
      ...createFakeDeps(store),
      inFlight: createInFlightRegistry(),
    } as unknown as McpDeps;
    const scope = { personId: "person_1", agentId: "agent_1" };
    const refused = await admitBlobs(deps, scope, { deep: nest(MAX_INPUT_DEPTH + 1) });
    expect(refused).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        error: "refused",
        reason: "input_invalid",
        maxDepth: MAX_INPUT_DEPTH,
        message: expect.stringContaining(`${MAX_INPUT_DEPTH} levels`),
      }),
    });
    // At the bound, the same ref is judged as any other: no row, so not found.
    const judged = await admitBlobs(deps, scope, { deep: nest(MAX_INPUT_DEPTH - 1) });
    expect(judged).toMatchObject({ ok: false, refusal: { reason: "blob_not_found", ref: LIVE } });
    deps.inFlight?.close();
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

/**
 * The door over the fake store and a registry (GRA-187, after Greptile on #148): the budget it hands
 * a run is the quota less the live rows less what it has already handed to this agent's runs still
 * in flight, and a released grant gives the remainder back.
 */
describe("admitBlobs and the outstanding grants", () => {
  const SCOPE = { personId: "person_1", agentId: "agent_1" };
  const MIB = 1024 * 1024;

  it("subtracts the grants still in flight and never hands out less than nothing", async () => {
    const store = createFakeStore();
    const inFlight = createInFlightRegistry();
    const deps = { ...createFakeDeps(store), inFlight } as unknown as McpDeps;
    store.blobs.push({
      ...row(LIVE),
      personId: SCOPE.personId,
      agentId: SCOPE.agentId,
      bytes: BLOB_QUOTA_BYTES - 3 * MIB,
      expiresAt: new Date(Date.now() + BLOB_TTL_MS),
    });

    const first = await admitBlobs(deps, SCOPE, {});
    expect(first).toEqual({ ok: true, admission: { budgetBytes: 3 * MIB } });
    const releaseFirst = inFlight.grant(SCOPE.agentId, 3 * MIB);

    const second = await admitBlobs(deps, SCOPE, {});
    expect(second).toEqual({ ok: true, admission: { budgetBytes: 0 } });
    const releaseSecond = inFlight.grant(SCOPE.agentId, 0);

    // A detached run carries its grant on its process name; another agent's grants are not this one's.
    inFlight.track("agent_2", "tool-x", 60_000, 5 * MIB);
    releaseFirst();
    inFlight.track(SCOPE.agentId, "tool-1", 60_000, 1 * MIB);
    expect(await admitBlobs(deps, SCOPE, {})).toEqual({
      ok: true,
      admission: { budgetBytes: 2 * MIB },
    });
    inFlight.settle(SCOPE.agentId, "tool-1");
    releaseSecond();
    expect(await admitBlobs(deps, SCOPE, {})).toEqual({
      ok: true,
      admission: { budgetBytes: 3 * MIB },
    });
    // The quota refusal reads the rows alone: a grant is a promise, not a byte on the mount.
    inFlight.grant(SCOPE.agentId, 10 * MIB);
    expect(await admitBlobs(deps, SCOPE, {})).toEqual({
      ok: true,
      admission: { budgetBytes: 0 },
    });
    inFlight.close();
  });
});

describe("blobBudgetEnvironment", () => {
  it("hands the exec the budget and the quota under the names runner.mjs reads", () => {
    expect(blobBudgetEnvironment({ budgetBytes: 1536 * 1024 })).toEqual({
      GRAFT_BLOB_BUDGET_BYTES: "1572864",
      GRAFT_BLOB_QUOTA_BYTES: String(BLOB_QUOTA_BYTES),
    });
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
