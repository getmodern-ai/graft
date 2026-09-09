import { describe, expect, it } from "vitest";

import { approvalDecision } from "./approval.decision";

/** ADR 0008, one line per rule. */

const read = { readOnly: true, destructive: false };
const write = { readOnly: false, destructive: false };
const destructive = { readOnly: false, destructive: true };

describe("approvalDecision", () => {
  it("lets a read-only tool pass, whatever the approval says", () => {
    expect(approvalDecision({ annotations: read, approval: null })).toBe("pass");
    expect(
      approvalDecision({
        annotations: read,
        approval: { decision: "deny", perCallRelaxed: false },
      }),
    ).toBe("pass");
  });

  it("asks once for a write, then holds the answer", () => {
    expect(approvalDecision({ annotations: write, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "allow", perCallRelaxed: false },
      }),
    ).toBe("pass");
    expect(
      approvalDecision({
        annotations: write,
        approval: { decision: "deny", perCallRelaxed: false },
      }),
    ).toBe("deny");
  });

  it("asks a destructive tool every call until the person relaxes it", () => {
    expect(approvalDecision({ annotations: destructive, approval: null })).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", perCallRelaxed: false },
      }),
    ).toBe("ask");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "allow", perCallRelaxed: true },
      }),
    ).toBe("pass");
  });

  it("refuses a denied destructive tool whether or not it was relaxed", () => {
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", perCallRelaxed: false },
      }),
    ).toBe("deny");
    expect(
      approvalDecision({
        annotations: destructive,
        approval: { decision: "deny", perCallRelaxed: true },
      }),
    ).toBe("deny");
  });
});
