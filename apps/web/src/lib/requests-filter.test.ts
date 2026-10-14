import { describe, expect, it } from "vitest";

import {
  agentFilterOptions,
  filterAgentId,
  filterByAgent,
  readRequestsSearch,
  selectedAgent,
} from "./requests-filter";

const agents = [
  { id: "agt_1", name: "Codex", revokedAt: null, connectedVia: { clientName: "Codex" } },
  { id: "agt_2", name: "Hermes", revokedAt: null, connectedVia: null },
  { id: "agt_3", name: "Old", revokedAt: "2026-10-01T00:00:00.000Z", connectedVia: null },
];
const open = [{ agentId: "agt_1" }, { agentId: "agt_1" }, { agentId: "agt_3" }];

describe("readRequestsSearch", () => {
  it("keeps done and a non-empty agent, and drops the rest", () => {
    expect(readRequestsSearch({ tab: "done", agent: "agt_1" })).toEqual({
      tab: "done",
      agent: "agt_1",
    });
    expect(readRequestsSearch({ tab: "open", agent: "" })).toEqual({});
    expect(readRequestsSearch({ tab: 3, agent: 4 })).toEqual({});
  });
});

describe("agentFilterOptions", () => {
  it("offers the active agents alone, each with its open count", () => {
    expect(agentFilterOptions(agents, open)).toEqual([
      { id: "agt_1", name: "Codex", clientName: "Codex", count: 2 },
      { id: "agt_2", name: "Hermes", clientName: null, count: 0 },
    ]);
  });
});

describe("selectedAgent and filterAgentId", () => {
  const options = agentFilterOptions(agents, open);

  it("selects an active agent the search names", () => {
    expect(selectedAgent("agt_2", options)?.name).toBe("Hermes");
    expect(filterAgentId("agt_2", options)).toBe("agt_2");
  });

  it("reads a revoked or unknown agent as every agent", () => {
    expect(selectedAgent("agt_3", options)).toBeNull();
    expect(filterAgentId("agt_3", options)).toBeNull();
    expect(filterAgentId("agt_9", options)).toBeNull();
    expect(filterAgentId(undefined, options)).toBeNull();
  });

  it("filters by the search's id until the agents read lands", () => {
    expect(filterAgentId("agt_3", undefined)).toBe("agt_3");
    expect(filterAgentId(undefined, undefined)).toBeNull();
  });
});

describe("filterByAgent", () => {
  it("keeps one agent's rows, or every row", () => {
    expect(filterByAgent(open, "agt_1")).toHaveLength(2);
    expect(filterByAgent(open, null)).toHaveLength(3);
  });
});
