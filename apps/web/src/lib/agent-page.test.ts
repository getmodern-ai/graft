import { describe, expect, it } from "vitest";

import {
  type ActivityRow,
  activityRowView,
  agentActivityHref,
  agentHeaderFacts,
  agentIntegrationsStat,
  agentRequestCount,
  integrationNameOf,
  integrationsStatDetail,
  integrationsStatValue,
  lastActiveDetail,
  runsSplitLine,
} from "./agent-page";

const at = "2026-10-14T00:00:00Z";

describe("agentHeaderFacts", () => {
  it("names the client, when it connected and that it signs in with OAuth", () => {
    expect(
      agentHeaderFacts({
        connectedVia: { clientId: "c", clientName: "Claude" },
        tokenPrefix: null,
        createdAt: at,
      }),
    ).toEqual({
      client: "Claude",
      since: { verb: "connected", at },
      signsIn: "signs in with OAuth",
    });
  });

  it("says Not recorded and created for a static-token agent", () => {
    expect(agentHeaderFacts({ connectedVia: null, tokenPrefix: "grft_ab", createdAt: at })).toEqual(
      { client: "Not recorded", since: { verb: "created", at }, signsIn: "signs in with a token" },
    );
  });

  it("says an agent awaiting its software is not signed in yet", () => {
    expect(agentHeaderFacts({ connectedVia: null, tokenPrefix: null, createdAt: at }).signsIn).toBe(
      "not signed in yet",
    );
  });

  it("names both ways in for an agent with a token and a client", () => {
    expect(
      agentHeaderFacts({
        connectedVia: { clientId: "c", clientName: "Claude" },
        tokenPrefix: "grft_ab",
        createdAt: at,
      }).signsIn,
    ).toBe("signs in with OAuth or a token");
  });
});

describe("agentRequestCount", () => {
  it("counts this agent's open asks alone", () => {
    expect(agentRequestCount([{ agentId: "a" }, { agentId: "b" }, { agentId: "a" }], "a")).toBe(2);
  });
});

describe("agentIntegrationsStat", () => {
  const integrations = [
    { displayName: "Gmail", connections: [{ id: "c1" }] },
    { displayName: "Google Drive", connections: [{ id: "c2" }, { id: "c3" }] },
    { displayName: "HubSpot", connections: [{ id: "c4" }] },
  ];

  const active = { revokedAt: null };

  it("counts the integrations with a connection in scope, of all the person's", () => {
    const stat = agentIntegrationsStat(active, ["c1", "c3"], integrations);
    expect(stat).toEqual({ usable: 2, total: 3, names: ["Gmail", "Google Drive"], revoked: false });
    expect(integrationsStatValue(stat)).toBe("2 of 3");
    expect(integrationsStatDetail(stat)).toBe("Gmail, Google Drive");
  });

  it("words the empty cases", () => {
    expect(integrationsStatDetail(agentIntegrationsStat(active, [], []))).toBe(
      "No integrations connected yet",
    );
    expect(integrationsStatDetail(agentIntegrationsStat(active, [], integrations))).toBe(
      "None of yours yet",
    );
  });

  it("gives a revoked agent none, whatever its scope still resolves to", () => {
    const stat = agentIntegrationsStat({ revokedAt: at }, ["c1", "c3"], integrations);
    expect(integrationsStatValue(stat)).toBe("0 of 3");
    expect(integrationsStatDetail(stat)).toBe("None, since it was revoked");
  });
});

describe("runsSplitLine", () => {
  it("splits the week's runs by asked and not asked", () => {
    expect(runsSplitLine({ runs: 86, ranWithoutAsking: 84, approved: 2 })).toBe(
      "84 ran without asking · 2 approved",
    );
  });

  it("says nothing ran rather than two zeroes", () => {
    expect(runsSplitLine({ runs: 0, ranWithoutAsking: 0, approved: 0 })).toBe(
      "Nothing ran in the last 7 days",
    );
  });
});

describe("lastActiveDetail", () => {
  it("names the last run's tool, or that none ran", () => {
    expect(
      lastActiveDetail({
        lastRun: {
          at,
          outcome: "ok",
          tool: { id: "t", wireName: "gmail__summarise_unread_email", description: null },
        },
      }),
    ).toBe("Summarise unread email");
    expect(lastActiveDetail({ lastRun: null })).toBe("No tool has run yet");
  });
});

describe("integrationNameOf", () => {
  const integrations = [{ vendor: "gmail", displayName: "Gmail" }];
  it("reads the person's name for the vendor, the slug otherwise, null for none", () => {
    expect(integrationNameOf("gmail", integrations)).toBe("Gmail");
    expect(integrationNameOf("hubspot", integrations)).toBe("hubspot");
    expect(integrationNameOf(null, integrations)).toBeNull();
  });
});

const base = {
  key: "run:1",
  at,
  agent: { id: "a", name: "Claude" },
  vendor: "gmail",
  connectionId: "c1",
};

function run(over: Partial<Extract<ActivityRow, { kind: "run" }>>): ActivityRow {
  return {
    ...base,
    kind: "run",
    id: "r1",
    tool: { id: "t", wireName: "gmail__find_invoices", description: null },
    outcome: "ok",
    reason: null,
    asked: false,
    latencyMs: 120,
    dryRun: false,
    ...over,
  };
}

function approval(over: Partial<Extract<ActivityRow, { kind: "approval" }>>): ActivityRow {
  return {
    ...base,
    kind: "approval",
    source: "tool",
    pendingActionId: null,
    tool: { id: "t", wireName: "hubspot__update_deal", description: null },
    decision: "allow",
    includesDestructive: null,
    askKind: null,
    answer: null,
    ...over,
  };
}

describe("activityRowView", () => {
  it("reads a run that went through without an ask, and one approved", () => {
    expect(activityRowView(run({}), "Gmail")).toEqual({
      icon: "ran",
      title: "Ran Find invoices",
      integration: "Gmail",
      sentence: "ran without asking",
    });
    expect(activityRowView(run({ asked: true }), "Gmail").sentence).toBe("you approved it");
    expect(activityRowView(run({ asked: null }), "Gmail").sentence).toBeNull();
  });

  it("reads a failed run", () => {
    expect(activityRowView(run({ outcome: "error", reason: "threw" }), "Gmail")).toMatchObject({
      icon: "failed",
      title: "Find invoices failed",
    });
  });

  it("reads a call waiting on the person as an ask", () => {
    expect(
      activityRowView(
        run({
          outcome: "refused",
          reason: "awaiting_approval",
          asked: true,
          tool: { id: "t", wireName: "google_drive__share_files", description: null },
        }),
        "Google Drive",
      ),
    ).toEqual({
      icon: "asked",
      title: "Asked to share files",
      integration: "Google Drive",
      sentence: "waiting for you",
    });
  });

  it("reads a refusal with its reason's sentence, and an unknown one generically", () => {
    expect(
      activityRowView(run({ outcome: "refused", reason: "tool_denied", asked: false }), "Gmail"),
    ).toMatchObject({
      icon: "blocked",
      title: "Blocked from Find invoices",
      sentence: "you denied it",
    });
    expect(activityRowView(run({ outcome: "refused", reason: null }), "Gmail").sentence).toBe(
      "Graft stopped it before it ran",
    );
  });

  it("reads a tool's standing answer both ways", () => {
    expect(activityRowView(approval({}), "HubSpot")).toMatchObject({
      icon: "allowed",
      title: "Allowed Update deal",
    });
    expect(activityRowView(approval({ decision: "deny" }), "HubSpot")).toMatchObject({
      icon: "denied",
      title: "Said no to Update deal",
      sentence: "you denied it",
    });
  });

  it("reads an integration's standing approval", () => {
    expect(
      activityRowView(
        approval({ source: "vendor", tool: null, decision: null, includesDestructive: true }),
        "HubSpot",
      ),
    ).toEqual({
      icon: "allowed",
      title: "Allowed every HubSpot tool",
      integration: "HubSpot",
      sentence: "including ones that delete",
    });
  });

  it("reads an answered ask by its kind, declined or not", () => {
    const ask = (askKind: string, allow: boolean) =>
      activityRowView(
        approval({ source: "ask", tool: null, decision: null, askKind, answer: { allow } }),
        "Gmail",
      ).title;
    expect(ask("connection", true)).toBe("Connected Gmail");
    expect(ask("connection", false)).toBe("Said no to connecting Gmail");
    expect(ask("build", true)).toBe("Allowed building tools for Gmail");
    expect(ask("scope", false)).toBe("Said no to giving it Gmail");
    expect(ask("credential", true)).toBe("Answered a request");
  });
});

describe("agentActivityHref", () => {
  it("opens the Activity screen filtered by the agent", () => {
    expect(agentActivityHref("agent 1")).toBe("/activity?agent=agent+1");
  });
});
