import { describe, expect, it } from "vitest";

import { proposalDocsLabel, proposalSourceBadge } from "./proposal-source";

describe("a connection proposal's source (GRA-273)", () => {
  it("names the agent that asked, and nothing about its model", () => {
    expect(proposalSourceBadge("Claude")).toBe("requested by Claude");
    expect(proposalSourceBadge(null)).toBe("requested by a revoked agent");
    expect(proposalSourceBadge("Claude")).not.toContain("model");
  });

  it("labels the documentation link by who named it", () => {
    expect(proposalDocsLabel("agent")).toBe("The documentation the agent named");
    expect(proposalDocsLabel("setup")).toBe("The integration's documentation");
  });
});
