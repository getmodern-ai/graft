import { validateVendor } from "@graft/core/connection/connection.rules";
import { describe, expect, it } from "vitest";

import {
  type ActivityApproval,
  activityAnswerCopy,
  activityIntegrationName,
  activityRows,
  activityScreenKey,
  activityScreenQuery,
  activityScreenSearchParams,
  type IntegrationNames,
  integrationFilterItems,
  isFiltered,
  NO_FILTER,
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
  "source" | "agent" | "tool" | "decision" | "includesDestructive" | "askKind" | "answer" | "event"
>;

const answer = (over: Partial<Answer>): Answer => ({
  source: "ask",
  agent: { id: "agt_1", name: "Codex" },
  tool: null,
  decision: null,
  includesDestructive: null,
  askKind: null,
  answer: null,
  event: null,
  ...over,
});

/** An approval event (GRA-341), as the read answers one. */
const event = (
  kind: NonNullable<Answer["event"]>["kind"],
  action: NonNullable<Answer["event"]>["action"],
  over: Partial<Answer> = {},
): Answer => answer({ source: "event", event: { kind, action, via: "console" }, ...over });

const tool = { id: "tool_1", wireName: "gmail__draft_replies", description: null };

describe("activityAnswerCopy", () => {
  it("words a tool's standing answer", () => {
    expect(
      activityAnswerCopy(answer({ source: "tool", tool, decision: "allow" }), "Gmail"),
    ).toEqual({
      sentence: "You allowed Codex to draft replies in Gmail",
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
    ).toEqual({ sentence: "You allowed Codex to use a Gmail tool", outcome: "allowed" });
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

describe("activityAnswerCopy over approval events (GRA-341)", () => {
  const say = (row: Answer, name: string | null = "Gmail") => activityAnswerCopy(row, name);

  it("words a tool's answer, its withdraw beside it, and the ask-every-call switch without saying always", () => {
    expect(say(event("tool", "allowed", { tool }))).toEqual({
      sentence: "You allowed Codex to draft replies in Gmail",
      outcome: "allowed",
    });
    expect(say(event("tool", "denied", { tool })).outcome).toBe("denied");
    expect(say(event("tool", "withdrew", { tool }))).toEqual({
      sentence: "You withdrew your answer on whether Codex can draft replies in Gmail",
      outcome: "withdrawn",
    });
    expect(say(event("tool", "ask_every_call_on", { tool }))).toEqual({
      sentence: "Codex now asks before every call to draft replies in Gmail",
      outcome: "changed",
    });
    expect(say(event("tool", "ask_every_call_off", { tool })).sentence).toBe(
      "Codex no longer asks before every call to draft replies in Gmail",
    );
    for (const action of ["allowed", "denied", "withdrew", "ask_every_call_on"] as const) {
      expect(say(event("tool", action, { tool })).sentence).not.toMatch(/always/i);
    }
  });

  it("words an integration's approval as it was given, widened, narrowed and withdrawn", () => {
    expect(say(event("vendor", "allowed", { includesDestructive: false }))).toEqual({
      sentence: "You allowed Codex every Gmail tool that cannot delete",
      outcome: "allowed",
    });
    expect(say(event("vendor", "widened", { includesDestructive: true }))).toEqual({
      sentence: "You allowed Codex every Gmail tool, including ones that can delete",
      outcome: "changed",
    });
    expect(say(event("vendor", "narrowed", { includesDestructive: false })).sentence).toBe(
      "You narrowed Codex's Gmail approval to tools that cannot delete",
    );
    expect(say(event("vendor", "withdrew"))).toEqual({
      sentence: "You withdrew Codex's approval for every Gmail tool",
      outcome: "withdrawn",
    });
  });

  it("words a build approval given, declined and withdrawn", () => {
    expect(say(event("build", "allowed")).sentence).toBe("You let Codex build its own Gmail tools");
    expect(say(event("build", "denied")).outcome).toBe("declined");
    expect(say(event("build", "withdrew")).sentence).toBe(
      "You withdrew Codex's permission to build its own Gmail tools",
    );
  });

  it("words a connection's revoke with no agent, and an agent's revoke", () => {
    expect(say(event("connection", "revoked", { agent: null }), "Notion")).toEqual({
      sentence: "You revoked Notion",
      outcome: "revoked",
    });
    expect(say(event("agent", "revoked"), null)).toEqual({
      sentence: "You revoked Codex",
      outcome: "revoked",
    });
  });

  it("words a connection and a scope ask answered", () => {
    expect(say(event("connection", "allowed")).sentence).toBe("You connected Gmail for Codex");
    expect(say(event("connection", "denied")).sentence).toBe(
      "You declined Codex's request to connect Gmail",
    );
    expect(say(event("scope", "allowed")).sentence).toBe("You let Codex use Gmail");
    expect(say(event("scope", "denied")).outcome).toBe("declined");
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

describe("NO_FILTER", () => {
  // Greptile on #260: the tab's "all" is a slug a vendor may have, so it cannot mean "no filter".
  it("is no vendor slug, so an integration named all stays selectable", () => {
    expect(validateVendor("all")).toBeNull();
    expect(validateVendor(NO_FILTER)).not.toBeNull();
    const items = integrationFilterItems([{ vendor: "all", displayName: "All" }], names, "all");
    expect(items.map((item) => item.value)).toEqual(["all"]);
    expect(items.some((item) => item.value === NO_FILTER)).toBe(false);
  });
});

describe("activityScreenQuery", () => {
  // Answers and runs land from doors that know nothing of this read, so a visit never reuses one.
  it("is stale at once", () => {
    expect(activityScreenQuery({}).staleTime).toBe(0);
  });
});
