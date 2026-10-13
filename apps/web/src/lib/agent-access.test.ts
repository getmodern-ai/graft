import { describe, expect, it } from "vitest";

import { type AgentAccess, agentAccessSummary, toolTitle } from "./agent-access";

const AT = "2026-10-14T10:00:00.000Z";

function access(over: Partial<AgentAccess> = {}): AgentAccess {
  return {
    agent: { id: "agent_1", name: "Codex", scopeMode: "all", connectedViaClientName: "Codex" },
    inScope: true,
    lastUsedAt: AT,
    toolApprovals: [],
    vendorApproval: null,
    buildApproval: null,
    ...over,
  };
}

type Approval = AgentAccess["toolApprovals"][number];

function approval(
  name: string,
  over: Partial<Omit<Approval, "tool">> & { readOnly?: boolean; destructive?: boolean } = {},
): Approval {
  const { readOnly = false, destructive = false, ...rest } = over;
  return {
    tool: {
      id: `tool_${name}`,
      vendor: "gmail",
      name,
      description: name,
      readOnly,
      destructive,
      currentVersionId: "ver_2",
    },
    decision: "allow",
    askEveryCall: false,
    toolVersionId: "ver_2",
    forCurrentVersion: true,
    decidedAt: AT,
    ...rest,
  };
}

describe("toolTitle", () => {
  it("reads a kebab-case name as sentence-case words", () => {
    expect(toolTitle("draft-a-reply")).toBe("Draft a reply");
    expect(toolTitle("send")).toBe("Send");
  });
});

describe("agentAccessSummary", () => {
  it("says an agent without the connection in scope has no access, and how to give it", () => {
    expect(
      agentAccessSummary(
        access({
          agent: { id: "a", name: "Hermes", scopeMode: "listed", connectedViaClientName: null },
          inScope: false,
          vendorApproval: { includesDestructive: true, grantedAt: AT },
        }),
        "Gmail",
      ),
    ).toEqual({ summary: "No access", detail: "Turn on to let Hermes use Gmail" });
  });

  it("says every tool but ones that delete under the standing approval, and the build approval under it", () => {
    expect(
      agentAccessSummary(
        access({
          vendorApproval: { includesDestructive: false, grantedAt: AT },
          buildApproval: { grantedAt: AT },
          toolApprovals: [approval("delete-email", { decision: "deny", destructive: true })],
        }),
        "Gmail",
      ),
    ).toEqual({
      summary: "Every Gmail tool, except ones that delete",
      detail: "Can also build its own Gmail tools",
    });
  });

  it("says every tool when the standing approval includes ones that delete", () => {
    expect(
      agentAccessSummary(
        access({ vendorApproval: { includesDestructive: true, grantedAt: AT } }),
        "Gmail",
      ),
    ).toEqual({ summary: "Every Gmail tool", detail: null });
    expect(
      agentAccessSummary(
        access({ vendorApproval: { includesDestructive: false, grantedAt: AT } }),
        "Gmail",
      ),
    ).toEqual({
      summary: "Every Gmail tool, except ones that delete",
      detail: "Ones that delete ask first",
    });
  });

  it("names the tools allowed beside reads, and one that asks every time under them", () => {
    expect(
      agentAccessSummary(
        access({
          toolApprovals: [
            approval("draft-a-reply"),
            approval("send-email", { askEveryCall: true }),
          ],
        }),
        "Gmail",
      ),
    ).toEqual({ summary: "Reads, plus Draft a reply", detail: "Send email asks every time" });
  });

  it("puts asking every time before the build approval, and counts past two tools", () => {
    expect(
      agentAccessSummary(
        access({
          buildApproval: { grantedAt: AT },
          toolApprovals: [
            approval("draft-a-reply"),
            approval("archive-email"),
            approval("label-email"),
            approval("send-email", { askEveryCall: true }),
            approval("forward-email", { askEveryCall: true }),
          ],
        }),
        "Gmail",
      ),
    ).toEqual({
      summary: "Reads, plus Draft a reply and 2 more",
      detail: "Send email and Forward email ask every time",
    });
  });

  it("reads only when no answer lets a write through", () => {
    expect(
      agentAccessSummary(
        access({
          toolApprovals: [
            // Given for an older version, so the tool asks again (GRA-245).
            approval("send-email", { forCurrentVersion: false, toolVersionId: "ver_1" }),
            approval("delete-email", { decision: "deny", destructive: true }),
            // A read never asks; its answer says nothing here.
            approval("list-emails", { readOnly: true }),
          ],
        }),
        "Gmail",
      ),
    ).toEqual({ summary: "Reads only", detail: "Anything that changes data asks first" });
  });

  it("says anything else asks first beside allowed tools with nothing more to say", () => {
    expect(
      agentAccessSummary(access({ toolApprovals: [approval("draft-a-reply")] }), "Gmail"),
    ).toEqual({
      summary: "Reads, plus Draft a reply",
      detail: "Anything else that changes data asks first",
    });
  });

  it("never calls the integration an app", () => {
    const lines = [
      agentAccessSummary(access({ inScope: false }), "Gmail"),
      agentAccessSummary(access({ buildApproval: { grantedAt: AT } }), "Gmail"),
    ].flatMap((line) => [line.summary, line.detail ?? ""]);
    for (const line of lines) expect(line).not.toMatch(/\bapps?\b/i);
  });
});
