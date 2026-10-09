import { describe, expect, it } from "vitest";

import { annotationsWiden, approvalDecision } from "./approval.decision";

/** ADR 0008 (amended 2026-09-15), one line per rule. */

const read = { readOnly: true, destructive: false };
const write = { readOnly: false, destructive: false };
const destructive = { readOnly: false, destructive: true };

describe("approvalDecision", () => {
  it("lets a read-only tool pass, whatever the approval says", () => {
    expect(approvalDecision({ annotations: read, approval: null })).toBe("pass");
    expect(
      approvalDecision({
        annotations: read,
        approval: { decision: "deny", askEveryCall: false, forCurrentVersion: true },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: read,
        approval: { decision: "allow", askEveryCall: true, forCurrentVersion: true },
      }),
    ).toBe("pass");
  });

  it("asks once for a write, then holds the answer", () => {
    expect(approvalDecision({ annotations: write, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "allow", askEveryCall: false, forCurrentVersion: true },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "deny", askEveryCall: false, forCurrentVersion: true },
      }),
    ).toBe("deny");
  });

  it("asks once for a destructive tool too, and holds the answer like a write's", () => {
    expect(approvalDecision({ annotations: destructive, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", askEveryCall: false, forCurrentVersion: true },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", askEveryCall: false, forCurrentVersion: true },
      }),
    ).toBe("deny");
  });

  it("asks on every call while the person has the tool set to ask every time, write or destructive", () => {
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "allow", askEveryCall: true, forCurrentVersion: true },
      }),
    ).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", askEveryCall: true, forCurrentVersion: true },
      }),
    ).toBe("ask");
  });

  it("refuses a denied tool whether or not it is set to ask every time", () => {
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", askEveryCall: true, forCurrentVersion: true },
      }),
    ).toBe("deny");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "deny", askEveryCall: true, forCurrentVersion: true },
      }),
    ).toBe("deny");
  });
});

/** ADR 0008: a republished tool keeps its approval if it stays read-only; a write asks again once. */
describe("approvalDecision across a new version", () => {
  const stale = { decision: "allow", askEveryCall: false, forCurrentVersion: false } as const;

  it("asks again for a write or destructive tool whose allow was given for an earlier version", () => {
    expect(approvalDecision({ annotations: write, approval: stale })).toBe("ask");
    expect(approvalDecision({ annotations: destructive, approval: stale })).toBe("ask");
  });

  it("lets a read-only tool pass whatever version the approval was given for", () => {
    expect(approvalDecision({ annotations: read, approval: stale })).toBe("pass");
  });

  it("holds a deny across a new version: a republish is no way past the person's no", () => {
    expect(approvalDecision({ annotations: write, approval: { ...stale, decision: "deny" } })).toBe(
      "deny",
    );
  });
});

/** ADR 0008 as amended 2026-10-09: a new stock version keeps the approval unless it widens. */
describe("annotationsWiden", () => {
  it("is false for the same annotations, and for a narrowing", () => {
    expect(annotationsWiden(write, write)).toBe(false);
    expect(annotationsWiden(destructive, destructive)).toBe(false);
    expect(annotationsWiden(destructive, write)).toBe(false);
    expect(annotationsWiden(write, read)).toBe(false);
    expect(annotationsWiden(read, read)).toBe(false);
  });

  it("is true from read-only to a write, and from non-destructive to destructive", () => {
    expect(annotationsWiden(read, write)).toBe(true);
    expect(annotationsWiden(read, destructive)).toBe(true);
    expect(annotationsWiden(write, destructive)).toBe(true);
  });
});
