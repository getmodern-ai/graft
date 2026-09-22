import { describe, expect, it } from "vitest";

import {
  BLOB_TMP_SUFFIX,
  type BlobSweepEntry,
  type BlobSweepRow,
  blobSweepDecision,
  isTmpName,
  parseBlobSidecar,
} from "./blob-sweep.decision";

/**
 * ADR 0023's "the sweep deletes", clause by clause, with no clock but the one handed in. Every case
 * names its rows and directories by what the rule should see in them (live, expired, landing,
 * orphaned, abandoned), so a failure reads as a sentence about the rule rather than about a date.
 */

const NOW = new Date("2026-09-23T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const AGENT = "agent_1";
const ABANDONED_AFTER = HOUR;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const hoursOn = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

const row = (id: string, expiresAt: Date, removedAt: Date | null = null): BlobSweepRow => ({
  id,
  bytes: 1_024,
  expiresAt,
  removedAt,
});

const sidecar = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    bytes: 512,
    contentType: "application/pdf",
    name: "invoice.pdf",
    writtenAt: hoursAgo(2).toISOString(),
    expiresAt: hoursOn(22).toISOString(),
    agentId: AGENT,
    toolVersion: "ver_1",
    ...overrides,
  });

const decide = (rows: BlobSweepRow[], entries: BlobSweepEntry[]) =>
  blobSweepDecision({ agentId: AGENT, rows, entries, now: NOW, abandonedWriteMs: ABANDONED_AFTER })
    .actions;

describe("a row and its directory", () => {
  it("keeps a live row whose directory is there", () => {
    expect(decide([row("live", hoursOn(1))], [{ name: "live" }])).toEqual([
      { action: "keep", name: "live", reason: "live" },
    ]);
  });

  it("removes a row past its expiry whose directory is there, and marks it", () => {
    expect(decide([row("old", hoursAgo(1))], [{ name: "old" }])).toEqual([
      { action: "remove", blobId: "old", bytes: 1_024, mark: true },
    ]);
  });

  it("marks a row past its expiry whose directory is already gone", () => {
    expect(decide([row("gone", hoursAgo(1))], [])).toEqual([
      { action: "mark", blobId: "gone", bytes: 1_024 },
    ]);
  });

  it("keeps a live row whose directory is missing: the write may still be landing (GRA-123)", () => {
    expect(decide([row("landing", hoursOn(1))], [])).toEqual([
      { action: "keep", name: "landing", reason: "landing" },
    ]);
  });

  it("never removes a live row, however many expired ones sit beside it", () => {
    const actions = decide(
      [row("a", hoursOn(1)), row("b", hoursAgo(1)), row("c", hoursOn(23)), row("d", hoursAgo(20))],
      [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
    );
    expect(
      actions.filter((a) => a.action !== "keep").map((a) => "blobId" in a && a.blobId),
    ).toEqual(["b", "d"]);
    expect(actions.filter((a) => a.action === "keep").map((a) => "name" in a && a.name)).toEqual([
      "a",
      "c",
    ]);
  });

  it("is strict: a row expiring exactly now is not yet past it", () => {
    expect(decide([row("edge", NOW)], [{ name: "edge" }])).toEqual([
      { action: "keep", name: "edge", reason: "live" },
    ]);
    expect(decide([row("edge", new Date(NOW.getTime() - 1))], [{ name: "edge" }])).toEqual([
      { action: "remove", blobId: "edge", bytes: 1_024, mark: true },
    ]);
  });

  it("removes again, without marking, a directory whose row is already marked; a marked row with no directory is not in the plan", () => {
    expect(
      decide(
        [row("back", hoursAgo(30), hoursAgo(5)), row("done", hoursAgo(30), hoursAgo(5))],
        [{ name: "back" }],
      ),
    ).toEqual([{ action: "remove", blobId: "back", bytes: 1_024, mark: false }]);
  });
});

describe("a directory with no row", () => {
  it("adopts one with a readable sidecar, carrying the sidecar whole", () => {
    const text = sidecar();
    expect(decide([], [{ name: "orphan", sidecar: text, stat: null }])).toEqual([
      {
        action: "adopt",
        blobId: "orphan",
        sidecar: {
          bytes: 512,
          contentType: "application/pdf",
          name: "invoice.pdf",
          writtenAt: hoursAgo(2),
          expiresAt: hoursOn(22),
          agentId: AGENT,
          toolVersion: "ver_1",
        },
      },
    ]);
  });

  it("adopts one whose sidecar names no agent (a runner invoked by hand), and one already past its expiry, to be judged as a row next pass", () => {
    const actions = decide(
      [],
      [
        {
          name: "by-hand",
          sidecar: sidecar({ agentId: null, toolVersion: null, name: undefined }),
        },
        { name: "stale", sidecar: sidecar({ expiresAt: hoursAgo(3).toISOString() }) },
      ],
    );
    expect(actions.map((a) => a.action)).toEqual(["adopt", "adopt"]);
    expect(actions[0]).toMatchObject({
      sidecar: { agentId: null, toolVersion: null, name: null },
    });
  });

  it("removes one with no sidecar, an unreadable one, or one naming another agent, as an orphan with the bytes the store saw", () => {
    const stat = { lastWrittenAt: hoursAgo(1), bytes: 77 };
    expect(
      decide(
        [],
        [
          { name: "no-sidecar", sidecar: null, stat },
          { name: "not-json", sidecar: "{not json", stat },
          { name: "no-size", sidecar: sidecar({ bytes: "many" }), stat },
          { name: "no-type", sidecar: sidecar({ contentType: "" }), stat },
          { name: "no-expiry", sidecar: sidecar({ expiresAt: "someday" }), stat },
          { name: "theirs", sidecar: sidecar({ agentId: "agent_2" }), stat },
          { name: "vanished", sidecar: null, stat: null },
        ],
      ),
    ).toEqual([
      { action: "remove_orphan", blobId: "no-sidecar", bytes: 77 },
      { action: "remove_orphan", blobId: "not-json", bytes: 77 },
      { action: "remove_orphan", blobId: "no-size", bytes: 77 },
      { action: "remove_orphan", blobId: "no-type", bytes: 77 },
      { action: "remove_orphan", blobId: "no-expiry", bytes: 77 },
      { action: "remove_orphan", blobId: "theirs", bytes: 77 },
      { action: "remove_orphan", blobId: "vanished", bytes: null },
    ]);
  });
});

describe("a .tmp directory", () => {
  const tmp = (id: string) => `${id}${BLOB_TMP_SUFFIX}`;

  it("keeps one written to inside the bound: the write may still be in progress", () => {
    expect(
      decide([], [{ name: tmp("fresh"), stat: { lastWrittenAt: hoursAgo(0.5), bytes: 10 } }]),
    ).toEqual([{ action: "keep", name: tmp("fresh"), reason: "writing" }]);
  });

  it("removes one last written to before the bound, with the bytes it holds", () => {
    expect(
      decide([], [{ name: tmp("stale"), stat: { lastWrittenAt: hoursAgo(1.5), bytes: 10 } }]),
    ).toEqual([{ action: "remove_tmp", name: tmp("stale"), bytes: 10 }]);
  });

  it("is strict at the bound, and keeps one whose age could not be read", () => {
    expect(
      decide([], [{ name: tmp("edge"), stat: { lastWrittenAt: hoursAgo(1), bytes: null } }]),
    ).toEqual([{ action: "keep", name: tmp("edge"), reason: "writing" }]);
    expect(decide([], [{ name: tmp("unread") }, { name: tmp("gone"), stat: null }])).toEqual([
      { action: "keep", name: tmp("unread"), reason: "writing" },
      { action: "keep", name: tmp("gone"), reason: "writing" },
    ]);
  });

  it("never has a row, so a sidecar beside it is not read", () => {
    expect(
      decide(
        [],
        [{ name: tmp("half"), sidecar: sidecar(), stat: { lastWrittenAt: hoursAgo(2), bytes: 3 } }],
      ),
    ).toEqual([{ action: "remove_tmp", name: tmp("half"), bytes: 3 }]);
  });

  it("names a .tmp by its suffix and nothing else", () => {
    expect(isTmpName("abc.tmp")).toBe(true);
    expect(isTmpName(".tmp")).toBe(false);
    expect(isTmpName("abc")).toBe(false);
    expect(isTmpName("abc.tmp.x")).toBe(false);
  });
});

describe("the sidecar reader", () => {
  it("reads what the runner writes and refuses anything else", () => {
    expect(parseBlobSidecar(sidecar())).toMatchObject({ bytes: 512, name: "invoice.pdf" });
    for (const bad of [
      "",
      "[]",
      "null",
      "42",
      sidecar({ writtenAt: undefined }),
      sidecar({ bytes: -1 }),
    ]) {
      expect(parseBlobSidecar(bad), bad).toBeNull();
    }
  });
});

describe("the plan as a whole", () => {
  it("judges rows first, then the directories no row claims, in the order given, and touches nothing it was not handed", () => {
    const actions = decide(
      [row("expired", hoursAgo(2)), row("live", hoursOn(2))],
      [
        { name: "live" },
        { name: "expired" },
        { name: "orphan", sidecar: sidecar() },
        { name: "junk", sidecar: null, stat: { lastWrittenAt: hoursAgo(9), bytes: null } },
        { name: `w${BLOB_TMP_SUFFIX}`, stat: { lastWrittenAt: hoursAgo(9), bytes: 1 } },
      ],
    );
    expect(actions.map((a) => a.action)).toEqual([
      "remove",
      "keep",
      "adopt",
      "remove_orphan",
      "remove_tmp",
    ]);
  });
});
