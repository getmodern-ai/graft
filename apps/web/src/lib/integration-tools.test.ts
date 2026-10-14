import { describe, expect, it } from "vitest";

import type { ConnectionAccessView } from "./connection-queries";
import type { IntegrationToolRow } from "./integration-queries";
import {
  agentsWithAccess,
  openToolAsksByTool,
  splitIntegrationTools,
  type ToolAccessAgent,
  toolApprovalSummary,
  toolStatusLine,
} from "./integration-tools";
import type { PendingAction } from "./pending-action-queries";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function tool(overrides: Partial<IntegrationToolRow> = {}): IntegrationToolRow {
  return {
    source: "toolbox",
    toolId: "tool_send",
    name: "send-email",
    tool: "gmail__send-email",
    description: "Sends an email.",
    annotations: { readOnly: false, destructive: false },
    inputSchema: {},
    lastRun: null,
    ...overrides,
  };
}

function agent(
  name: string,
  overrides: Partial<ToolAccessAgent> = {},
  inScope = true,
): ToolAccessAgent {
  return {
    agent: { id: `agent_${name}`, name, scopeMode: "all", connectedViaClientName: null },
    inScope,
    lastUsedAt: null,
    toolApprovals: [],
    vendorApproval: null,
    buildApproval: null,
    ...overrides,
  };
}

function answer(
  decision: "allow" | "deny",
  overrides: Partial<ToolAccessAgent["toolApprovals"][number]> = {},
): ToolAccessAgent["toolApprovals"][number] {
  return {
    tool: {
      id: "tool_send",
      vendor: "gmail",
      name: "send-email",
      description: "Sends an email.",
      readOnly: false,
      destructive: false,
      currentVersionId: "v2",
    },
    decision,
    askEveryCall: false,
    toolVersionId: "v2",
    forCurrentVersion: true,
    decidedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

function toolAsk(toolId: string, createdAt: string, overrides: Partial<PendingAction> = {}) {
  return {
    id: `pa_${toolId}_${createdAt}`,
    kind: "tool",
    payload: { toolId },
    createdAt,
    expiresAt: "2026-10-15T00:00:00.000Z",
    answeredAt: null,
    ...overrides,
  } as unknown as PendingAction;
}

describe("splitIntegrationTools", () => {
  it("puts the person's tools first and keeps stock behind Show more", () => {
    const stock = tool({ source: "stock", toolId: null, name: "list-labels" });
    const own = tool();
    expect(splitIntegrationTools([stock, own])).toEqual({ toolbox: [own], stock: [stock] });
  });
});

describe("openToolAsksByTool", () => {
  it("keeps the newest open tool ask per tool and drops answered, expired and other kinds", () => {
    const asks = openToolAsksByTool(
      [
        toolAsk("tool_send", "2026-10-14T11:50:00.000Z"),
        toolAsk("tool_send", "2026-10-14T11:58:00.000Z"),
        toolAsk("tool_draft", "2026-10-14T11:00:00.000Z", {
          answeredAt: "2026-10-14T11:01:00.000Z",
        }),
        toolAsk("tool_old", "2026-10-13T11:00:00.000Z", { expiresAt: "2026-10-14T00:00:00.000Z" }),
        toolAsk("tool_build", "2026-10-14T11:00:00.000Z", { kind: "build" }),
      ],
      NOW,
    );
    expect([...asks]).toEqual([["tool_send", "2026-10-14T11:58:00.000Z"]]);
  });
});

describe("toolStatusLine", () => {
  const context = { openAsks: new Map<string, string>(), toolbox: [], now: NOW };

  it("says an open ask waits for the person before anything else", () => {
    const line = toolStatusLine(
      tool({
        lastRun: {
          at: "2026-10-14T11:00:00.000Z",
          outcome: "ok",
          agent: { id: "a", name: "Codex" },
        },
      }),
      { ...context, openAsks: new Map([["tool_send", "2026-10-14T11:58:00.000Z"]]) },
    );
    expect(line).toEqual({ kind: "waiting", text: "Waiting for you · 2 minutes ago" });
  });

  it("names the agent of the last run, and a failed one as failed", () => {
    const at = "2026-10-14T11:58:00.000Z";
    const agentOf = { id: "a", name: "Codex" };
    expect(
      toolStatusLine(tool({ lastRun: { at, outcome: "ok", agent: agentOf } }), context),
    ).toEqual({ kind: "ran", text: "Ran 2 minutes ago by Codex" });
    expect(
      toolStatusLine(tool({ lastRun: { at, outcome: "error", agent: agentOf } }), context).text,
    ).toBe("Failed 2 minutes ago for Codex");
  });

  it("says where a tool that never ran came from", () => {
    expect(toolStatusLine(tool({ source: "stock", toolId: null }), context).text).toBe(
      "Ready-made",
    );
    const versions = [
      {
        id: "v1",
        versionNumber: 1,
        current: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        origin: "stock" as const,
        stockVersionNumber: 1,
      },
      {
        id: "v2",
        versionNumber: 2,
        current: true,
        createdAt: "2026-10-02T00:00:00.000Z",
        origin: "stock" as const,
        stockVersionNumber: 3,
      },
    ];
    expect(
      toolStatusLine(tool(), { ...context, toolbox: [{ id: "tool_send", versions }] }).text,
    ).toBe("Ready-made v3");
    const remixed = versions.map((version) =>
      version.current
        ? { ...version, origin: "agent" as const, stockVersionNumber: null }
        : version,
    );
    expect(
      toolStatusLine(tool(), { ...context, toolbox: [{ id: "tool_send", versions: remixed }] })
        .text,
    ).toBe("Written by your agent");
  });
});

describe("agentsWithAccess", () => {
  it("takes an agent in when any live connection is in its scope, once", () => {
    const view = (agents: ToolAccessAgent[]) =>
      ({ connectionId: "c", vendor: "gmail", agents }) as ConnectionAccessView;
    const merged = agentsWithAccess([
      view([agent("Codex"), agent("Claude", {}, false), agent("Hermes", {}, false)]),
      view([agent("Codex"), agent("Claude")]),
    ]);
    expect(merged.map((row) => row.agent.name)).toEqual(["Codex", "Claude"]);
  });
});

describe("toolApprovalSummary", () => {
  it("says a read runs without asking and links nowhere", () => {
    const read = tool({ annotations: { readOnly: true, destructive: false } });
    expect(
      toolApprovalSummary(read, [agent("Codex", { toolApprovals: [answer("deny")] })]),
    ).toEqual({ summary: "Runs without asking", detail: null, agentsTab: false });
  });

  it("counts the agents a write passes for, and names who asks first", () => {
    const agents = [
      agent("Codex", { toolApprovals: [answer("allow")] }),
      agent("Claude", { vendorApproval: { includesDestructive: false, grantedAt: "x" } }),
      agent("Hermes"),
      agent("OpenClaw"),
    ];
    expect(toolApprovalSummary(tool(), agents)).toEqual({
      summary: "Allowed for 2 of 4 agents",
      detail: "Asks first for Hermes and OpenClaw",
      agentsTab: true,
    });
  });

  it("names an agent that asks every time, and one denied", () => {
    expect(
      toolApprovalSummary(tool(), [
        agent("Codex", { toolApprovals: [answer("allow", { askEveryCall: true })] }),
      ]),
    ).toEqual({ summary: "Asks every time for Codex", detail: null, agentsTab: true });
    expect(
      toolApprovalSummary(tool(), [
        agent("Codex", { toolApprovals: [answer("deny", { askEveryCall: true })] }),
        agent("Claude", { toolApprovals: [answer("allow")] }),
      ]),
    ).toEqual({
      summary: "Allowed for 1 of 2 agents",
      detail: "Denied for Codex",
      agentsTab: true,
    });
  });

  it("says every agent passes, and names a lone one", () => {
    const allowed = { toolApprovals: [answer("allow")] };
    expect(toolApprovalSummary(tool(), [agent("Codex", allowed)]).summary).toBe(
      "Allowed for Codex",
    );
    expect(
      toolApprovalSummary(tool(), [agent("Codex", allowed), agent("Claude", allowed)]).summary,
    ).toBe("Allowed for all 2 agents");
  });

  it("asks again once for an allow given for another version", () => {
    const stale = agent("Codex", {
      toolApprovals: [answer("allow", { forCurrentVersion: false })],
    });
    expect(toolApprovalSummary(tool(), [stale]).summary).toBe("Asks first");
  });

  it("leaves a destructive tool out of a standing approval that excludes ones that delete", () => {
    const destructive = tool({ annotations: { readOnly: false, destructive: true } });
    const standing = (includesDestructive: boolean) =>
      agent("Codex", { vendorApproval: { includesDestructive, grantedAt: "x" } });
    expect(toolApprovalSummary(destructive, [standing(false)]).summary).toBe("Asks first");
    expect(toolApprovalSummary(destructive, [standing(true)]).summary).toBe("Allowed for Codex");
  });

  it("judges a stock tool not yet copied in by the standing approval alone", () => {
    const stock = tool({ source: "stock", toolId: null });
    const codex = agent("Codex", {
      toolApprovals: [answer("deny")],
      vendorApproval: { includesDestructive: false, grantedAt: "x" },
    });
    expect(toolApprovalSummary(stock, [codex]).summary).toBe("Allowed for Codex");
  });

  it("says when no agent can use the integration", () => {
    expect(toolApprovalSummary(tool(), [])).toEqual({
      summary: "No agent can use it",
      detail: null,
      agentsTab: true,
    });
  });
});
