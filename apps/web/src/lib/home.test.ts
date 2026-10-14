import { describe, expect, it } from "vitest";
import type { ActivityRow } from "./activity-screen";
import {
  firstOf,
  HOME_AGENT_ROWS,
  HOME_INTEGRATION_ROWS,
  homeActivityCopy,
  homeAgents,
  homeIntegrationNames,
  homeIntegrations,
  homeSuggestions,
  integrationUsageLine,
  needsYouRows,
  suggestionLine,
} from "./home";
import type { Integration, SuggestedIntegration } from "./integration-queries";

/** Home (GRA-327): how much each panel draws, and what its rows say. */

const integration = (overrides: Partial<Integration> = {}): Integration => ({
  vendor: "gmail",
  displayName: "Gmail",
  connections: [],
  agents: [],
  toolCount: 0,
  lastUsedAt: null,
  needsAttention: null,
  ...overrides,
});

const claude = { id: "agt_1", name: "Claude", harness: "Claude" };
const codex = { id: "agt_2", name: "Codex", harness: "Codex" };

describe("firstOf", () => {
  it("cuts a list and counts what it left out", () => {
    expect(firstOf([1, 2, 3, 4, 5], 4)).toEqual({ shown: [1, 2, 3, 4], more: 1 });
    expect(firstOf([1], 4)).toEqual({ shown: [1], more: 0 });
  });
});

describe("needsYouRows", () => {
  it("puts the sign-in rows first and cuts both to four together", () => {
    expect(needsYouRows(["s1", "s2"], ["a1", "a2", "a3"])).toEqual({
      signIns: ["s1", "s2"],
      asks: ["a1", "a2"],
      more: 1,
    });
    expect(needsYouRows(["s1", "s2", "s3", "s4", "s5"], ["a1"])).toEqual({
      signIns: ["s1", "s2", "s3", "s4"],
      asks: [],
      more: 2,
    });
    expect(needsYouRows([], ["a1"])).toEqual({ signIns: [], asks: ["a1"], more: 0 });
  });
});

describe("homeAgents", () => {
  it("lists the active agents only, up to the panel's length", () => {
    const agents = Array.from({ length: HOME_AGENT_ROWS + 2 }, (_, index) => ({
      id: `a${index}`,
      revokedAt: index === 0 ? "2026-10-01T00:00:00.000Z" : null,
    }));
    const { shown, more } = homeAgents(agents);
    expect(shown.map((agent) => agent.id)).not.toContain("a0");
    expect(shown).toHaveLength(HOME_AGENT_ROWS);
    expect(more).toBe(1);
  });
});

describe("homeIntegrations", () => {
  it("puts one that needs the person first, then the most recently used", () => {
    const rows = [
      integration({ vendor: "a", displayName: "A", lastUsedAt: "2026-10-01T00:00:00.000Z" }),
      integration({ vendor: "b", displayName: "B", lastUsedAt: "2026-10-10T00:00:00.000Z" }),
      integration({
        vendor: "c",
        displayName: "C",
        needsAttention: { reason: "consent_required", connectionId: "x" },
      }),
    ];
    expect(homeIntegrations(rows).shown.map((row) => row.vendor)).toEqual(["c", "b", "a"]);
  });

  it("stops at the panel's length", () => {
    const rows = Array.from({ length: HOME_INTEGRATION_ROWS + 3 }, (_, index) =>
      integration({ vendor: `v${index}`, displayName: `V${index}` }),
    );
    expect(homeIntegrations(rows)).toMatchObject({ more: 3 });
  });
});

describe("integrationUsageLine", () => {
  it("counts the tools and names who uses them", () => {
    expect(integrationUsageLine(integration({ toolCount: 1, agents: [claude] }))).toBe(
      "1 tool, used by Claude",
    );
    expect(integrationUsageLine(integration({ toolCount: 3, agents: [claude, codex] }))).toBe(
      "3 tools, used by Claude and Codex",
    );
    expect(integrationUsageLine(integration())).toBe("No tools yet, no agent can use it");
  });
});

const suggestion = (
  vendor: string,
  state: SuggestedIntegration["ask"]["state"] = "open",
): SuggestedIntegration => ({
  vendor,
  displayName: vendor,
  docsUrl: null,
  logoUrl: null,
  agent: { id: "agt_2", name: "Codex" },
  ask: {
    pendingActionId: `pa_${vendor}`,
    state,
    askedAt: "2026-10-14T00:00:00.000Z",
    ageSeconds: 60,
  },
});

describe("homeSuggestions", () => {
  it("shows each vendor once, leaves out a connected one, and stops at one row", () => {
    const list = ["slack", "slack", "gmail", "linear", "notion", "jira", "asana"].map((vendor) =>
      suggestion(vendor),
    );
    expect(homeSuggestions(list, [{ vendor: "gmail" }]).map((entry) => entry.vendor)).toEqual([
      "slack",
      "linear",
      "notion",
      "jira",
    ]);
  });
});

describe("suggestionLine", () => {
  it("says who asked and where the ask stands, quoting nothing", () => {
    expect(suggestionLine(suggestion("slack", "open"))).toBe("Codex is waiting on this one");
    expect(suggestionLine(suggestion("slack", "declined"))).toBe(
      "Codex asked for it, and you declined",
    );
    expect(suggestionLine(suggestion("slack", "expired"))).toBe("Codex asked for it");
  });
});

const base = {
  key: "k",
  at: "2026-10-14T00:00:00.000Z",
  agent: { id: "agt_2", name: "Codex" },
  vendor: "apollo",
  connectionId: "conn_1",
};
const run = (overrides: Record<string, unknown>): ActivityRow =>
  ({
    ...base,
    kind: "run",
    id: "r1",
    tool: { id: "t1", wireName: "apollo__find_leads", description: null },
    outcome: "ok",
    reason: null,
    asked: false,
    latencyMs: 300,
    dryRun: false,
    ...overrides,
  }) as ActivityRow;
const answer = (overrides: Record<string, unknown>): ActivityRow =>
  ({
    ...base,
    kind: "approval",
    source: "tool",
    pendingActionId: null,
    tool: { id: "t1", wireName: "apollo__find_leads", description: null },
    decision: "allow",
    includesDestructive: null,
    askKind: null,
    answer: null,
    ...overrides,
  }) as ActivityRow;

const names = homeIntegrationNames([
  integration({
    vendor: "apollo",
    displayName: "Apollo",
    connections: [{ id: "conn_1", displayName: "Apollo" } as Integration["connections"][number]],
  }),
]);

describe("homeActivityCopy", () => {
  it("reads a run that went through without asking", () => {
    expect(homeActivityCopy(run({}), names)).toEqual({
      title: "Codex ran Find leads in Apollo",
      detail: "Ran without asking",
      tone: "muted",
    });
    expect(homeActivityCopy(run({ asked: true }), names).detail).toBe("You allowed it");
  });

  it("reads a blocked and a failed run as needing a look", () => {
    expect(homeActivityCopy(run({ outcome: "refused", reason: "tool_denied" }), names)).toEqual({
      title: "Codex was blocked from Find leads in Apollo",
      detail: "You denied it",
      tone: "destructive",
    });
    expect(homeActivityCopy(run({ outcome: "error", reason: "threw" }), names)).toEqual({
      title: "Codex's Find leads failed",
      detail: "It could not finish",
      tone: "destructive",
    });
    // Graft's own failure is never put on the integration.
    expect(
      homeActivityCopy(run({ outcome: "error", reason: "sandbox_unavailable" }), names).detail,
    ).toBe("Graft could not start it");
    expect(homeActivityCopy(run({ outcome: "error", reason: "timeout" }), names).detail).toBe(
      "It took too long and was stopped",
    );
  });

  it("names a vendor it does not hold by its slug", () => {
    expect(homeActivityCopy(run({ vendor: "zapier", connectionId: null }), names).title).toBe(
      "Codex ran Find leads in zapier",
    );
  });

  it("reads the person's answers in the Activity screen's sentence", () => {
    expect(homeActivityCopy(answer({}), names).title).toBe(
      "You allowed Codex to find leads in Apollo",
    );
    expect(homeActivityCopy(answer({ decision: "deny" }), names).title).toBe(
      "You denied Codex permission to find leads in Apollo",
    );
    expect(
      homeActivityCopy(answer({ source: "vendor", tool: null, includesDestructive: false }), names)
        .title,
    ).toBe("You allowed Codex every Apollo tool that cannot delete");
    expect(
      homeActivityCopy(
        answer({ source: "ask", tool: null, askKind: "connection", answer: { connectionId: "c" } }),
        names,
      ).title,
    ).toBe("You connected Apollo for Codex");
    expect(homeActivityCopy(answer({}), names).detail).toBe("Your answer");
  });
});
