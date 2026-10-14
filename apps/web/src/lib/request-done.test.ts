import { describe, expect, it } from "vitest";

import {
  changeDialogTitle,
  type DoneRequest,
  doneRowCopy,
  doneRowWhen,
  standingBuild,
  standingTool,
  standingToolSentence,
  standingVendor,
} from "./request-done";

const NOW = new Date("2026-10-14T12:00:00.000Z");

function card(
  kind: string,
  payload: Record<string, unknown>,
  finish: Partial<DoneRequest> = {},
): DoneRequest {
  return {
    id: "pa_1",
    agentId: "agt_1",
    agent: { id: "agt_1", name: "Codex" },
    kind,
    payload,
    expiresAt: "2026-10-14T10:00:00.000Z",
    createdAt: "2026-10-14T09:00:00.000Z",
    answeredAt: "2026-10-14T09:30:00.000Z",
    answer: { allow: true },
    consumedAt: "2026-10-14T09:30:00.000Z",
    state: "answered",
    closedReason: null,
    finishedAt: "2026-10-14T09:30:00.000Z",
    subject: { toolId: null, vendor: null, connectionId: null },
    ...finish,
  };
}

const tool = (overrides: Record<string, unknown> = {}) => ({
  toolId: "tool_1",
  toolName: "gmail__send_email",
  vendor: "gmail",
  description: "Sends an email.",
  annotations: { readOnlyHint: false, destructiveHint: false },
  connectionId: "con_1",
  connectionName: "Gmail",
  integrationName: "Gmail",
  hosts: ["gmail.googleapis.com"],
  note: "",
  askEveryCall: false,
  ...overrides,
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  provider: "keyring",
  providerConnect: "form",
  vendor: "notion",
  displayName: "Notion",
  scheme: "bearer",
  schemeConfig: {},
  primaryHost: "https://api.notion.com",
  hosts: ["api.notion.com"],
  docsUrl: null,
  note: "",
  ...overrides,
});

const build = { connectionId: "con_1", vendor: "gmail", connectionName: "Gmail", hosts: [] };

describe("doneRowCopy: tool asks", () => {
  it("says an allow holds, and offers the tool's and the integration's answers", () => {
    const copy = doneRowCopy(card("tool", tool()), true);
    expect(copy.title).toBe("Codex can always send email in Gmail");
    expect(copy.detail).toBeNull();
    expect(copy.change).toEqual({
      tool: { toolId: "tool_1", label: "Send email", destructive: false },
      vendor: { slug: "gmail", integrationName: "Gmail" },
      buildConnectionId: null,
    });
  });

  it("says a deny", () => {
    const copy = doneRowCopy(
      card("tool", tool({ toolName: "hubspot__delete_contacts" }), { answer: { allow: false } }),
      true,
    );
    expect(copy.title).toBe("Codex can't delete contacts in Gmail");
    expect(copy.detail).toBe("You denied it");
    expect(copy.change).not.toBeNull();
  });

  it("says an allow for every tool of the integration, with or without destructive ones", () => {
    const every = doneRowCopy(
      card("tool", tool(), { answer: { allow: true, allowVendor: true } }),
      true,
    );
    expect(every.title).toBe("Codex can use every Gmail tool");
    expect(every.detail).toBe("Except ones that delete");
    const all = doneRowCopy(
      card("tool", tool(), {
        answer: { allow: true, allowVendor: true, includesDestructive: true },
      }),
      true,
    );
    expect(all.detail).toBe("Including ones that delete");
  });

  it("says a yes that asks every time, and never 'Allowed once'", () => {
    const copy = doneRowCopy(
      card("tool", tool(), { answer: { allow: true, askEveryCall: true } }),
      true,
    );
    expect(copy.title).toBe("Codex can send email in Gmail when you say yes");
    expect(copy.detail).toBe("Asks you every time");
    expect(JSON.stringify(copy)).not.toMatch(/once/i);
  });

  it("offers no Change for a read tool or a revoked agent", () => {
    const read = tool({ annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(doneRowCopy(card("tool", read), true).change).toBeNull();
    expect(doneRowCopy(card("tool", tool()), false).change).toBeNull();
  });
});

describe("doneRowCopy: build, scope and connection asks", () => {
  it("says a build approval and offers its withdrawal", () => {
    const copy = doneRowCopy(card("build", build), true);
    expect(copy.title).toBe("Codex can build its own Gmail tools");
    expect(copy.change).toEqual({ tool: null, vendor: null, buildConnectionId: "con_1" });
  });

  it("says a declined build with nothing to change", () => {
    const copy = doneRowCopy(card("build", build, { answer: { allow: false } }), true);
    expect(copy.title).toBe("Codex can't build its own Gmail tools");
    expect(copy.detail).toBe("You declined it");
    expect(copy.change).toBeNull();
  });

  it("says a scope allowed, with Change only where it granted the build too", () => {
    const scope = {
      connectionId: "con_2",
      vendor: "google_drive",
      displayName: "Google Drive",
      hosts: ["www.googleapis.com"],
    };
    expect(doneRowCopy(card("scope", scope), true)).toMatchObject({
      title: "Codex can use Google Drive",
      change: null,
    });
    expect(
      doneRowCopy(card("scope", scope, { answer: { allow: true, approveBuild: true } }), true)
        .change,
    ).toEqual({ tool: null, vendor: null, buildConnectionId: "con_2" });
  });

  it("says a connection made, and what its confirmation granted", () => {
    const plain = doneRowCopy(
      card("connection", proposal(), {
        answer: { connectionId: "con_9" },
        subject: { toolId: null, vendor: "notion", connectionId: "con_9" },
      }),
      true,
    );
    expect(plain).toMatchObject({ title: "Connected Notion", detail: "For Codex", change: null });
    const granted = doneRowCopy(
      card("connection", proposal(), {
        answer: { connectionId: "con_9", approveBuild: true, allowVendor: true },
        subject: { toolId: null, vendor: "notion", connectionId: "con_9" },
      }),
      true,
    );
    expect(granted.change).toEqual({
      tool: null,
      vendor: { slug: "notion", integrationName: "Notion" },
      buildConnectionId: "con_9",
    });
  });

  it("says a declined connection", () => {
    expect(
      doneRowCopy(card("connection", proposal(), { answer: { allow: false } }), true).title,
    ).toBe("You declined Codex's request to connect Notion");
  });
});

describe("doneRowCopy: unanswered asks", () => {
  it("says an expiry, and that the agent asks again", () => {
    const copy = doneRowCopy(
      card("connection", proposal(), {
        agent: { id: "agt_1", name: "Hermes" },
        answeredAt: null,
        answer: null,
        state: "expired",
      }),
      true,
    );
    expect(copy.title).toBe("Hermes's request to connect Notion expired");
    expect(copy.detail).toBe("Hermes will ask again if it still needs it");
    expect(copy.change).toBeNull();
  });

  it("says which revoke closed an ask", () => {
    const closed = (closedReason: "agent_revoked" | "connection_revoked") =>
      doneRowCopy(
        card("tool", tool({ vendor: "notion", integrationName: "Notion" }), {
          answeredAt: null,
          answer: null,
          state: "closed",
          closedReason,
        }),
        true,
      );
    expect(closed("agent_revoked").detail).toBe("Closed when you revoked Codex");
    expect(closed("connection_revoked").detail).toBe("Closed when you revoked Notion");
    expect(closed("agent_revoked").title).toBe("Codex's request to send email in Notion");
    expect(closed("agent_revoked").change).toBeNull();
  });
});

describe("doneRowWhen", () => {
  it("is when the ask finished, opening the line in sentence case", () => {
    expect(doneRowWhen({ finishedAt: "2026-10-14T09:00:00.000Z" }, false, NOW)).toEqual({
      iso: "2026-10-14T09:00:00.000Z",
      label: "3 hours ago",
    });
    expect(doneRowWhen({ finishedAt: "2026-10-13T09:00:00.000Z" }, true, NOW)?.label).toBe(
      "Yesterday",
    );
    expect(doneRowWhen({ finishedAt: "nope" }, true, NOW)).toBeNull();
  });
});

describe("what stands now", () => {
  it("reads the tool's, the integration's and the build approval off their reads", () => {
    expect(
      standingTool([{ toolId: "tool_1", decision: "deny", askEveryCall: false }], "tool_1"),
    ).toEqual({ decision: "deny", askEveryCall: false });
    expect(standingTool([], "tool_1")).toBeNull();
    expect(standingVendor([{ vendor: "gmail", includesDestructive: true }], "gmail")).toEqual({
      includesDestructive: true,
    });
    expect(standingVendor([], "gmail")).toBeNull();
    expect(standingBuild([{ connectionId: "con_1" }], "con_1")).toBe(true);
    expect(standingBuild([], "con_1")).toBe(false);
  });

  it("says how the tool runs, its own answer winning over the integration's", () => {
    const vendor = { includesDestructive: false };
    expect(standingToolSentence({ decision: "deny", askEveryCall: false }, vendor, false)).toMatch(
      /^Denied/,
    );
    expect(standingToolSentence({ decision: "allow", askEveryCall: true }, null, false)).toBe(
      "Asks you before every call.",
    );
    expect(standingToolSentence(null, vendor, false)).toMatch(/integration's approval/);
    expect(standingToolSentence(null, vendor, true)).toMatch(/^No answer stands/);
  });

  it("titles the dialog by what stands, not the row's past", () => {
    expect(changeDialogTitle("Codex", "Gmail")).toBe("What Codex can do in Gmail");
    expect(changeDialogTitle("Codex", null)).toBe("What Codex can do");
  });
});
