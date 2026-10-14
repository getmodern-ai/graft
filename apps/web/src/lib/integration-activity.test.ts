import { describe, expect, it } from "vitest";

import {
  type ActivityPage,
  activityFootnote,
  activityRuns,
  activitySearchParams,
  activityToolLabel,
  readActivityFilters,
  refusalSentence,
  timeTakenLabel,
} from "./integration-activity";

describe("readActivityFilters", () => {
  it("reads the agent and a known outcome on the Activity tab", () => {
    expect(readActivityFilters({ tab: "activity", agent: "agt_1", outcome: "blocked" })).toEqual({
      agent: "agt_1",
      outcome: "blocked",
    });
  });

  it("drops an unknown outcome, an empty agent and anything off the Activity tab", () => {
    expect(readActivityFilters({ tab: "activity", agent: "", outcome: "refused" })).toEqual({});
    expect(readActivityFilters({ tab: "activity", agent: 3, outcome: null })).toEqual({});
    expect(readActivityFilters({ tab: "tools", agent: "agt_1", outcome: "ran" })).toEqual({});
    expect(readActivityFilters({ agent: "agt_1" })).toEqual({});
  });
});

describe("activitySearchParams", () => {
  it("asks for the vendor's runs alone with no filter", () => {
    expect(activitySearchParams("gmail", {}, null).toString()).toBe("vendor=gmail&kind=run");
  });

  it("names the agent, the ledger's outcome and the cursor", () => {
    const params = activitySearchParams("gmail", { agent: "agt_1", outcome: "failed" }, "abc");
    expect(Object.fromEntries(params)).toEqual({
      vendor: "gmail",
      kind: "run",
      agentId: "agt_1",
      outcome: "error",
      cursor: "abc",
    });
    expect(activitySearchParams("gmail", { outcome: "ran" }, null).get("outcome")).toBe("ok");
    expect(activitySearchParams("gmail", { outcome: "blocked" }, null).get("outcome")).toBe(
      "refused",
    );
  });
});

describe("activityRuns", () => {
  it("flattens the pages in order and keeps runs alone", () => {
    const run = (key: string) => ({ kind: "run", key }) as unknown as ActivityPage["rows"][number];
    const approval = { kind: "approval", key: "a" } as unknown as ActivityPage["rows"][number];
    const pages: ActivityPage[] = [
      { rows: [run("1"), approval], nextCursor: "c" },
      { rows: [run("2")], nextCursor: null },
    ];
    expect(activityRuns(pages).map((row) => row.key)).toEqual(["1", "2"]);
    expect(activityRuns(undefined)).toEqual([]);
  });
});

describe("refusalSentence", () => {
  it("says the person's own answers in their words", () => {
    expect(refusalSentence("approval_declined")).toBe("You declined it");
    expect(refusalSentence("tool_denied")).toBe("You denied it");
    expect(refusalSentence("awaiting_approval")).toBe("Waiting for you");
  });

  it("never shows a raw code", () => {
    const sentence = refusalSentence("blob_quota");
    expect(sentence).toBe("Graft stopped it before it ran");
    expect(sentence).not.toMatch(/_/);
  });

  it("has nothing to say without a reason", () => {
    expect(refusalSentence(null)).toBeNull();
    expect(refusalSentence("")).toBeNull();
  });
});

describe("activityToolLabel", () => {
  it("reads the wire name's own part as words with a capital", () => {
    expect(activityToolLabel("gmail__send_email")).toBe("Send email");
    expect(activityToolLabel("gmail__findInvoices")).toBe("Find invoices");
  });

  it("names the by-hand command tool without its connection id", () => {
    expect(activityToolLabel("execute__conn_123")).toBe("Command run directly");
  });

  it("falls back to the wire name when there is nothing to read", () => {
    expect(activityToolLabel("gmail__")).toBe("gmail__");
  });
});

describe("timeTakenLabel", () => {
  it("prints seconds to a tenth", () => {
    expect(timeTakenLabel({ outcome: "ok", latencyMs: 1234 })).toBe("1.2 s");
    expect(timeTakenLabel({ outcome: "error", latencyMs: 30_000 })).toBe("30.0 s");
    expect(timeTakenLabel({ outcome: "ok", latencyMs: 40 })).toBe("<0.1 s");
  });

  it("says a blocked call did not run", () => {
    expect(timeTakenLabel({ outcome: "refused", latencyMs: 12 })).toBe("Not run");
  });
});

describe("activityFootnote", () => {
  it("names the integration and has no dash", () => {
    const note = activityFootnote("Gmail");
    expect(note).toContain("Gmail");
    expect(note).not.toMatch(/—/);
  });
});
