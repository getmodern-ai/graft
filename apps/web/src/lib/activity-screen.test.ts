import { describe, expect, it } from "vitest";

import {
  type ActivityApproval,
  activityAnswerCopy,
  activityIntegrationName,
  activityRows,
  activityScreenKey,
  activityScreenSearchParams,
  type IntegrationNames,
  integrationFilterItems,
  isFiltered,
  readActivityScreenSearch,
} from "./activity-screen";
import type { ActivityPage } from "./integration-activity";

describe("readActivityScreenSearch", () => {
  it("reads the integration, the agent and a known outcome", () => {
    expect(
      readActivityScreenSearch({ vendor: "gmail", agent: "agt_1", outcome: "blocked" }),
    ).toEqual({ vendor: "gmail", agent: "agt_1", outcome: "blocked" });
    expect(readActivityScreenSearch({ outcome: "answered" })).toEqual({ outcome: "answered" });
  });

  it("drops an unknown outcome, an empty or oversized id and a non-string", () => {
    expect(readActivityScreenSearch({ vendor: "", agent: 3, outcome: "refused" })).toEqual({});
    expect(readActivityScreenSearch({ vendor: "x".repeat(201), outcome: null })).toEqual({});
    expect(readActivityScreenSearch({})).toEqual({});
  });
});

describe("isFiltered", () => {
  it("is true when any filter is applied", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ vendor: "gmail" })).toBe(true);
    expect(isFiltered({ agent: "agt_1" })).toBe(true);
    expect(isFiltered({ outcome: "ran" })).toBe(true);
  });
});

describe("activityScreenSearchParams", () => {
  it("asks for calls and answers alike with no filter", () => {
    expect(activityScreenSearchParams({}, null).toString()).toBe("");
  });

  it("names the integration, the agent, the ledger's outcome and the cursor", () => {
    const params = activityScreenSearchParams(
      { vendor: "gmail", agent: "agt_1", outcome: "failed" },
      "abc",
    );
    expect(Object.fromEntries(params)).toEqual({
      vendor: "gmail",
      agentId: "agt_1",
      outcome: "error",
      cursor: "abc",
    });
  });

  it("reads Your answers as the answers alone", () => {
    expect(Object.fromEntries(activityScreenSearchParams({ outcome: "answered" }, null))).toEqual({
      kind: "approval",
    });
  });
});

describe("activityScreenKey", () => {
  it("sits under the activity root, apart from the integration tab's", () => {
    expect(activityScreenKey({ vendor: "gmail" })).toEqual([
      "activity",
      "screen",
      "gmail",
      null,
      null,
    ]);
  });
});

describe("activityRows", () => {
  it("flattens the pages in order, calls and answers both", () => {
    const pages = [
      { rows: [{ key: "run:1" }, { key: "ask:2" }], nextCursor: "c" },
      { rows: [{ key: "run:3" }], nextCursor: null },
    ] as unknown as ActivityPage[];
    expect(activityRows(pages).map((row) => row.key)).toEqual(["run:1", "ask:2", "run:3"]);
    expect(activityRows(undefined)).toEqual([]);
  });
});

const names: IntegrationNames = {
  byVendor: new Map([["acme_crm", "Acme CRM"]]),
  byConnection: new Map([["conn_old", "Old Thing"]]),
};

describe("activityIntegrationName", () => {
  it("prefers a starter's own name, then the live integration's, then the connection's, then the slug", () => {
    expect(activityIntegrationName({ vendor: "gmail", connectionId: null }, names)).toBe("Gmail");
    expect(activityIntegrationName({ vendor: "acme_crm", connectionId: null }, names)).toBe(
      "Acme CRM",
    );
    expect(activityIntegrationName({ vendor: "old", connectionId: "conn_old" }, names)).toBe(
      "Old Thing",
    );
    expect(activityIntegrationName({ vendor: "gone", connectionId: "conn_x" }, names)).toBe("gone");
  });

  it("is null for a row that recorded no integration", () => {
    expect(activityIntegrationName({ vendor: null, connectionId: null }, names)).toBeNull();
  });
});

type Answer = Pick<
  ActivityApproval,
  "source" | "agent" | "tool" | "decision" | "includesDestructive" | "askKind" | "answer"
>;

const answer = (over: Partial<Answer>): Answer => ({
  source: "ask",
  agent: { id: "agt_1", name: "Codex" },
  tool: null,
  decision: null,
  includesDestructive: null,
  askKind: null,
  answer: null,
  ...over,
});

const tool = { id: "tool_1", wireName: "gmail__draft_replies", description: null };

describe("activityAnswerCopy", () => {
  it("words a tool's standing answer", () => {
    expect(
      activityAnswerCopy(answer({ source: "tool", tool, decision: "allow" }), "Gmail"),
    ).toEqual({
      sentence: "You always allowed Codex to draft replies in Gmail",
      outcome: "allowed",
    });
    expect(activityAnswerCopy(answer({ source: "tool", tool, decision: "deny" }), "Gmail")).toEqual(
      {
        sentence: "You denied Codex permission to draft replies in Gmail",
        outcome: "denied",
      },
    );
    expect(
      activityAnswerCopy(answer({ source: "tool", tool: null, decision: "allow" }), "Gmail"),
    ).toEqual({ sentence: "You always allowed Codex to use a Gmail tool", outcome: "allowed" });
  });

  it("words an integration's standing approval with or without the tools that delete", () => {
    expect(
      activityAnswerCopy(answer({ source: "vendor", includesDestructive: false }), "Gmail")
        .sentence,
    ).toBe("You allowed Codex every Gmail tool that cannot delete");
    expect(
      activityAnswerCopy(answer({ source: "vendor", includesDestructive: true }), "Gmail").sentence,
    ).toBe("You allowed Codex every Gmail tool, including ones that can delete");
  });

  it("words a build and a scope ask, allowed or declined", () => {
    expect(
      activityAnswerCopy(answer({ askKind: "build", answer: { allow: true } }), "Gmail"),
    ).toEqual({ sentence: "You let Codex build its own Gmail tools", outcome: "allowed" });
    expect(
      activityAnswerCopy(answer({ askKind: "build", answer: { allow: false } }), "Gmail"),
    ).toEqual({
      sentence: "You declined Codex's request to build its own Gmail tools",
      outcome: "declined",
    });
    expect(
      activityAnswerCopy(
        answer({ askKind: "scope", answer: { allow: true, approveBuild: true } }),
        "Gmail",
      ).sentence,
    ).toBe("You let Codex use Gmail and build its own tools for it");
    expect(
      activityAnswerCopy(answer({ askKind: "scope", answer: { allow: true } }), "Gmail").sentence,
    ).toBe("You let Codex use Gmail");
    expect(
      activityAnswerCopy(answer({ askKind: "scope", answer: { allow: false } }), "Gmail").outcome,
    ).toBe("declined");
  });

  it("words a connection and a credential ask by whether a connection was made", () => {
    expect(
      activityAnswerCopy(answer({ askKind: "connection", answer: { connectionId: "c" } }), "Gmail"),
    ).toEqual({ sentence: "You connected Gmail for Codex", outcome: "connected" });
    expect(
      activityAnswerCopy(answer({ askKind: "connection", answer: { allow: false } }), "Gmail"),
    ).toEqual({ sentence: "You declined Codex's request to connect Gmail", outcome: "declined" });
    expect(
      activityAnswerCopy(answer({ askKind: "credential", answer: { connectionId: "c" } }), "Gmail")
        .sentence,
    ).toBe("You reconnected Gmail for Codex");
  });

  it("still reads an unknown kind, or a row with no integration, as an answer", () => {
    expect(activityAnswerCopy(answer({ askKind: "later", answer: { allow: true } }), null)).toEqual(
      {
        sentence: "You answered Codex's request",
        outcome: "allowed",
      },
    );
    expect(
      activityAnswerCopy(answer({ askKind: "build", answer: { allow: true } }), null).sentence,
    ).toBe("You let Codex build its own tools");
    expect(activityAnswerCopy(answer({ askKind: "connection", answer: null }), null).sentence).toBe(
      "You declined Codex's request to connect an integration",
    );
  });
});

describe("integrationFilterItems", () => {
  it("lists each integration once by name, A to Z", () => {
    const connections = [
      { vendor: "slack", displayName: "Slack (work)" },
      { vendor: "acme_crm", displayName: "acme" },
      { vendor: "slack", displayName: "Slack (home)" },
    ];
    expect(integrationFilterItems(connections, names, undefined)).toEqual([
      { value: "acme_crm", label: "Acme CRM" },
      { value: "slack", label: "Slack" },
    ]);
  });

  it("keeps a slug the URL names that the list does not hold", () => {
    expect(integrationFilterItems([], names, "gone")).toEqual([{ value: "gone", label: "gone" }]);
  });
});
