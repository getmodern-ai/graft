import { describe, expect, it } from "vitest";

import { approvalDecision } from "./approval.decision";

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
        approval: { decision: "deny", askEveryCall: false },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: read,
        approval: { decision: "allow", askEveryCall: true },
      }),
    ).toBe("pass");
  });

  it("asks once for a write, then holds the answer", () => {
    expect(approvalDecision({ annotations: write, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "allow", askEveryCall: false },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "deny", askEveryCall: false },
      }),
    ).toBe("deny");
  });

  it("asks once for a destructive tool too, and holds the answer like a write's", () => {
    expect(approvalDecision({ annotations: destructive, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", askEveryCall: false },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", askEveryCall: false },
      }),
    ).toBe("deny");
  });

  it("asks on every call while the person has the tool set to ask every time, write or destructive", () => {
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "allow", askEveryCall: true },
      }),
    ).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", askEveryCall: true },
      }),
    ).toBe("ask");
  });

  it("refuses a denied tool whether or not it is set to ask every time", () => {
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", askEveryCall: true },
      }),
    ).toBe("deny");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "deny", askEveryCall: true },
      }),
    ).toBe("deny");
  });
});
