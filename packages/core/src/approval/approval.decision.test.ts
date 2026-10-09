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

  /** ADR 0008 as amended 2026-10-09: an integration allowed at once for the agent (GRA-237). */
  describe("under a standing approval for the tool's integration", () => {
    const writesOnly = { includesDestructive: false };
    const everything = { includesDestructive: true };

    it("lets a write the agent was never asked about pass", () => {
      expect(
        approvalDecision({ annotations: write, approval: null, vendorApproval: writesOnly }),
      ).toBe("pass");
    });

    it("still asks for a destructive tool unless the person included destructive tools", () => {
      expect(
        approvalDecision({ annotations: destructive, approval: null, vendorApproval: writesOnly }),
      ).toBe("ask");
      expect(
        approvalDecision({ annotations: destructive, approval: null, vendorApproval: everything }),
      ).toBe("pass");
    });

    it("still asks for a tool the person set to ask every time", () => {
      expect(
        approvalDecision({
          annotations: write,
          approval: { decision: "allow", askEveryCall: true },
          vendorApproval: everything,
        }),
      ).toBe("ask");
    });

    it("keeps refusing a tool the person denied on its own", () => {
      expect(
        approvalDecision({
          annotations: write,
          approval: { decision: "deny", askEveryCall: false },
          vendorApproval: everything,
        }),
      ).toBe("deny");
    });

    it("leaves a read passing, as every read does", () => {
      expect(
        approvalDecision({ annotations: read, approval: null, vendorApproval: writesOnly }),
      ).toBe("pass");
    });
  });
});
