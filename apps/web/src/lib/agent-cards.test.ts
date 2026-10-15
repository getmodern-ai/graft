import { describe, expect, it } from "vitest";

import {
  agentCanUse,
  agentClientLine,
  agentMark,
  connectAgentTarget,
  groupAgents,
  requestCounts,
  requestsLabel,
  toolsReadyLabel,
} from "./agent-cards";
import type { AgentListItem } from "./agent-queries";
import type { Connection } from "./connection-queries";
import type { SetupStateData } from "./setup-queries";

const at = "2026-10-14T00:00:00Z";

const agent: AgentListItem = {
  id: "agent_1",
  name: "Claude",
  tokenPrefix: null,
  connectedVia: { clientId: "client_1", clientName: "Claude" },
  scopeMode: "all",
  workingSetCap: 20,
  idleWindowDays: 21,
  revokedAt: null,
  createdAt: at,
  updatedAt: at,
  workingSetCount: 4,
  connectionIds: [],
  lastActiveAt: null,
};

const awaiting: AgentListItem = { ...agent, id: "agent_2", name: "Hermes", connectedVia: null };

function connection(id: string, vendor: string, revokedAt: string | null = null): Connection {
  return {
    id,
    provider: "keyring",
    vendor,
    displayName: vendor,
    scheme: "none",
    schemeConfig: {},
    primaryHost: `https://api.${vendor}.com`,
    hosts: [`api.${vendor}.com`],
    credentialSetAt: null,
    oauth: null,
    providerReleaseFailedAt: null,
    account: null,
    revokedAt,
    createdAt: at,
    updatedAt: at,
  };
}

function setupState(overrides: Partial<NonNullable<SetupStateData["setup"]>> = {}) {
  return {
    agent: { ...awaiting },
    setup: {
      step: "vendor",
      harness: "hermes",
      agentId: awaiting.id,
      starterId: null,
      goal: null,
      stockTool: null,
      pendingActionId: null,
      connectionId: null,
      acquireJobId: null,
      toolId: null,
      startedAt: at,
      completedAt: null,
      skippedAt: null,
      ...overrides,
    },
  } as Pick<SetupStateData, "setup" | "agent">;
}

describe("groupAgents", () => {
  it("puts revoked agents after the active ones, keeping the order within each", () => {
    const revoked = { ...agent, id: "agent_3", revokedAt: at };
    expect(groupAgents([revoked, agent, awaiting])).toEqual({
      active: [agent, awaiting],
      revoked: [revoked],
    });
  });
});

describe("agentCanUse", () => {
  const connections = [
    connection("c1", "gmail"),
    connection("c2", "gmail"),
    connection("c3", "hubspot", at),
    connection("c4", "slack"),
    connection("c5", "notion"),
    connection("c6", "github"),
    connection("c7", "linear"),
  ];

  it("joins the scope to live connections, one mark per integration, and counts the rest", () => {
    const result = agentCanUse(
      { connectionIds: ["c1", "c2", "c3", "c4", "c5", "c6"] },
      connections,
    );
    expect(result.shown.map((value) => value.vendor)).toEqual(["gmail", "slack", "notion"]);
    expect(result.more).toBe(1);
  });

  it("leaves out revoked connections and those outside the scope", () => {
    expect(agentCanUse({ connectionIds: ["c3"] }, connections)).toEqual({ shown: [], more: 0 });
    expect(agentCanUse({ connectionIds: [] }, connections)).toEqual({ shown: [], more: 0 });
  });
});

describe("requestCounts", () => {
  it("counts the open asks per agent", () => {
    const counts = requestCounts([
      { agentId: "agent_1" },
      { agentId: "agent_1" },
      { agentId: "agent_2" },
    ]);
    expect(counts.get("agent_1")).toBe(2);
    expect(counts.get("agent_2")).toBe(1);
    expect(counts.get("agent_3")).toBeUndefined();
  });

  it("says requests and tools ready in the person's words", () => {
    expect(requestsLabel(1)).toBe("1 request");
    expect(requestsLabel(3)).toBe("3 requests");
    expect(toolsReadyLabel(1)).toBe("1 tool ready");
    expect(toolsReadyLabel(0)).toBe("0 tools ready");
  });
});

describe("agentClientLine", () => {
  it("names the consenting client, or says nothing was recorded, and never a device", () => {
    expect(agentClientLine(agent)).toBe("Signs in through Claude");
    expect(agentClientLine({ connectedVia: null })).toBe("Not recorded");
  });
});

describe("agentMark", () => {
  it("reads the client first, then the harness Setup minted the agent for", () => {
    expect(agentMark(agent, undefined)).toBe("claude");
    expect(agentMark(awaiting, setupState())).toBe("hermes");
    expect(agentMark(awaiting, setupState({ harness: "other" }))).toBe("generic");
    expect(agentMark({ ...awaiting, id: "agent_9" }, setupState())).toBe("generic");
    expect(agentMark(awaiting, undefined)).toBe("generic");
  });
});

describe("connectAgentTarget", () => {
  it("sends the agent a running Setup runs as back to Setup", () => {
    expect(connectAgentTarget(awaiting, setupState())).toBe("setup");
  });

  it("never sends a person who skipped Setup back into it (GRA-347)", () => {
    expect(connectAgentTarget(awaiting, setupState({ skippedAt: at }))).toBe("dialog");
    expect(connectAgentTarget(awaiting, setupState({ skippedAt: at, starterId: "gmail" }))).toBe(
      "dialog",
    );
  });

  it("opens Connect an agent for any other agent awaiting its harness", () => {
    expect(connectAgentTarget(awaiting, setupState({ completedAt: at }))).toBe("dialog");
    expect(connectAgentTarget({ ...awaiting, id: "agent_9" }, setupState())).toBe("dialog");
    expect(connectAgentTarget(awaiting, undefined)).toBe("dialog");
  });

  it("offers nothing to a connected, token-holding or revoked agent", () => {
    expect(connectAgentTarget(agent, setupState())).toBeNull();
    expect(connectAgentTarget({ ...awaiting, tokenPrefix: "grft_abc" }, undefined)).toBeNull();
    expect(connectAgentTarget({ ...awaiting, revokedAt: at }, setupState())).toBeNull();
  });
});
